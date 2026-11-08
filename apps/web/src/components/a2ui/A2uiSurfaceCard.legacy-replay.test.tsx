// @vitest-environment jsdom
import { compileInteractionSurface } from "@matebot/a2ui-adapter";
import type { InteractionSurfaceSchema } from "@matebot/contracts";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { A2uiSurfaceCard } from "./A2uiSurfaceCard";
import { loadA2uiRenderer } from "./load-a2ui";

/**
 * A document written by an older build must still draw.
 *
 * The deployed backend began writing surface documents before this branch changed the
 * compiler, so history contains documents in the old shape. Replaying one has to
 * produce a card, and a document that genuinely cannot be drawn has to say so — the
 * failure being fixed is a region that showed nothing at all.
 *
 * The fixtures below are the literal old output: a `Column` of three `Text` nodes
 * bound by `path`, with the values in `updateDataModel`. No secrets, no user data.
 */

const lingui = vi.hoisted(() => ({
  useLingui: () => ({
    t: (input: TemplateStringsArray | { message: string }, ...values: unknown[]) => {
      if (typeof input === "object" && "message" in input) return input.message;
      return String.raw(input, ...values);
    },
    i18n: { locale: "en" },
  }),
  Trans: ({ children }: { children: unknown }) => children,
}));
vi.mock("@lingui/react/macro", () => lingui);
vi.mock("@lingui/react", () => lingui);

const SURFACE_ID = "surface-legacy-1";

/** Exactly what the pre-fix compiler emitted for a calendar.create plan. */
function legacyCalendarDocument(): unknown[] {
  return [
    {
      version: "v0.9",
      createSurface: {
        surfaceId: SURFACE_ID,
        catalogId: "https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json",
      },
    },
    {
      version: "v0.9",
      updateComponents: {
        surfaceId: SURFACE_ID,
        components: [
          { id: "root", component: "Column", children: ["title", "summary", "fields"] },
          { id: "title", component: "Text", text: { path: "/title" }, variant: "h3" },
          { id: "summary", component: "Text", text: { path: "/summary" } },
          { id: "fields", component: "Text", text: { path: "/intent" } },
        ],
      },
    },
    {
      version: "v0.9",
      updateDataModel: {
        surfaceId: SURFACE_ID,
        value: {
          title: "下周工作日程",
          summary: "",
          intent: "calendar.create",
          nextStep: "request_approval",
          riskLevel: "medium",
          fields: [{ name: "name", value: "Weekly sync", required: true, status: "resolved" }],
        },
      },
    },
  ];
}

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // The card loads the renderer itself; importing it first is what warms the shared
  // module the component reuses.
  await loadA2uiRenderer();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const block = (documentRef?: string) =>
  ({
    kind: "a2ui_surface",
    interactionId: "interaction-legacy-1",
    surfaceId: SURFACE_ID,
    protocolFamily: "v0_9",
    draftVersion: 1,
    intent: "calendar.create",
    title: "下周工作日程",
    ...(documentRef ? { documentRef } : {}),
  }) satisfies Parameters<typeof A2uiSurfaceCard>[0]["block"];

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
}

