// @vitest-environment jsdom

import type { A2uiSurfaceBlock } from "@matebot/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isA2uiEnabled } from "./a2ui-flag";
import { hasVisibleMessagePresentation, messagePresentationSegments } from "./message-presentation";

/**
 * The three states the server can be in, end to end through the code that decides them.
 *
 * The reported failure was a row that showed nothing: the mobile transcript filtered
 * `a2ui_surface` blocks out on a build flag nobody set, so the message either vanished or
 * shrank to its text with no hint a card had been there. These pin the decision, and the
 * component test beside them pins what the reader sees.
 */

const surface = {
  kind: "a2ui_surface",
  interactionId: "interaction-1",
  surfaceId: "surface-1",
  protocolFamily: "v0_9",
  draftVersion: 1,
  title: "Next week's schedule",
} satisfies A2uiSurfaceBlock;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("what the server says decides, on mobile too", () => {
  it("draws when the server serves cards, even with no build flag", () => {
    vi.stubEnv("EXPO_PUBLIC_FEATURE_A2UI", "");
    expect(isA2uiEnabled({ server: true })).toBe(true);
  });

  /**
   * The server owns the routes a card's buttons call. Drawing one it does not serve would
   * offer controls that fail; hiding it leaves the silent gap this fixes.
   */
  it("does not draw when the server says it does not serve them", () => {
    vi.stubEnv("EXPO_PUBLIC_FEATURE_A2UI", "1");
    expect(isA2uiEnabled({ server: false })).toBe(false);
  });

  it("falls back to the build flag while the server has not answered", () => {
    vi.stubEnv("EXPO_PUBLIC_FEATURE_A2UI", "1");
    expect(isA2uiEnabled({ server: undefined })).toBe(true);
    vi.stubEnv("EXPO_PUBLIC_FEATURE_A2UI", "");
    expect(isA2uiEnabled({ server: undefined })).toBe(false);
  });
});

describe("a card the server does not serve keeps its row", () => {
  it("is still visible, so its message does not disappear", () => {
    vi.stubEnv("EXPO_PUBLIC_FEATURE_A2UI", "");
    // The old code filtered it out here, and the row went with it.
    expect(hasVisibleMessagePresentation([surface])).toBe(true);
  });

  it("never joins the text flow, where it would print as a raw block", () => {
    vi.stubEnv("EXPO_PUBLIC_FEATURE_A2UI", "");
    expect(messagePresentationSegments([surface])).toEqual([]);
    expect(messagePresentationSegments([{ kind: "text", text: "Draft" }, surface])).toEqual([
      { kind: "content", blocks: [{ kind: "text", text: "Draft" }] },
    ]);
  });

  it("keeps a message that is only that card", () => {
    vi.stubEnv("EXPO_PUBLIC_FEATURE_A2UI", "");
    // A message whose only block is the card must still render, or the card's "cannot be
    // shown" sentence has nowhere to appear.
    expect(hasVisibleMessagePresentation([surface])).toBe(true);
  });
});

/**
 * The component the row draws for a card says so, and says nothing it cannot back up.
 */
