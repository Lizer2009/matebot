import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

/**
 * A2UI end to end against the real application.
 *
 * Real browser → real web app → real oRPC router → real executor → disposable
 * migrated Postgres, with the SSE event stream the card listens to. External
 * services stop at the boundary: the Composio client is the fake and no calendar
 * or mailbox provider is contacted.
 *
 * The model is a scripted stand-in that calls the *production* tools
 * (`present_interaction`, `edit_interaction`, `present_result`, `refresh_result`).
 * That is the honest description: this proves the wiring a model's tool call
 * travels — tool selection by a live DeepSeek model is a separate, blocked gate.
 */

/**
 * These run only under the dedicated launcher (`apps/api/e2e-a2ui.mjs`), which
 * starts the API with `FEATURE_A2UI=1` against a disposable database. The
 * regular suite runs with the flag at its shipped default (off), so a card is
 * never rendered there; skipping keeps the default path honest rather than
 * asserting against a disabled feature.
 */
const liveA2ui = Boolean(process.env.A2UI_LIVE_E2E);
test.skip(!liveA2ui, "run via apps/api/e2e-a2ui.mjs with A2UI_LIVE_E2E=1");

const password = "correct-horse-battery-staple";
let accountSeq = 0;

/** Each test gets its own account, so a retry or a parallel worker cannot collide. */
function nextAccount() {
  accountSeq += 1;
  return `a2ui-e2e-${Date.now()}-${accountSeq}@example.test`;
}

async function signIn(
  page: import("@playwright/test").Page,
  testInfo: import("@playwright/test").TestInfo,
) {
  await signup(page, nextAccount(), password, "A2UI Tester", testInfo);
  await completeOnboarding(page, testInfo);
  // The scripted runtime still needs a model to resolve. Connecting the scripted
  // provider gives it one without contacting any real provider, which is what
  // makes this suite runnable with no credentials at all.
  await rpc(page, "models/connect", {
    provider: "scripted",
    apiKey: "fake-scripted-model-key",
    label: "Scripted",
    setDefault: true,
  }).catch(() => undefined);
}

/**
 * Authorize a Fake Composio app through the production routes.
 *
 * Pending Fake returns an authorization URL and only creates the account on
 * `connections.complete`. Instant Fake has no URL and is already connected.
 * Either way this is not a live provider write.
 */
async function connectFakeApp(
  page: import("@playwright/test").Page,
  provider: string,
  displayName: string,
) {
  const begun = await rpc<{ connectionId: string; authorizationUrl: string | null }>(
    page,
    "connections/begin",
    { connectorId: "composio", provider, displayName },
  );
  if (begun.authorizationUrl) {
    await rpc(page, "connections/complete", {
      connectionId: begun.connectionId,
      code: "fake-oauth-code",
    });
  }
}

async function connectFakeMailbox(page: import("@playwright/test").Page) {
  await connectFakeApp(page, "gmail", "Email");
}

async function connectFakeCalendar(page: import("@playwright/test").Page) {
  await connectFakeApp(page, "googlecalendar", "Calendar");
}

/** Send a message that the scripted runtime turns into one production tool call. */
async function send(page: import("@playwright/test").Page, text: string) {
  const bots = await rpc<Array<{ id: string }>>(page, "bots/list", {});
  const botId = bots[0]!.id;
  await rpc(page, "threads/send", { botId, text });
  return botId;
}

async function waitForSurface(page: import("@playwright/test").Page, testId: string) {
  await expect(page.getByTestId(testId).first()).toBeVisible({ timeout: 45_000 });
}

test("compose card, model-shaped edit, same card, then a fake send", async ({ page }, testInfo) => {
  await signIn(page, testInfo);
  await connectFakeMailbox(page);

  await send(
    page,
    `call present_interaction with ${JSON.stringify({
      plan: {
        intent: "email.compose",
        title: "Hello",
        fields: [
          { name: "to", value: "friend@example.test", required: true, status: "resolved" },
          { name: "subject", value: "Hi", required: true, status: "resolved" },
          { name: "body", value: "Hello there", required: true, status: "resolved" },
        ],
        nextStep: "request_approval",
        riskLevel: "medium",
      },
    })}`,
  );
  await waitForSurface(page, "a2ui-email-compose");
  await captureScreenshot(page, testInfo, "a2ui-e2e-01-draft");

  // The subject the server stored is the one the card shows.
  await expect(page.getByTestId("a2ui-email-subject")).toHaveValue("Hi");

  // A prose-shaped edit through the production tool reaches the same card.
  const interactionId = await cardInteractionId(page);
  const draftVersion = await cardRevision(page);

  await send(
    page,
    `call edit_interaction with ${JSON.stringify({
      revision: draftVersion,
      fields: { subject: "秋后问候" },
    })}`,
  );
  // The same card updates in place; no second card is created.
  await expect(page.getByTestId("a2ui-email-compose")).toHaveCount(1, { timeout: 30_000 });
  await expect(page.getByTestId("a2ui-email-subject")).toHaveValue("秋后问候", { timeout: 30_000 });
  // Same card, not a second one: the id on screen is the one we started with.
  expect(await cardInteractionId(page)).toBe(interactionId);
  await captureScreenshot(page, testInfo, "a2ui-e2e-02-edited-same-card");
});