describe("replaying a document an older build wrote", () => {
  it("draws the card with the values it stored", async () => {
    const messages = legacyCalendarDocument();
    act(() => root.render(createElement(A2uiSurfaceCard, { block: block(), messages })));
    await settle();

    const card = container.querySelector('[data-testid="a2ui-surface-card"]');
    expect(card).not.toBeNull();
    // The stored title is drawn, so the replay is visibly the right card…
    expect(card?.textContent).toContain("下周工作日程");
    // …and it is a real surface, not the placeholder.
    expect(container.querySelector('[data-testid="a2ui-surface-placeholder"]')).toBeNull();
    expect(container.querySelector('[data-testid="a2ui-surface-host"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="a2ui-surface-refused"]')).toBeNull();
  });

  /**
   * The old compiler drew no form controls and no action. That is a real limitation of
   * that document, not a renderer failure — so the card renders what it has rather than
   * claiming a draft is ready to confirm.
   */
  it("does not invent controls or a confirm action the old document never had", async () => {
    act(() =>
      root.render(
        createElement(A2uiSurfaceCard, { block: block(), messages: legacyCalendarDocument() }),
      ),
    );
    await settle();
    expect(container.querySelectorAll("input").length).toBe(0);
    expect(container.querySelectorAll("button").length).toBe(0);
  });

  /**
   * The conversation says "confirm in the card above". That card has nothing to confirm
   * with, and it must not silently leave the instruction hanging.
   */
  it("says an old card has nothing to fill in or confirm, and how to get one", async () => {
    act(() =>
      root.render(
        createElement(A2uiSurfaceCard, { block: block(), messages: legacyCalendarDocument() }),
      ),
    );
    await settle();
    const notice = container.querySelector('[data-testid="a2ui-surface-recovery"]');
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toMatch(/older card/i);
    expect(notice?.textContent).toMatch(/nothing to fill in or confirm/i);
    // A way forward, not just a statement of the problem.
    expect(notice?.textContent).toMatch(/ask for the draft again/i);
    // And no claim that anything here can be confirmed.
    expect(container.querySelectorAll("button").length).toBe(0);
  });

  it("does not show that notice on a card this build writes", async () => {
    const schema: InteractionSurfaceSchema = {
      schemaVersion: 1,
      presentation: "form",
      fields: [{ name: "name", label: "Name", kind: "text", required: true }],
      action: { id: "create", label: "Create", requiresRevision: true },
    };
    const compiled = await compileInteractionSurface({
      schema,
      values: { name: "Weekly sync" },
      surfaceId: SURFACE_ID,
    });
    if (!compiled.ok) throw new Error(compiled.error);
    act(() =>
      root.render(
        createElement(A2uiSurfaceCard, {
          block: block(),
          messages: compiled.messages as unknown[],
        }),
      ),
    );
    await settle();
    expect(container.querySelector('[data-testid="a2ui-surface-recovery"]')).toBeNull();
    expect(container.querySelectorAll("input").length).toBeGreaterThan(0);
  });

  it("loads an old document through its ref, as history does", async () => {
    const fetchDocument = vi.fn(async () => legacyCalendarDocument());
    act(() =>
      root.render(
        createElement(A2uiSurfaceCard, {
          block: block("a2ui:interaction:interaction-legacy-1:surface:surface-legacy-1"),
          fetchDocument,
        }),
      ),
    );
    await settle();
    expect(fetchDocument).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="a2ui-surface-card"]')?.textContent).toContain(
      "下周工作日程",
    );
  });

  /**
   * A document that cannot be drawn says so, with a reason and a way to retry — never a
   * blank region. This is the state the reported conversation was in for the reader,
   * and the one thing it must never be is silent.
   */
  it.each([
    ["an empty document", async () => [] as unknown[]],
    [
      "a document naming a component the catalog does not have",
      async () => [
        {
          version: "v0.9",
          createSurface: {
            surfaceId: SURFACE_ID,
            catalogId: "https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json",
          },
        },
        {
          version: "v0.9",
          updateComponents: {
            surfaceId: SURFACE_ID,
            components: [{ id: "root", component: "EvilWidget" }],
          },
        },
      ],
    ],
    [
      "a document for a surface id it never creates",
      async () => [
        {
          version: "v0.9",
          createSurface: {
            surfaceId: "some-other-surface",
            catalogId: "https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json",
          },
        },
      ],
    ],
  ])("says why %s cannot be drawn", async (_label, load) => {
    act(() =>
      root.render(
        createElement(A2uiSurfaceCard, {
          block: block("a2ui:interaction:interaction-legacy-1:surface:surface-legacy-1"),
          fetchDocument: load,
        }),
      ),
    );
    await settle();

    const text = (container.textContent ?? "").trim();
    expect(text.length).toBeGreaterThan(0);
    const explained =
      container.querySelector('[data-testid="a2ui-surface-placeholder"]') ??
      container.querySelector('[data-testid="a2ui-surface-refused"]');
    expect(explained, text).not.toBeNull();
  });

  /**
   * A document written by this build is a different shape; the same card must draw it,
   * so the replay path does not only work for one generation of payload.
   */
  it("draws a document this build writes, after the same card drew an old one", async () => {
    const schema: InteractionSurfaceSchema = {
      schemaVersion: 1,
      presentation: "form",
      fields: [
        { name: "name", label: "Name", kind: "text", required: true },
        { name: "start", label: "Starts", kind: "dateTime", required: true },
      ],
      action: { id: "create", label: "Create", requiresRevision: true },
    };
    const compiled = await compileInteractionSurface({
      schema,
      values: { name: "Weekly sync", start: "2026-11-09T09:00" },
      surfaceId: SURFACE_ID,
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;

    const fetchDocument = vi
      .fn<(ref: string) => Promise<unknown[] | undefined>>()
      .mockResolvedValueOnce(legacyCalendarDocument())
      .mockResolvedValueOnce(compiled.messages as unknown[]);
    const documentRef = "a2ui:interaction:interaction-legacy-1:surface:surface-legacy-1";

    // Old document first: the title, no controls.
    act(() =>
      root.render(createElement(A2uiSurfaceCard, { block: block(documentRef), fetchDocument })),
    );
    await settle();
    expect(container.querySelectorAll("input").length).toBe(0);

    // Then the card republishes at revision 2 with a document this build writes.
    act(() =>
      root.render(
        createElement(A2uiSurfaceCard, {
          block: { ...block(documentRef), draftVersion: 2 },
          fetchDocument,
        }),
      ),
    );
    await settle();
    expect(fetchDocument).toHaveBeenCalledTimes(2);
    // Real controls, and the action the capability declares.
    expect(container.querySelectorAll("input").length).toBeGreaterThan(0);
    expect(container.textContent).toContain("Create");
  });
});