describe("A2uiNativeSurface on a document it cannot draw", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { __DEV__?: boolean }).__DEV__ = false;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  /** The early card the conversation refers to: three text nodes, nothing to press. */
  it("says an old card has nothing to fill in or confirm", async () => {
    vi.resetModules();
    vi.doMock("react-native", () => ({
      Text: ({ children, testID }: { children?: ReactNode; testID?: string }) => (
        <span data-testid={testID}>{children}</span>
      ),
      View: ({ children, testID }: { children?: ReactNode; testID?: string }) => (
        <div data-testid={testID}>{children}</div>
      ),
      TextInput: () => <input />,
      Pressable: ({ children, testID }: { children?: ReactNode; testID?: string }) => (
        <div data-testid={testID}>{children}</div>
      ),
    }));
    vi.doMock("./i18n", () => ({
      t: (id: string) => id,
      useI18n: () => ({ t: (id: string) => id, locale: "en" }),
    }));
    const { A2uiNativeSurface } = await import("../components/thread/a2ui-native-surface");
    const { createElement } = await import("react");
    await act(async () => {
      root.render(
        createElement(A2uiNativeSurface, {
          block: surface,
          // The previous compiler's literal output.
          messages: [
            {
              version: "v0.9",
              createSurface: {
                surfaceId: "surface-1",
                catalogId: "https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json",
              },
            },
            {
              version: "v0.9",
              updateComponents: {
                surfaceId: "surface-1",
                components: [
                  { id: "root", component: "Column", children: ["title", "summary"] },
                  { id: "title", component: "Text", text: { path: "/title" } },
                  { id: "summary", component: "Text", text: { path: "/summary" } },
                ],
              },
            },
            {
              version: "v0.9",
              updateDataModel: { surfaceId: "surface-1", value: { title: "Schedule" } },
            },
          ],
        } as never),
      );
    });
    const notice = container.querySelector('[data-testid="a2ui-native-recovery"]');
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toMatch(/older card/i);
    expect(notice?.textContent).toMatch(/ask for the draft again/i);
    // No fabricated control.
    expect(container.querySelectorAll("input").length).toBe(0);
  });

  it("says it is loading, not that it is an old card", async () => {
    vi.resetModules();
    vi.doMock("react-native", () => ({
      Text: ({ children, testID }: { children?: ReactNode; testID?: string }) => (
        <span data-testid={testID}>{children}</span>
      ),
      View: ({ children, testID }: { children?: ReactNode; testID?: string }) => (
        <div data-testid={testID}>{children}</div>
      ),
      TextInput: () => <input />,
      Pressable: ({ children, testID }: { children?: ReactNode; testID?: string }) => (
        <div data-testid={testID}>{children}</div>
      ),
    }));
    vi.doMock("./i18n", () => ({
      t: (id: string) => id,
      useI18n: () => ({ t: (id: string) => id, locale: "en" }),
    }));
    const { A2uiNativeSurface } = await import("../components/thread/a2ui-native-surface");
    const { createElement } = await import("react");
    // A fetch that never resolves: an unresolved document is not an old card.
    await act(async () => {
      root.render(
        createElement(A2uiNativeSurface, {
          block: {
            ...surface,
            documentRef: "a2ui:interaction:interaction-1:surface:surface-1",
          },
          fetchDocument: () => new Promise<unknown[] | undefined>(() => undefined),
        } as never),
      );
    });
    expect(container.querySelector('[data-testid="a2ui-native-loading"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="a2ui-native-recovery"]')).toBeNull();
  });

  it("renders a reason instead of nothing", async () => {
    vi.resetModules();
    vi.doMock("react-native", () => ({
      Text: ({ children, testID }: { children?: ReactNode; testID?: string }) => (
        <span data-testid={testID}>{children}</span>
      ),
      View: ({ children, testID }: { children?: ReactNode; testID?: string }) => (
        <div data-testid={testID}>{children}</div>
      ),
      TextInput: () => <input />,
      Pressable: ({ children, testID }: { children?: ReactNode; testID?: string }) => (
        <div data-testid={testID}>{children}</div>
      ),
    }));
    vi.doMock("./i18n", () => ({
      t: (id: string) => id,
      useI18n: () => ({ t: (id: string) => id, locale: "en" }),
    }));
    const { A2uiNativeSurface } = await import("../components/thread/a2ui-native-surface");
    await act(async () => {
      root.render(
        (await import("react")).createElement(A2uiNativeSurface, {
          block: surface,
          // A document naming a component the native catalog does not know.
          messages: [
            {
              version: "v0.9",
              createSurface: {
                surfaceId: "surface-1",
                catalogId: "https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json",
              },
            },
            {
              version: "v0.9",
              updateComponents: {
                surfaceId: "surface-1",
                components: [{ id: "root", component: "EvilWidget" }],
              },
            },
          ],
        } as never),
      );
    });
    const refused = container.querySelector('[data-testid="a2ui-native-refused"]');
    expect(refused).not.toBeNull();
    expect((refused?.textContent ?? "").trim().length).toBeGreaterThan(0);
  });

  /**
   * A card with no document at all is the blank frame the audit found: a title over
   * nothing, with no word about why. It has to say so, and offer the one thing that can
   * change the answer when a stored ref exists.
   */
  it("says a card with nothing to draw could not be shown, and offers to load it again", async () => {
    vi.resetModules();
    vi.doMock("react-native", () => ({
      Text: ({ children, testID }: { children?: ReactNode; testID?: string }) => (
        <span data-testid={testID}>{children}</span>
      ),
      View: ({ children, testID }: { children?: ReactNode; testID?: string }) => (
        <div data-testid={testID}>{children}</div>
      ),
      TextInput: () => <input />,
      Pressable: ({
        children,
        onPress,
        testID,
      }: {
        children?: ReactNode;
        onPress?: () => void;
        testID?: string;
      }) => (
        <button type="button" data-testid={testID} onClick={() => onPress?.()}>
          {children}
        </button>
      ),
    }));
    vi.doMock("./i18n", () => {
      // A stable `t`, like the real one: the fetch effect keys on it.
      const t = (id: string) => id;
      return { t, useI18n: () => ({ t, locale: "en" }) };
    });
    const { A2uiNativeSurface } = await import("../components/thread/a2ui-native-surface");
    const fetchDocument = vi.fn(async () => undefined as unknown[] | undefined);
    await act(async () => {
      root.render(
        (await import("react")).createElement(A2uiNativeSurface, {
          block: { ...surface, documentRef: "a2ui:interaction:interaction-1:surface:surface-1" },
          fetchDocument,
        } as never),
      );
    });
    const loadError = container.querySelector('[data-testid="a2ui-native-load-error"]');
    expect(loadError).not.toBeNull();
    expect(loadError?.textContent).toMatch(/could not be shown/i);
    // The reason travels with it, so the reader is not told only that something failed.
    expect(loadError?.textContent).toMatch(/no content/i);
    // The reader can act on it rather than being told to try a card that is not there.
    const reload = container.querySelector('[data-testid="a2ui-native-reload"]');
    expect(reload).not.toBeNull();
    const before = fetchDocument.mock.calls.length;
    await act(async () => {
      (reload as HTMLElement).click();
    });
    expect(fetchDocument.mock.calls.length).toBeGreaterThan(before);
  });

  it("draws no attempt to reload a card that has no stored document", async () => {
    vi.resetModules();
    vi.doMock("react-native", () => ({
      Text: ({ children, testID }: { children?: ReactNode; testID?: string }) => (
        <span data-testid={testID}>{children}</span>
      ),
      View: ({ children, testID }: { children?: ReactNode; testID?: string }) => (
        <div data-testid={testID}>{children}</div>
      ),
      TextInput: () => <input />,
      Pressable: ({ children, testID }: { children?: ReactNode; testID?: string }) => (
        <div data-testid={testID}>{children}</div>
      ),
    }));
    vi.doMock("./i18n", () => ({
      t: (id: string) => id,
      useI18n: () => ({ t: (id: string) => id, locale: "en" }),
    }));
    const { A2uiNativeSurface } = await import("../components/thread/a2ui-native-surface");
    await act(async () => {
      root.render(
        (await import("react")).createElement(A2uiNativeSurface, {
          block: surface,
        } as never),
      );
    });
    expect(container.querySelector('[data-testid="a2ui-native-unavailable"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="a2ui-native-reload"]')).toBeNull();
  });
});