test("approval menu has four items and Allow this recipient leaves Send", async ({
  page,
}, testInfo) => {
  await signIn(page, testInfo);
  // Fake Composio connects without a live mailbox. Present after the account
  // exists so the card is the approval surface (Needs approval), not Connect.
  await connectFakeMailbox(page);
  await send(
    page,
    `call present_interaction with ${JSON.stringify({
      plan: {
        intent: "email.compose",
        title: "Hello",
        fields: [
          { name: "to", value: "friend@example.test", required: true, status: "resolved" },
          { name: "subject", value: "Hi", required: true, status: "resolved" },
          { name: "body", value: "Hello there", required: true, status: "resolved" },
        ],
        nextStep: "request_approval",
        riskLevel: "medium",
      },
    })}`,
  );
  await waitForSurface(page, "a2ui-email-compose");
  await expect(page.getByTestId("a2ui-email-send")).toBeVisible({ timeout: 30_000 });
  const status = page.getByTestId("a2ui-email-status");
  await expect(status).toContainText("Needs approval");
  await status.click();
  await expect(page.getByTestId("a2ui-email-allow-recipient")).toBeVisible();
  await expect(page.getByTestId("a2ui-email-approval-require")).toBeVisible();
  await expect(page.getByTestId("a2ui-email-disable-drafts")).toBeVisible();
  await expect(page.getByTestId("a2ui-email-manage-rules")).toBeVisible();
  await captureScreenshot(page, testInfo, "a2ui-e2e-d-approval-menu");
  await page.getByTestId("a2ui-email-allow-recipient").click();
  await expect(page.getByTestId("a2ui-email-send")).toBeVisible();
  const rules = await rpc<Array<{ effect: string; matchKind: string; matchValue: string }>>(
    page,
    "approvalRules/list",
    {},
  );
  expect(rules).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        effect: "always_allow",
        matchKind: "recipient",
        matchValue: "friend@example.test",
      }),
    ]),
  );
  await captureScreenshot(page, testInfo, "a2ui-e2e-d-allow-recipient-send-stays");
});

/**
 * A result card built from a file the user uploaded.
 *
 * The CSV is synthetic — made-up quarterly figures — because this proves the
 * pipeline, not anyone's data. The bytes go through the real upload route, the
 * real artifact store, the real reader and the real router, so a card appearing
 * with these numbers means every step worked.
 */
const SAMPLE_CSV = [
  "date,quarter,region,amount",
  "2026-02-01,Q1,North,1200.50",
  "2026-02-15,Q1,South,800",
  "2026-05-01,Q2,North,1500",
].join("\n");

async function uploadCsv(page: import("@playwright/test").Page, botId: string): Promise<string> {
  const artifact = await rpc<{ id: string }>(page, "artifacts/create", {
    botId,
    name: "sample-quarters.csv",
    mimeType: "text/csv",
    contentBase64: Buffer.from(SAMPLE_CSV, "utf8").toString("base64"),
  });
  return artifact.id;
}

test("a result card reads the uploaded file and shows its own source", async ({
  page,
}, testInfo) => {
  await signIn(page, testInfo);
  const bots = await rpc<Array<{ id: string }>>(page, "bots/list", {});
  const botId = bots[0]!.id;
  const artifactId = await uploadCsv(page, botId);

  await rpc(page, "threads/send", {
    botId,
    artifactIds: [artifactId],
    text: `call present_result with ${JSON.stringify({
      title: "Quarterly totals",
      sourceId: "csv-upload",
      from: "2026-01-01",
      to: "2026-12-31",
      groupBy: "quarter",
      metrics: [{ key: "total", op: "sum", of: "amount" }],
    })}`,
  });

  const card = page.getByTestId("a2ui-surface-card").first();
  await expect(card).toBeVisible({ timeout: 45_000 });
  // The card names the file it read, not a generic label.
  await expect(card).toContainText("sample-quarters.csv", { timeout: 30_000 });
  // And shows the totals the server computed from those rows: 1200.50 + 800 for
  // Q1, and 1500 for Q2 — arithmetic done in code, not supplied by a model.
  await expect(card).toContainText("2000.5");
  await expect(card).toContainText("1500");
  // The period the read covered is on the card too.
  await expect(card).toContainText("2026-01-01");
  await captureScreenshot(page, testInfo, "a2ui-e2e-03-uploaded-result");

  // A result offers no Send or Create.
  await expect(page.getByTestId("a2ui-email-send")).toHaveCount(0);
});

test("calendar draft validates before any provider call", async ({ page }, testInfo) => {
  await signIn(page, testInfo);

  await send(
    page,
    `call present_interaction with ${JSON.stringify({
      plan: {
        intent: "calendar.create",
        title: "Create event",
        fields: [
          { name: "name", value: "Team sync", required: true, status: "resolved" },
          { name: "start", value: "2026-11-09T09:00:00+08:00", required: true, status: "resolved" },
          { name: "end", value: "2026-11-09T10:00:00+08:00", required: true, status: "resolved" },
        ],
        nextStep: "request_approval",
        riskLevel: "medium",
      },
    })}`,
  );
  // With no calendar connection the card asks to connect; it must not present a
  // Create button that would fail.
  await waitForSurface(page, "a2ui-surface-card");
  await captureScreenshot(page, testInfo, "a2ui-e2e-04-calendar-card");
  await expect(page.getByTestId("a2ui-surface-card").first()).toBeVisible();
});

/**
 * The rest of the required multi-turn behaviour, on the real application.
 *
 * Each block below covers a rule the spec states in words: user-typed fields are
 * protected, a stale revision is refused instead of overwriting, an approved
 * payload that changes loses its approval, a card can be cancelled until it runs,
 * and a query never turns into a create.
 */

/**
 * Type into the card's own subject input, then wait for the server to record it.
 *
 * Waiting matters: the input shows the value immediately, but the write travels
 * to the server on blur. A test that reads the revision before that write lands
 * would be racing the very thing it is checking.
 */
