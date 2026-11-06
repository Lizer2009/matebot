// @vitest-environment jsdom
import type { A2uiSurfaceBlock } from "@matebot/contracts";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { A2uiSurfaceCard } from "./A2uiSurfaceCard";
import { fixtureA2uiSurfaceBlock, unknownComponentSurfaceMessages } from "./fixtures";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: unknown }) => children,
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw(strings, ...values),
  }),
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function renderCard(block: A2uiSurfaceBlock, messages?: unknown[]) {
  act(() => root.render(<A2uiSurfaceCard block={block} messages={messages} />));
}

describe("A2uiSurfaceCard", () => {
  it("shows title and placeholder without a document", () => {
    renderCard(
      fixtureA2uiSurfaceBlock({
        documentRef: undefined,
        title: "Draft",
        summary: "Waiting",
      }),
    );
    expect(container.querySelector('[data-testid="a2ui-surface-card"]')?.textContent).toContain(
      "Draft",
    );
    expect(container.querySelector('[data-testid="a2ui-surface-placeholder"]')).toBeTruthy();
  });

  it("does not render v1_0 surfaces in the Phase 1 host", () => {
    renderCard(
      fixtureA2uiSurfaceBlock({
        protocolFamily: "v1_0",
        documentRef: undefined,
      }),
    );
    expect(container.textContent).toMatch(/v1_0/);
    expect(container.querySelector('[data-testid="a2ui-surface-host"]')).toBeNull();
  });

  it("refuses unknown catalog components without mounting a surface host", async () => {
    renderCard(
      fixtureA2uiSurfaceBlock({
        surfaceId: "fixture-unknown",
        documentRef: undefined,
      }),
      unknownComponentSurfaceMessages(),
    );
    await act(async () => {
      await Promise.resolve();
    });
    const refused = container.querySelector('[data-testid="a2ui-surface-refused"]');
    expect(refused?.textContent).toMatch(/EvilWidget/);
    expect(container.querySelector('[data-testid="a2ui-surface-host"]')).toBeNull();
  });
});
