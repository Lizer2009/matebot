// @vitest-environment jsdom

import type { A2uiSurfaceBlock } from "@matebot/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { A2uiNativeSurface } from "../components/thread/a2ui-native-surface";

/**
 * A phone must be able to submit the same compiled surface as the web card.
 * These press the native button and require the action to reach the listener —
 * a rendered button that cannot submit is the parity gap this closes.
 */

vi.mock("react-native", () => ({
  Text: ({ children, testID }: { children?: ReactNode; testID?: string }) => (
    <span data-testid={testID}>{children}</span>
  ),
  View: ({ children, testID }: { children?: ReactNode; testID?: string }) => (
    <div data-testid={testID}>{children}</div>
  ),
  TextInput: ({
    value,
    onChangeText,
    testID,
  }: {
    value?: string;
    onChangeText?: (value: string) => void;
    testID?: string;
  }) => (
    <input data-testid={testID} value={value} onChange={(e) => onChangeText?.(e.target.value)} />
  ),
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

vi.mock("../lib/i18n", () => ({
  useI18n: () => ({ t: (value: string) => value }),
}));

const block = {
  kind: "a2ui_surface",
  interactionId: "ix-1",
  surfaceId: "surf-1",
  protocolFamily: "v0_9",
  draftVersion: 3,
  intent: "interaction.result",
} as unknown as A2uiSurfaceBlock;

const messages = [
  {
    version: "v0.9",
    updateDataModel: {
      surfaceId: "surf-1",
      value: { values: {}, revision: 3, interactionId: "ix-1" },
    },
  },
  {
    version: "v0.9",
    updateComponents: {
      surfaceId: "surf-1",
      components: [
        { id: "root", component: "Column", children: ["label", "action"] },
        { id: "label", component: "Text", text: "Go" },
        {
          id: "action",
          component: "Button",
          child: "label",
          variant: "primary",
          action: {
            event: {
              name: "interaction.action.send",
              context: {
                interactionId: { path: "/interactionId" },
                revision: { path: "/revision" },
              },
            },
          },
        },
      ],
    },
  },
];

let host: HTMLDivElement;
let root: Root;

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("native surface actions", () => {
  it("sends the compiled action with its interaction and revision", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    const onAction = vi.fn();
    await act(async () => {
      root.render(<A2uiNativeSurface block={block} messages={messages} onAction={onAction} />);
    });
    const button = host.querySelector("button");
    expect(button).toBeTruthy();
    await act(async () => {
      button?.click();
    });
    expect(onAction).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "interaction.action.send",
        context: { interactionId: "ix-1", revision: 3 },
      }),
    );
  });
});
