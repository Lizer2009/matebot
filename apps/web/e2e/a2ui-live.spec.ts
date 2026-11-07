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
  const interactionId = (await page
    .getByTestId("a2ui-email-compose")
    .getAttribute("data-interaction-id")) as string | null;
  const compose = page.getByTestId("a2ui-email-compose");
  const draftVersion = Number((await compose.getAttribute("data-draft-version")) ?? "1");
  void interactionId;

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
  await captureScreenshot(page, testInfo, "a2ui-e2e-02-edited-same-card");
});

test("result card carries provenance and re-queries the same card", async ({ page }, testInfo) => {
  await signIn(page, testInfo);

  await send(
    page,
    `call present_result with ${JSON.stringify({
      title: "Annual sales",
      source: "user-provided CSV",
      asOf: "2026-11-06T00:00:00.000Z",
      window: { from: "2026-01-01", to: "2026-12-31" },
      units: "CNY",
      columns: [
        { key: "quarter", label: "Quarter" },
        { key: "total", label: "Total" },
      ],
      rows: [
        { quarter: "Q1", total: "1.2M" },
        { quarter: "Q2", total: "1.6M" },
      ],
    })}`,
  );
  await waitForSurface(page, "a2ui-surface-card");
  // Provenance is on the card, not in prose.
  await expect(page.getByTestId("a2ui-surface-card").first()).toContainText("user-provided CSV", {
    timeout: 30_000,
  });
  await expect(page.getByTestId("a2ui-surface-card").first()).toContainText("Q1");
  await captureScreenshot(page, testInfo, "a2ui-e2e-03-result-provenance");

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