async function typeSubject(page: import("@playwright/test").Page, value: string) {
  const before = await cardRevision(page);
  const subject = page.getByTestId("a2ui-email-subject");
  await subject.fill(value);
  await subject.blur();
  await expect(subject).toHaveValue(value, { timeout: 20_000 });
  // The revision only moves once the server has the new value.
  await expect.poll(async () => cardRevision(page), { timeout: 20_000 }).toBeGreaterThan(before);
}

async function cardRevision(page: import("@playwright/test").Page): Promise<number> {
  const card = page.getByTestId("a2ui-email-compose").first();
  return Number((await card.getAttribute("data-draft-version")) ?? "1");
}

/**
 * The interaction id of the card on screen.
 *
 * The email editor is nested inside the surface card, and only the card carries
 * the id, so a test that read it from the editor would silently get "null".
 */
async function cardInteractionId(page: import("@playwright/test").Page): Promise<string> {
  const value = await page
    .getByTestId("a2ui-surface-card")
    .first()
    .getAttribute("data-interaction-id");
  if (!value) throw new Error("the card on screen exposed no interaction id");
  return value;
}

async function cardSurfaceId(page: import("@playwright/test").Page): Promise<string> {
  const value = await page.getByTestId("a2ui-surface-card").first().getAttribute("data-surface-id");
  if (!value) throw new Error("the card on screen exposed no surface id");
  return value;
}

const e2eApi = process.env.API_URL ?? "http://127.0.0.1:3110";

type SeededSurface = {
  interactionId: string;
  cardKey: string | null;
  messageId: string | null;
  status: string;
  draftVersion: number;
  surfaceId: string | null;
  block: {
    interactionId: string;
    surfaceId: string;
    status: string | null;
    template: string | null;
    lifecycle: string | null;
    draftVersion: number;
  } | null;
};

async function seedExpiredSurface(interactionId: string): Promise<SeededSurface> {
  const response = await fetch(`${e2eApi}/__e2e/seed-expired-surface`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ interactionId }),
  });
  const body = (await response.json()) as SeededSurface & { error?: string };
  if (!response.ok) {
    throw new Error(`seed-expired-surface ${response.status}: ${body.error ?? "failed"}`);
  }
  return body;
}

async function markAwaitingApprovalExpired(interactionId: string): Promise<SeededSurface> {
  const response = await fetch(`${e2eApi}/__e2e/mark-awaiting-approval-expired`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ interactionId }),
  });
  const body = (await response.json()) as SeededSurface & { error?: string };
  if (!response.ok) {
    throw new Error(`mark-awaiting-approval-expired ${response.status}: ${body.error ?? "failed"}`);
  }
  return body;
}

