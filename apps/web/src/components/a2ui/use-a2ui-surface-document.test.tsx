// @vitest-environment jsdom

import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useA2uiSurfaceDocument } from "./use-a2ui-surface-document";

/**
 * A card must never be a blank region.
 *
 * The audit found an empty frame where a calendar card should have been. The
 * surface had been published — the log's `a2ui.surface_visible` fires inside the
 * publish transaction — so the gap was between publication and rendering. These
 * pin the states that used to render nothing: no fetcher, an empty document, and
 * a failed fetch.
 */

const REF = "a2ui:interaction:ix-1:surface:surf-1";

describe("useA2uiSurfaceDocument", () => {
  let root: Root | undefined;
  let host: HTMLDivElement | undefined;

  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = undefined;
    host = undefined;
  });

  /** Render the hook and return a live view of its latest state. */
  function run(source: Parameters<typeof useA2uiSurfaceDocument>[0]) {
    const seen: Array<ReturnType<typeof useA2uiSurfaceDocument>> = [];
    function Probe() {
      seen.push(useA2uiSurfaceDocument(source));
      return null;
    }
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(<Probe />));
    return { latest: () => seen[seen.length - 1]! };
  }

  it("reports a server ref with no fetcher as unavailable, not as loading", () => {
    const { latest } = run({ documentRef: REF });
    const state = latest();
    expect(state.messages).toBeUndefined();
    expect(state.loading).toBe(false);
    // This is the case that used to leave the region empty with no explanation.
    expect(state.unavailable).toBe(true);
  });

  it("treats an empty document as a failure to load", async () => {
    const fetchDocument = vi.fn(async () => [] as unknown[]);
    const { latest } = run({ documentRef: REF, fetchDocument });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const state = latest();
    expect(state.messages).toBeUndefined();
    expect(state.unavailable).toBe(true);
    expect(state.error).toBeTruthy();
  });

  it("reports a fetch error with its reason", async () => {
    const fetchDocument = vi.fn(async () => {
      throw new Error("network down");
    });
    const { latest } = run({ documentRef: REF, fetchDocument });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(latest().error).toBe("network down");
    expect(latest().unavailable).toBe(true);
  });

  it("draws a resolved document", async () => {
    const fetchDocument = vi.fn(async () => [{ createSurface: { surfaceId: "surf-1" } }]);
    const { latest } = run({ documentRef: REF, fetchDocument });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(latest().messages).toHaveLength(1);
    expect(latest().unavailable).toBe(false);
  });

  it("loads again when reload is called after a failure", async () => {
    let calls = 0;
    const fetchDocument = vi.fn(async () => {
      calls += 1;
      return calls === 1 ? [] : [{ createSurface: { surfaceId: "surf-1" } }];
    });
    const { latest } = run({ documentRef: REF, fetchDocument });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(latest().unavailable).toBe(true);

    act(() => latest().reload());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchDocument).toHaveBeenCalledTimes(2);
    expect(latest().messages).toHaveLength(1);
    expect(latest().unavailable).toBe(false);
  });

  it("uses an injected document without fetching", () => {
    const fetchDocument = vi.fn(async () => []);
    const { latest } = run({ documentRef: REF, fetchDocument, messages: [{ a: 1 }] });
    expect(latest().messages).toEqual([{ a: 1 }]);
    expect(fetchDocument).not.toHaveBeenCalled();
  });
});
