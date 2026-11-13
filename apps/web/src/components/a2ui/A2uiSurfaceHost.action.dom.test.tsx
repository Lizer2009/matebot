// @vitest-environment jsdom

import { compileInteractionSurface } from "@matebot/a2ui-adapter";
import type { InteractionSurfaceSchema } from "@matebot/contracts";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { A2uiSurfaceHost } from "./A2uiSurfaceHost";

/**
 * End to end through the real pieces: the trusted compiler produces the tree,
 * the real renderer mounts it, and a real click must reach the one action
 * listener carrying the interaction and revision the surface was built from.
 *
 * This is the test the old host failed: it built `MessageProcessor` with no
 * listener, so the button existed and did nothing.
 */

const schema: InteractionSurfaceSchema = {
  schemaVersion: 1,
  presentation: "form",
  fields: [{ name: "to", label: "To", kind: "email", required: true }],
  action: { id: "send", label: "Send", requiresRevision: true },
};

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function compileFor(revision: number) {
  const compiled = await compileInteractionSurface({
    schema,
    values: { to: "a@example.com" },
    surfaceId: "surf-1",
    interactionId: "ix-1",
    revision,
  });
  expect(compiled.ok).toBe(true);
  if (!compiled.ok) throw new Error(compiled.error);
  return compiled.messages;
}

describe("compiled surface click reaches the action bridge", () => {
  it("sends the surface's own interaction and revision on click", async () => {
    const onAction = vi.fn();
    const messages = await compileFor(5);
    await act(async () => {
      root.render(createElement(A2uiSurfaceHost, { surfaceId: "surf-1", messages, onAction }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });

    const button = host.querySelector("button");
    expect(button).toBeTruthy();
    await act(async () => {
      button?.click();
      await new Promise((resolve) => setTimeout(resolve, 40));
    });

    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction.mock.calls[0]?.[0]).toMatchObject({
      name: "interaction.action.send",
      surfaceId: "surf-1",
      context: { interactionId: "ix-1", revision: 5 },
    });
  });

  // A revision bump must change what the click carries, or the server would
  // treat an edited draft's submit as the old one.
  it("carries the new revision after the surface is recompiled", async () => {
    const onAction = vi.fn();
    const messages = await compileFor(6);
    await act(async () => {
      root.render(createElement(A2uiSurfaceHost, { surfaceId: "surf-1", messages, onAction }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });
    await act(async () => {
      host.querySelector("button")?.click();
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    expect(onAction.mock.calls[0]?.[0]).toMatchObject({
      context: { interactionId: "ix-1", revision: 6 },
    });
  });

  it("renders the field the schema declared alongside the button", async () => {
    const messages = await compileFor(2);
    await act(async () => {
      root.render(
        createElement(A2uiSurfaceHost, { surfaceId: "surf-1", messages, onAction: vi.fn() }),
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });
    expect(host.querySelectorAll("input[type='text']")).toHaveLength(1);
    expect(host.querySelectorAll("button")).toHaveLength(1);
  });

  /**
   * A parent re-render must not flash the card.
   *
   * The message row passes an inline listener, so its identity changes on every render. That
   * used to be an effect dependency: each re-render dropped the surface back to its loading
   * skeleton and rebuilt it, and a card in a busy thread blinked continuously.
   */
  it("keeps the drawn surface when a re-render passes a new listener", async () => {
    const messages = await compileFor(2);
    await act(async () => {
      root.render(
        createElement(A2uiSurfaceHost, { surfaceId: "surf-1", messages, onAction: vi.fn() }),
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });
    expect(host.querySelector("[data-testid='a2ui-surface-host']")).toBeTruthy();

    const next = vi.fn();
    await act(async () => {
      root.render(
        createElement(A2uiSurfaceHost, { surfaceId: "surf-1", messages, onAction: next }),
      );
    });
    // No skeleton frame: the drawn card stays while the same surface is handed over.
    expect(host.querySelector("[data-testid='a2ui-surface-loading']")).toBeNull();
    expect(host.querySelectorAll("input[type='text']")).toHaveLength(1);

    await act(async () => {
      host.querySelector("button")?.click();
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    // The bridge is stable, but it always calls the listener the caller passed last.
    expect(next).toHaveBeenCalledTimes(1);
  });
});