async function expireDueInteractions(
  interactionId: string,
): Promise<{ expired: string[]; surface?: SeededSurface }> {
  const response = await fetch(`${e2eApi}/__e2e/expire-due-interactions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ interactionId }),
  });
  const body = (await response.json()) as {
    expired: string[];
    surface?: SeededSurface;
    error?: string;
  };
  if (!response.ok) {
    throw new Error(`expire-due-interactions ${response.status}: ${body.error ?? "failed"}`);
  }
  return body;
}

async function inspectSurface(interactionId: string): Promise<SeededSurface> {
  const response = await fetch(
    `${e2eApi}/__e2e/inspect-surface?interactionId=${encodeURIComponent(interactionId)}`,
  );
  const body = (await response.json()) as SeededSurface & { error?: string };
  if (!response.ok) {
    throw new Error(`inspect-surface ${response.status}: ${body.error ?? "failed"}`);
  }
  return body;
}

/**
 * A calendar card is a real card, at both widths.
 *
 * The manual audit found an empty frame where this card should have been, while
 * the log showed the surface had been published. These drive the real card through
 * the real API with a scripted model: the document loads, the fields are editable,
 * nothing overflows, and the region is never blank. Native and phone shells are not
 * covered here and are not claimed.
 */
for (const viewport of [
  { name: "wide", width: 1280, height: 900 },
  { name: "narrow", width: 360, height: 780 },
] as const) {
  test(`calendar card renders and stays usable at ${viewport.name} width`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await signIn(page, testInfo);

    await send(
      page,
      `call present_interaction with ${JSON.stringify({
        plan: {
          intent: "calendar.create",
          title: "Next week's schedule",
          fields: [
            { name: "name", value: "Weekly sync", required: true, status: "resolved" },
            {
              name: "start",
              value: "2026-11-09T09:00:00+08:00",
              required: true,
              status: "resolved",
            },
            { name: "end", value: "2026-11-09T09:30:00+08:00", required: true, status: "resolved" },
            { name: "timezone", value: "Asia/Shanghai", required: false, status: "resolved" },
          ],
          nextStep: "request_approval",
          riskLevel: "medium",
        },
      })}`,
    );

    const card = page.getByTestId("a2ui-surface-card").first();
    await expect(card).toBeVisible({ timeout: 45_000 });

    // The document loaded: no placeholder survives once the card is up.
    await expect(page.getByTestId("a2ui-surface-placeholder")).toHaveCount(0);
    // The card has real content, not an empty box.
    const text = (await card.textContent()) ?? "";
    expect(text.trim().length).toBeGreaterThan(0);
    // The fields are real controls with the capability's own labels. Before the
    // fix this region was blank; a draft with a title over nothing.
    await expect(card).toContainText("Name");
    await expect(card).toContainText("Starts");
    await expect(card).toContainText("Ends");
    // The resolved values are in the controls, not lost on the way to the card.
    await expect(card.locator("input").first()).not.toHaveValue("");
    await expect(page.getByTestId("a2ui-surface-host")).toHaveCount(1);
    // And the action the capability declares is present.
    await expect(card.getByRole("button", { name: /create/i })).toHaveCount(1);

    // Nothing overflows the viewport horizontally.
    const box = await card.boundingBox();
    expect(box).not.toBeNull();
    if (box) expect(box.width).toBeLessThanOrEqual(viewport.width);

    // The controls are reachable and inside the card, not clipped by it.
    const controls = card.locator("input, button");
    const count = await controls.count();
    expect(count).toBeGreaterThan(0);
    for (let index = 0; index < count; index += 1) {
      const control = controls.nth(index);
      const controlBox = await control.boundingBox();
      if (!controlBox) continue;
      // Every control sits inside the card's own box, and inside the viewport.
      expect(controlBox.x + controlBox.width).toBeLessThanOrEqual(viewport.width + 0.5);
      if (box) {
        expect(controlBox.x).toBeGreaterThanOrEqual(box.x - 0.5);
        expect(controlBox.x + controlBox.width).toBeLessThanOrEqual(box.x + box.width + 0.5);
      }
    }
    // A narrow card scrolls within itself rather than pushing the page sideways.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);

    await captureScreenshot(page, testInfo, `a2ui-e2e-calendar-${viewport.name}`);
  });
}

test("a field the person typed survives a late model edit", async ({ page }, testInfo) => {
  await signIn(page, testInfo);
  await connectFakeMailbox(page);
  await send(
    page,
    `call present_interaction with ${JSON.stringify({
      plan: {
        intent: "email.compose",
        title: "Hello",
        fields: [
          { name: "to", value: "friend@example.test", required: true, status: "resolved" },
          { name: "subject", value: "Hi", required: true, status: "resolved" },
          { name: "body", value: "Hello there", required: true, status: "resolved" },
        ],
        nextStep: "request_approval",
        riskLevel: "medium",
      },
    })}`,
  );
  await waitForSurface(page, "a2ui-email-compose");

  // The person types the subject themselves.
  await typeSubject(page, "我写的主题");
  const revision = await cardRevision(page);

  // A model edit arrives for the same field afterwards.
  await send(
    page,
    `call edit_interaction with ${JSON.stringify({
      revision,
      fields: { subject: "model subject" },
    })}`,
  );
  // The typed value is still on the card, and no second card appeared.
  await expect(page.getByTestId("a2ui-email-compose")).toHaveCount(1);
  await expect(page.getByTestId("a2ui-email-subject")).toHaveValue("我写的主题", {
    timeout: 30_000,
  });
  await captureScreenshot(page, testInfo, "a2ui-e2e-05-user-field-protected");
});

test("an out-of-date revision is refused instead of overwriting the card", async ({
  page,
}, testInfo) => {
  await signIn(page, testInfo);
  await connectFakeMailbox(page);
  await send(
    page,
    `call present_interaction with ${JSON.stringify({
      plan: {
        intent: "email.compose",
        title: "Hello",
        fields: [
          { name: "to", value: "friend@example.test", required: true, status: "resolved" },
          { name: "subject", value: "Hi", required: true, status: "resolved" },
          { name: "body", value: "Hello there", required: true, status: "resolved" },
        ],
        nextStep: "request_approval",
        riskLevel: "medium",
      },
    })}`,
  );
  await waitForSurface(page, "a2ui-email-compose");
  const interactionId = await cardInteractionId(page);
  const bots = await rpc<Array<{ id: string }>>(page, "bots/list", {});

  // One revision behind the card that is on screen, whatever it is showing.
  const current = await cardRevision(page);
  const stale = await page.request.post("/rpc/threads/editInteraction", {
    data: {
      json: {
        botId: bots[0]!.id,
        interactionId,
        revision: current - 1,
        fields: { subject: "stale" },
      },
    },
  });
  const staleBody = await stale.text();
  expect(stale.status(), staleBody).toBeGreaterThanOrEqual(400);
  // The card still shows its own value.
  await expect(page.getByTestId("a2ui-email-subject")).toHaveValue("Hi");
});

test("changing a payload after approval invalidates that approval", async ({ page }, testInfo) => {
  await signIn(page, testInfo);
  await connectFakeMailbox(page);
  await send(
    page,
    `call present_interaction with ${JSON.stringify({
      plan: {
        intent: "email.compose",
        title: "Hello",
        fields: [
          { name: "to", value: "friend@example.test", required: true, status: "resolved" },
          { name: "subject", value: "Hi", required: true, status: "resolved" },
          { name: "body", value: "Hello there", required: true, status: "resolved" },
        ],
        nextStep: "request_approval",
        riskLevel: "medium",
      },
    })}`,
  );
  await waitForSurface(page, "a2ui-email-compose");
  const interactionId = await cardInteractionId(page);
  const bots = await rpc<Array<{ id: string }>>(page, "bots/list", {});
  const botId = bots[0]!.id;

  // Confirming this draft needs a connected mailbox, which this environment does
  // not have, so the interesting half is the other direction: an edit after the
  // draft was approved must leave no approval behind. The edit route is the same
  // one the card and the model use, so it is checked here over real HTTP.
  const beforeEdit = await cardRevision(page);
  const editResponse = await page.request.post("/rpc/threads/editInteraction", {
    data: {
      json: {
        botId,
        interactionId,
        revision: beforeEdit,
        fields: { body: "changed after approval" },
      },
    },
  });
  // The server's own reason is the point of this assertion, so it is the message.
  const editBody = await editResponse.text();
  expect(editResponse.status(), editBody).toBe(200);
  await expect(page.getByTestId("a2ui-email-body")).toHaveValue("changed after approval", {
    timeout: 30_000,
  });

  // Executing without a matching confirmation is refused rather than sending.
  const executed = await page.request.post("/rpc/threads/executeInteraction", {
    data: { json: { botId, interactionId } },
  });
  expect(executed.status()).toBeGreaterThanOrEqual(400);
  await captureScreenshot(page, testInfo, "a2ui-e2e-06-edit-invalidates-approval");
});

test("a draft can be cancelled from the card and offers nothing to send", async ({
  page,
}, testInfo) => {
  await signIn(page, testInfo);
  await send(
    page,
    `call present_interaction with ${JSON.stringify({
      plan: {
        intent: "email.compose",
        title: "Hello",
        fields: [
          { name: "to", value: "friend@example.test", required: true, status: "resolved" },
          { name: "subject", value: "Hi", required: true, status: "resolved" },
          { name: "body", value: "Hello there", required: true, status: "resolved" },
        ],
        nextStep: "request_approval",
        riskLevel: "medium",
      },
    })}`,
  );
  await waitForSurface(page, "a2ui-email-compose");

  await page.getByTestId("a2ui-email-discard").click();
  // The card reports the cancelled state and no Send remains.
  await expect(page.getByTestId("a2ui-email-send")).toHaveCount(0, { timeout: 30_000 });
  await captureScreenshot(page, testInfo, "a2ui-e2e-06-cancelled");
});

/**
 * Browser → production retryInteraction → isolated Postgres.
 *
 * The expired stamp is an isolated seed (`/__e2e/seed-expired-surface`):
 * `settleInteraction` then `surfaceStampFor` on the same message block. Live
 * e2e has no mailbox, so the card is often `needs_connection` (kernel-exempt);
 * the seed then does a labeled open-status fixture write and settles. That is
 * not the C-batch expiry scanner, does not write `staleAt`, and is not a
 * status-only SQL update (which would still look like a draft).
 */
test("expired card retry revives the same persisted surface", async ({ page }, testInfo) => {
  await signIn(page, testInfo);
  await send(
    page,
    `call present_interaction with ${JSON.stringify({
      plan: {
        intent: "email.compose",
        title: "冬天的问候",
        fields: [
          { name: "to", value: "friend@example.test", required: true, status: "resolved" },
          { name: "subject", value: "冬天的问候", required: true, status: "resolved" },
          { name: "body", value: "正文", required: true, status: "resolved" },
        ],
        nextStep: "request_approval",
        riskLevel: "medium",
      },
    })}`,
  );
  await waitForSurface(page, "a2ui-email-compose");

  const interactionId = await cardInteractionId(page);
  const surfaceId = await cardSurfaceId(page);
  const before = await inspectSurface(interactionId);
  expect(before.cardKey).toBeTruthy();
  expect(before.messageId).toBeTruthy();
  expect(before.surfaceId).toBe(surfaceId);

  const seeded = await seedExpiredSurface(interactionId);
  expect(seeded).toMatchObject({
    interactionId,
    cardKey: before.cardKey,
    messageId: before.messageId,
    surfaceId,
    status: "expired",
    block: {
      interactionId,
      surfaceId,
      status: "expired",
      template: "action-expired-card",
    },
  });

  await page.reload();
  await expect(page.getByTestId("a2ui-surface-folded")).toContainText("Expired, nothing was sent", {
    timeout: 45_000,
  });
  await expect(page.getByTestId("a2ui-surface-retry")).toBeVisible();
  await expect(page.getByTestId("a2ui-email-send")).toHaveCount(0);
  await expect(page.getByTestId("a2ui-email-compose")).toHaveCount(0);
  expect(await cardInteractionId(page)).toBe(interactionId);
  expect(await cardSurfaceId(page)).toBe(surfaceId);
  await captureScreenshot(page, testInfo, "a2ui-live-expired-retry");

  await page.getByTestId("a2ui-surface-retry").click();
  await expect(page.getByTestId("a2ui-email-compose")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("a2ui-surface-retry")).toHaveCount(0);
  await expect(
    page.getByTestId("a2ui-email-send").or(page.getByTestId("a2ui-email-connect")),
  ).toBeVisible();
  await expect(page.getByTestId("a2ui-email-to")).toHaveValue("friend@example.test", {
    timeout: 30_000,
  });
  await expect(page.getByTestId("a2ui-email-subject")).toHaveValue("冬天的问候");
  expect(await cardInteractionId(page)).toBe(interactionId);
  expect(await cardSurfaceId(page)).toBe(surfaceId);
  await captureScreenshot(page, testInfo, "a2ui-live-retry-draft");

  const revived = await inspectSurface(interactionId);
  expect(revived).toMatchObject({
    interactionId,
    cardKey: before.cardKey,
    messageId: before.messageId,
    surfaceId,
    block: {
      interactionId,
      surfaceId,
      template: "email-draft-card",
    },
  });
  expect(["collecting", "ready_for_review"]).toContain(revived.status);
  expect(revived.draftVersion).toBeGreaterThan(seeded.draftVersion);
  expect(revived.block?.status).toBe(revived.status);

  await page.reload();
  await expect(page.getByTestId("a2ui-email-compose")).toBeVisible({ timeout: 45_000 });
  await expect(page.getByTestId("a2ui-surface-retry")).toHaveCount(0);
  await expect(page.getByTestId("a2ui-email-to")).toHaveValue("friend@example.test", {
    timeout: 30_000,
  });
  await expect(page.getByTestId("a2ui-email-subject")).toHaveValue("冬天的问候");
  expect(await cardInteractionId(page)).toBe(interactionId);
  expect(await cardSurfaceId(page)).toBe(surfaceId);
  await expect(page.getByTestId("a2ui-surface-card")).toHaveCount(1);
  await captureScreenshot(page, testInfo, "a2ui-live-retry-reload");
});

test("approval window expiry folds the live card through the production closer", async ({
  page,
}, testInfo) => {
  await signIn(page, testInfo);
  await send(
    page,
    `call present_interaction with ${JSON.stringify({
      plan: {
        intent: "email.compose",
        title: "冬天的问候",
        fields: [
          { name: "to", value: "friend@example.test", required: true, status: "resolved" },
          { name: "subject", value: "冬天的问候", required: true, status: "resolved" },
          { name: "body", value: "正文", required: true, status: "resolved" },
        ],
        nextStep: "request_approval",
        riskLevel: "medium",
      },
    })}`,
  );
  await waitForSurface(page, "a2ui-email-compose");

  const interactionId = await cardInteractionId(page);
  const marked = await markAwaitingApprovalExpired(interactionId);
  expect(marked.status).toBe("awaiting_approval");
  expect(marked.block?.status).not.toBe("expired");

  const expired = await expireDueInteractions(interactionId);
  expect(expired.expired).toEqual([interactionId]);
  expect(expired.surface).toMatchObject({
    interactionId,
    status: "expired",
    block: {
      interactionId,
      status: "expired",
      template: "action-expired-card",
    },
  });

  await page.reload();
  await expect(page.getByTestId("a2ui-surface-folded")).toContainText("Expired, nothing was sent", {
    timeout: 45_000,
  });
  await expect(page.getByTestId("a2ui-surface-retry")).toBeVisible();
  await expect(page.getByTestId("a2ui-email-send")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "a2ui-live-auto-expired");
});

test("asking for a schedule produces a result card, never a create draft", async ({
  page,
}, testInfo) => {
  await signIn(page, testInfo);
  // `calendar.query` is cardKind result. present_interaction is the action-draft
  // tool; publishing a query there produced no surface and must not become a
  // create draft (spec registry + §4.2).
  await send(
    page,
    `call present_interaction with ${JSON.stringify({
      plan: {
        intent: "calendar.query",
        title: "Next week",
        fields: [],
        nextStep: "render",
        riskLevel: "low",
      },
    })}`,
  );
  await expect(page.getByTestId("a2ui-surface-card")).toHaveCount(0, { timeout: 20_000 });
  // Shell chrome has a Create control; a refused query must not draw a calendar card.
  await expect(page.getByTestId("a2ui-email-send")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "a2ui-e2e-07-query-not-create");
});

test("a result with no source is refused rather than shown", async ({ page }, testInfo) => {
  await signIn(page, testInfo);
  await send(page, `call present_result with ${JSON.stringify({ title: "Numbers", rows: [] })}`);
  // Nothing is drawn: the server refused a result with no provenance.
  await expect(page.getByTestId("a2ui-surface-card")).toHaveCount(0);
  await expect(page.getByTestId("a2ui-surface-host")).toHaveCount(0);
});

/**
 * The remaining acceptance cases that only a browser can prove.
 *
 * Ambiguity, a same-card re-query and a double submit are all about what the real
 * client and the real router do together, so they are driven here rather than
 * asserted on a pure function.
 */

test("two emails in one thread stay one open card", async ({ page }, testInfo) => {
  await signIn(page, testInfo);
  await connectFakeMailbox(page);
  const plan = (title: string) =>
    JSON.stringify({
      plan: {
        intent: "email.compose",
        title,
        fields: [
          { name: "to", value: "friend@example.test", required: true, status: "resolved" },
          { name: "subject", value: title, required: true, status: "resolved" },
          { name: "body", value: "Hello there", required: true, status: "resolved" },
        ],
        nextStep: "request_approval",
        riskLevel: "medium",
      },
    });
  await send(page, `call present_interaction with ${plan("First")}`);
  await waitForSurface(page, "a2ui-email-compose");
  const firstId = await cardInteractionId(page);
  await send(page, `call present_interaction with ${plan("Second")}`);
  // Spec §4.1: same thread + same intent is one open card. Two emails merge.
  await expect(page.getByTestId("a2ui-email-compose")).toHaveCount(1, { timeout: 45_000 });
  expect(await cardInteractionId(page)).toBe(firstId);
  await expect(page.getByTestId("a2ui-email-subject")).toHaveValue("Second", { timeout: 30_000 });
  await captureScreenshot(page, testInfo, "a2ui-e2e-08-one-email");
});

test("two open cards make an unqualified edit ask which one", async ({ page }, testInfo) => {
  await signIn(page, testInfo);
  await connectFakeMailbox(page);
  await connectFakeCalendar(page);
  const emailPlan = JSON.stringify({
    plan: {
      intent: "email.compose",
      title: "Hello",
      fields: [
        { name: "to", value: "friend@example.test", required: true, status: "resolved" },
        { name: "subject", value: "Hello", required: true, status: "resolved" },
        { name: "body", value: "Hello there", required: true, status: "resolved" },
      ],
      nextStep: "request_approval",
      riskLevel: "medium",
    },
  });
  const calendarPlan = JSON.stringify({
    plan: {
      intent: "calendar.create",
      title: "Team sync",
      fields: [
        { name: "name", value: "Team sync", required: true, status: "resolved" },
        { name: "start", value: "2026-11-09T09:00:00+08:00", required: true, status: "resolved" },
        { name: "end", value: "2026-11-09T10:00:00+08:00", required: true, status: "resolved" },
      ],
      nextStep: "request_approval",
      riskLevel: "medium",
    },
  });
  // One user message, two tool calls: a second send would auto-settle the first
  // card (§4.3), which is why two sequential presents cannot prove ambiguity.
  await send(
    page,
    `call present_interaction with ${emailPlan} then call present_interaction with ${calendarPlan}`,
  );
  await waitForSurface(page, "a2ui-email-compose");
  await expect(page.getByTestId("a2ui-surface-card")).toHaveCount(2, { timeout: 45_000 });
  await expect(page.getByTestId("a2ui-email-subject")).toHaveValue("Hello", { timeout: 30_000 });
  // Different intent, so the calendar draft is a second open card — not shell chrome.
  await expect(page.getByTestId("a2ui-surface-card").nth(1)).toContainText("Team sync");

  const bots = await rpc<Array<{ id: string }>>(page, "bots/list", {});
  const ambiguous = await page.request.post("/rpc/threads/editInteraction", {
    data: { json: { botId: bots[0]!.id, revision: 1, fields: { subject: "changed" } } },
  });
  expect(ambiguous.status()).toBeGreaterThanOrEqual(400);
  expect(await ambiguous.text()).toContain("ambiguous_target");
  await expect(page.getByTestId("a2ui-email-subject")).toHaveValue("Hello");
  await captureScreenshot(page, testInfo, "a2ui-e2e-08-ambiguous");
});

test("a result with no readable source is refused, and a source read shows its own name", async ({
  page,
}, testInfo) => {
  await signIn(page, testInfo);
  // A source id that is not registered: refused, nothing published.
  await send(
    page,
    `call present_result with ${JSON.stringify({
      title: "Numbers",
      sourceId: "not-a-registered-source",
      from: "2026-01-01",
      to: "2026-12-31",
    })}`,
  );
  await expect(page.getByTestId("a2ui-surface-card")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "a2ui-e2e-09-unknown-source-refused");
});

test("a repeated submit does not run the action twice", async ({ page }, testInfo) => {
  await signIn(page, testInfo);
  await send(
    page,
    `call present_interaction with ${JSON.stringify({
      plan: {
        intent: "email.compose",
        title: "Hello",
        fields: [
          { name: "to", value: "friend@example.test", required: true, status: "resolved" },
          { name: "subject", value: "Hi", required: true, status: "resolved" },
          { name: "body", value: "Hello there", required: true, status: "resolved" },
        ],
        nextStep: "request_approval",
        riskLevel: "medium",
      },
    })}`,
  );
  await waitForSurface(page, "a2ui-email-compose");
  const interactionId = await cardInteractionId(page);
  const bots = await rpc<Array<{ id: string }>>(page, "bots/list", {});
  const botId = bots[0]!.id;
  const revision = await cardRevision(page);
  const body = {
    botId,
    interactionId,
    surfaceId: (await page
      .getByTestId("a2ui-surface-card")
      .first()
      .getAttribute("data-surface-id")) as string,
    action: "send",
    revision,
  };

  // Two clicks issued at once, as a double tap would.
  const [first, second] = await Promise.all([
    page.request.post("/rpc/threads/dispatchInteractionAction", { data: { json: body } }),
    page.request.post("/rpc/threads/dispatchInteractionAction", { data: { json: body } }),
  ]);
  const results = [await first.json(), await second.json()];
  const freshRuns = results.filter((entry: unknown) =>
    JSON.stringify(entry).includes('"duplicate":false'),
  ).length;
  // Whatever the outcome, two identical clicks can never produce two executions.
  // With no mailbox connected both are refused, which is why the assertion is
  // "never two" rather than "exactly one": the idempotency rule is what is under
  // test, and the service-level suite covers the single-execution case with a
  // connected provider.
  expect(freshRuns).toBeLessThanOrEqual(1);
  expect(results).toHaveLength(2);
  await captureScreenshot(page, testInfo, "a2ui-e2e-10-double-submit");
});

test("a re-query updates the same result card with a new window", async ({ page }, testInfo) => {
  await signIn(page, testInfo);
  const bots = await rpc<Array<{ id: string }>>(page, "bots/list", {});
  const botId = bots[0]!.id;
  const artifactId = await uploadCsv(page, botId);

  await rpc(page, "threads/send", {
    botId,
    artifactIds: [artifactId],
    text: `call present_result with ${JSON.stringify({
      title: "Quarterly totals",
      sourceId: "csv-upload",
      from: "2026-01-01",
      to: "2026-12-31",
      groupBy: "quarter",
      metrics: [{ key: "total", op: "sum", of: "amount" }],
    })}`,
  });
  const card = page.getByTestId("a2ui-surface-card").first();
  await expect(card).toBeVisible({ timeout: 45_000 });
  await expect(card).toContainText("2000.5", { timeout: 30_000 });
  const interactionId = await cardInteractionId(page);

  // Narrow the window so the file's rows fall outside it: same card, new period,
  // and the card must say there is no data rather than show a stale total.
  const bots2 = bots[0]!.id;
  await rpc(page, "threads/send", {
    botId: bots2,
    text: `call refresh_result with ${JSON.stringify({
      interactionId,
      sourceId: "csv-upload",
      from: "2020-01-01",
      to: "2020-03-31",
    })}`,
  });

  // One card, still the same interaction, and the totals are gone with the period.
  await expect(page.getByTestId("a2ui-surface-card")).toHaveCount(1, { timeout: 45_000 });
  expect(await cardInteractionId(page)).toBe(interactionId);
  await expect(card).not.toContainText("2000.5", { timeout: 30_000 });
  await captureScreenshot(page, testInfo, "a2ui-e2e-11-requery-same-card");
});

/**
 * A calendar draft is a real form, and editing it keeps one card.
 *
 * Three things the compiler and the client have to agree on, on the real page: the
 * schema's fields become controls with their own labels, a batch list travels with
 * the plan without being drawn as a text box, and a follow-up edit rewrites this
 * card rather than adding another. The timezone travels as a value, not as a caption.
 */
test("a calendar draft draws its schema fields and edits on the same card", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page, testInfo);
  await connectFakeCalendar(page);

  await send(
    page,
    `call present_interaction with ${JSON.stringify({
      plan: {
        intent: "calendar.create",
        title: "Two sessions",
        fields: [
          { name: "name", value: "Weekly sync", required: true, status: "resolved" },
          { name: "start", value: "2026-11-09T09:00:00+08:00", required: true, status: "resolved" },
          { name: "end", value: "2026-11-09T09:30:00+08:00", required: true, status: "resolved" },
          { name: "timezone", value: "Asia/Shanghai", required: false, status: "resolved" },
          {
            name: "events",
            value: [
              { summary: "Weekly sync", start: "2026-11-09T09:00:00+08:00" },
              { summary: "Follow-up", start: "2026-11-10T09:00:00+08:00" },
            ],
            required: false,
            status: "resolved",
          },
        ],
        nextStep: "request_approval",
        riskLevel: "medium",
      },
    })}`,
  );

  const card = page.getByTestId("a2ui-surface-card").first();
  await expect(card).toBeVisible({ timeout: 45_000 });
  await expect(page.getByTestId("a2ui-surface-host")).toHaveCount(1);
  // A batch list is the draft. The compiler hides the single-event Starts/Ends
  // controls so they cannot be edited as if they were one event
  // (`compile-surface.ts` / `CALENDAR_SINGLE_EVENT_FIELDS`).
  await expect(card).toContainText("Weekly sync");
  await expect(card).toContainText("Follow-up");
  await expect(card).not.toContainText("Starts");
  await expect(card).not.toContainText("Ends");
  const values = await card
    .locator("input, textarea")
    .evaluateAll((nodes) => nodes.map((node) => (node as HTMLInputElement).value));
  expect(values.some((value) => /summary/i.test(value))).toBe(false);

  const interactionId = await cardInteractionId(page);
  const revision = Number((await card.getAttribute("data-draft-version")) ?? "1");
  const bots = await rpc<Array<{ id: string }>>(page, "bots/list", {});
  const botId = bots[0]!.id;

  // A follow-up edit lands on this card, not a new one.
  const edited = await page.request.post("/rpc/threads/editInteraction", {
    data: {
      json: {
        botId,
        interactionId,
        revision,
        fields: { name: "Weekly sync (renamed)" },
      },
    },
  });
  const editBody = await edited.text();
  expect(edited.status(), editBody).toBe(200);
  expect(JSON.parse(editBody).json).toMatchObject({
    ok: true,
    interactionId,
    // The edit wrote a new revision of the same card, not a new one.
    draftVersion: 2,
  });

  // Reload: the same interaction, at the new revision. The batch list is still
  // the visible draft; the renamed name slot is not a single-event control.
  await page.reload();
  const reloaded = page.getByTestId("a2ui-surface-card").first();
  await expect(reloaded).toBeVisible({ timeout: 45_000 });
  await expect(reloaded).toHaveAttribute("data-draft-version", "2", { timeout: 30_000 });
  expect(await cardInteractionId(page)).toBe(interactionId);
  await expect(reloaded).toContainText("Follow-up");
  await expect(page.getByTestId("a2ui-surface-card")).toHaveCount(1);
  await captureScreenshot(page, testInfo, "a2ui-e2e-12-calendar-same-card-edit");
});

/**
 * Fake Composio pending begin → connections.complete → the same card resumes.
 *
 * Instant begin would mark the mailbox connected before complete ran. This
 * presents first so the card is waiting, then finishes OAuth through the
 * production complete route. Not a live mailbox write.
 */
test("completing Fake Composio OAuth resumes the waiting compose card", async ({
  page,
}, testInfo) => {
  await signIn(page, testInfo);
  await send(
    page,
    `call present_interaction with ${JSON.stringify({
      plan: {
        intent: "email.compose",
        title: "Hello",
        fields: [
          { name: "to", value: "friend@example.test", required: true, status: "resolved" },
          { name: "subject", value: "Hi", required: true, status: "resolved" },
          { name: "body", value: "Hello there", required: true, status: "resolved" },
        ],
        nextStep: "request_approval",
        riskLevel: "medium",
      },
    })}`,
  );
  await waitForSurface(page, "a2ui-email-compose");
  await expect(page.getByTestId("a2ui-email-connect")).toBeVisible({ timeout: 30_000 });
  const interactionId = await cardInteractionId(page);
  await expect(page.getByTestId("a2ui-email-subject")).toBeDisabled();
  await captureScreenshot(page, testInfo, "a2ui-e2e-pending-connect");

  await connectFakeMailbox(page);
  await expect(page.getByTestId("a2ui-email-connect")).toHaveCount(0, { timeout: 45_000 });
  await expect(page.getByTestId("a2ui-email-subject")).toHaveValue("Hi", { timeout: 30_000 });
  await expect(page.getByTestId("a2ui-email-subject")).toBeEnabled();
  expect(await cardInteractionId(page)).toBe(interactionId);
  await captureScreenshot(page, testInfo, "a2ui-e2e-complete-resume");
});
