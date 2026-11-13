// @vitest-environment jsdom

import { compileInteractionSurface } from "@matebot/a2ui-adapter";
import type { A2uiSurfaceBlock } from "@matebot/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { A2uiNativeSurface } from "../components/thread/a2ui-native-surface";

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
    accessibilityLabel,
  }: {
    value?: string;
    testID?: string;
    accessibilityLabel?: string;
    onChangeText?: (value: string) => void;
  }) => (
    <input
      aria-label={accessibilityLabel}
      data-testid={testID}
      value={value}
      onChange={(event) => onChangeText?.(event.target.value)}
    />
  ),
  Pressable: ({
    children,
    onPress,
    testID,
  }: {
    children?: ReactNode;
    testID?: string;
    onPress?: () => void;
  }) => (
    <button type="button" data-testid={testID} onClick={() => onPress?.()}>
      {children}
    </button>
  ),
}));

const block = {
  kind: "a2ui_surface",
  interactionId: "ix-1",
  surfaceId: "surf-1",
  protocolFamily: "v0_9",
  draftVersion: 1,
  intent: "email.compose",
} satisfies A2uiSurfaceBlock;

function text(id: string): string {
  return document.querySelector(`[data-testid="${id}"]`)?.textContent ?? "";
}

function click(id: string) {
  const node = document.querySelector(`[data-testid="${id}"]`);
  if (!(node instanceof HTMLElement)) throw new Error(`missing ${id}`);
  node.click();
}

function type(id: string, value: string) {
  const node = document.querySelector(`[data-testid="${id}"]`);
  if (!(node instanceof HTMLInputElement)) throw new Error(`missing ${id}`);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(node, value);
  node.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("native A2UI surface", () => {
  let root: Root;
  let host: HTMLDivElement;

  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
  });

  function render(node: ReactNode) {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root.render(node));
  }

  it("keeps the email form inside the thread card", () => {
    render(<A2uiNativeSurface block={block} />);
    const surface = document.querySelector('[data-testid="a2ui-native-surface"]');
    expect(surface).not.toBeNull();
    expect(surface?.querySelector('[data-testid="a2ui-native-sheet"]')).not.toBeNull();
    expect(surface?.querySelector('[data-testid="a2ui-email-to"]')).not.toBeNull();
    expect(surface?.querySelector('[data-testid="a2ui-email-subject"]')).not.toBeNull();
    expect(surface?.querySelector('[data-testid="a2ui-email-body"]')).not.toBeNull();
    expect(surface?.querySelector('[data-testid="a2ui-email-send"]')).not.toBeNull();
  });

  it("hints that a live card may have a newer version without hiding Send", () => {
    render(<A2uiNativeSurface block={{ ...block, stale: true, status: "ready_for_review" }} />);
    expect(text("a2ui-surface-stale-hint")).toBe("There may be a newer version");
    expect(document.querySelector('[data-testid="a2ui-email-send"]')).not.toBeNull();
  });

  it("sends with confirm+execute in one gesture when confirmation is missing", async () => {
    const onConfirm = vi.fn(async () => undefined);
    const onSend = vi.fn(async () => undefined);
    render(<A2uiNativeSurface block={block} onConfirm={onConfirm} onSend={onSend} />);
    expect(text("a2ui-email-status")).toBe("Needs approval");
    expect(document.querySelector('[data-testid="a2ui-email-confirm"]')).toBeNull();
    await act(async () => {
      click("a2ui-email-send");
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onConfirm).toHaveBeenCalledWith(1);
    expect(onSend).toHaveBeenCalledWith(1);
    expect(document.querySelector('[data-testid="a2ui-email-sent"]')).toBeNull();
  });

  it("sends a draft that is already confirmed without confirming again", async () => {
    const onConfirm = vi.fn(async () => undefined);
    const onSend = vi.fn(async () => undefined);
    render(
      <A2uiNativeSurface
        block={{ ...block, confirmedVersion: 1 }}
        onConfirm={onConfirm}
        onSend={onSend}
      />,
    );
    await act(async () => {
      click("a2ui-email-send");
      await Promise.resolve();
    });
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onSend).toHaveBeenCalledWith(1);
    expect(document.querySelector('[data-testid="a2ui-email-sent"]')).toBeNull();
  });

  it("does not paint Sent until the server success stamp arrives", async () => {
    let finishSend!: () => void;
    const onSend = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishSend = resolve;
        }),
    );
    render(
      <A2uiNativeSurface
        block={{ ...block, confirmedVersion: 1, capability: "ready" }}
        onSend={onSend}
      />,
    );
    await act(async () => {
      click("a2ui-email-send");
    });
    expect(text("a2ui-email-progress")).toBe("Sending email");
    expect(document.querySelector('[data-testid="a2ui-email-sent"]')).toBeNull();
    await act(async () => {
      finishSend();
      await Promise.resolve();
    });
    expect(document.querySelector('[data-testid="a2ui-email-sent"]')).toBeNull();
    act(() => root.unmount());
    host.remove();
    render(
      <A2uiNativeSurface
        block={{
          ...block,
          confirmedVersion: 1,
          template: "action-result-success",
          lifecycle: "succeeded",
          providerMessageId: "msg-1",
        }}
      />,
    );
    expect(document.body.textContent).toContain("Done");
    expect(document.querySelector('[data-testid="a2ui-email-compose"]')).toBeNull();
  });

  it("shows a failed card without Sent when send is an internal error", async () => {
    const onSend = vi.fn(async () => {
      throw new Error("Internal server error");
    });
    render(
      <A2uiNativeSurface
        block={{ ...block, confirmedVersion: 1, capability: "ready" }}
        onSend={onSend}
      />,
    );
    await act(async () => {
      click("a2ui-email-send");
      await Promise.resolve();
    });
    expect(document.querySelector('[data-testid="a2ui-email-sent"]')).toBeNull();
    expect(text("a2ui-email-error")).toBe("Internal server error");
    act(() => root.unmount());
    host.remove();
    render(
      <A2uiNativeSurface
        block={{
          ...block,
          template: "action-result-failed",
          lifecycle: "failed",
          error: "Internal server error",
        }}
        onSend={onSend}
      />,
    );
    expect(document.body.textContent).toContain("Failed");
    expect(document.querySelector('[data-testid="a2ui-email-compose"]')).toBeNull();
    expect(document.querySelector('[data-testid="a2ui-email-send"]')).toBeNull();
  });

  it("commits edited fields before send confirms", async () => {
    const onFieldChange = vi.fn(async () => ({ draftVersion: 2 }));
    const onConfirm = vi.fn(async () => undefined);
    const onSend = vi.fn(async () => undefined);
    render(
      <A2uiNativeSurface
        block={block}
        onFieldChange={onFieldChange}
        onConfirm={onConfirm}
        onSend={onSend}
      />,
    );
    await act(async () => {
      type("a2ui-email-subject", "Hello again");
    });
    await act(async () => {
      click("a2ui-email-send");
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onFieldChange).toHaveBeenCalledWith("subject", "Hello again", 1);
    expect(onConfirm).toHaveBeenCalledWith(2);
    expect(onSend).toHaveBeenCalledWith(2);
  });

  it("shows connect and hides Send when the mailbox is not connected", () => {
    const onConnect = vi.fn(async () => undefined);
    const onSend = vi.fn(async () => undefined);
    render(
      <A2uiNativeSurface
        block={{ ...block, capability: "not_connected" }}
        onConnect={onConnect}
        onSend={onSend}
      />,
    );
    expect(document.querySelector('[data-testid="a2ui-email-connect"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="a2ui-email-send"]')).toBeNull();
  });

  it("shows reauth and hides Send when the mailbox needs reconnect", () => {
    render(
      <A2uiNativeSurface
        block={{ ...block, capability: "requires_reauth" }}
        onSend={vi.fn(async () => undefined)}
      />,
    );
    expect(document.querySelector('[data-testid="a2ui-email-reauth"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="a2ui-email-send"]')).toBeNull();
    expect(text("a2ui-email-status")).toBe("Authorization expired");
  });

  // The live failure: the send died on a revoked authorization, so the card has
  // to offer reconnect rather than a Retry that would fail the same way.
  it("offers reconnect after a send failed on a dead authorization", () => {
    render(
      <A2uiNativeSurface
        block={{
          ...block,
          capability: "requires_reauth",
          template: "email-reauth-card",
          lifecycle: "failed",
          error: "The gmail connection is no longer active. Ask the user to reconnect gmail.",
        }}
        onConnect={vi.fn(async () => undefined)}
        onSend={vi.fn(async () => undefined)}
      />,
    );
    expect(document.querySelector('[data-testid="a2ui-email-reauth"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="a2ui-email-retry"]')).toBeNull();
    expect(document.querySelector('[data-testid="a2ui-email-send"]')).toBeNull();
  });

  it("labels an unconnected surface as not connected", () => {
    render(
      <A2uiNativeSurface
        block={{ ...block, capability: "not_connected" }}
        onConnect={vi.fn(async () => undefined)}
        onSend={vi.fn(async () => undefined)}
      />,
    );
    expect(text("a2ui-email-status")).toBe("Not connected");
    // The card is asking for a mailbox, so it must not also name one.
    expect(document.querySelector('[data-testid="a2ui-email-sender"]')).toBeNull();
  });

  it("shows the sending account as a read-only row, never as an address", () => {
    render(
      <A2uiNativeSurface
        block={{ ...block, capability: "ready", senderLabel: "Gmail" }}
        onSend={vi.fn(async () => undefined)}
      />,
    );
    expect(text("a2ui-email-sender")).toBe("Gmail");
    expect(document.querySelector('[data-testid="a2ui-email-sender-note"]')).toBeNull();
    expect(document.body.textContent).not.toMatch(/Email address not provided/);
    // Read-only: the sending mailbox is not one of the form's inputs.
    expect(document.querySelector('input[aria-label="From"]')).toBeNull();
  });

  it("shows the provider mailbox when the block carries one", () => {
    render(
      <A2uiNativeSurface
        block={{
          ...block,
          capability: "ready",
          senderLabel: "Gmail",
          senderAddress: "lizer@example.test",
        }}
        onSend={vi.fn(async () => undefined)}
      />,
    );
    expect(text("a2ui-email-sender")).toBe("lizer@example.test");
  });

  it("shows progress without Send", () => {
    render(
      <A2uiNativeSurface
        block={{
          ...block,
          capability: "ready",
          template: "action-progress-card",
          lifecycle: "executing",
        }}
        onSend={vi.fn(async () => undefined)}
      />,
    );
    expect(text("a2ui-email-progress")).toBe("Sending email");
    expect(document.querySelector('[data-testid="a2ui-email-send"]')).toBeNull();
  });

  it("shows success without the provider message id", () => {
    render(
      <A2uiNativeSurface
        block={{
          ...block,
          template: "action-result-success",
          lifecycle: "succeeded",
          providerMessageId: "msg-1",
        }}
      />,
    );
    expect(document.body.textContent).toContain("Done");
    expect(document.querySelector('[data-testid="a2ui-email-compose"]')).toBeNull();
    expect(document.querySelector('[data-testid="a2ui-email-provider-id"]')).toBeNull();
    expect(document.body.textContent).not.toContain("msg-1");
    expect(document.querySelector('[data-testid="a2ui-email-send"]')).toBeNull();
  });

  it("opens Manage rules from the approval menu", async () => {
    const onManageRules = vi.fn();
    const onSend = vi.fn(async () => undefined);
    render(
      <A2uiNativeSurface
        block={{ ...block, capability: "ready" }}
        onManageRules={onManageRules}
        onSend={onSend}
      />,
    );
    expect(text("a2ui-email-status")).toBe("Needs approval");
    await act(async () => {
      click("a2ui-email-status");
    });
    expect(text("a2ui-email-approval-require")).toBe("Needs approval");
    await act(async () => {
      click("a2ui-email-manage-rules");
    });
    expect(onManageRules).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="a2ui-email-send"]')).not.toBeNull();
  });

  it("hides Manage rules when no settings opener is passed", async () => {
    render(<A2uiNativeSurface block={{ ...block, capability: "ready" }} />);
    await act(async () => {
      click("a2ui-email-status");
    });
    expect(document.querySelector('[data-testid="a2ui-email-manage-rules"]')).toBeNull();
    expect(text("a2ui-email-approval-require")).toBe("Needs approval");
  });

  it("shows failed with Retry and no Send", async () => {
    const onRetry = vi.fn(async () => undefined);
    const onSend = vi.fn(async () => undefined);
    render(
      <A2uiNativeSurface
        block={{
          ...block,
          status: "failed",
          template: "action-result-failed",
          lifecycle: "failed",
          error: "Could not send the email",
        }}
        onSend={onSend}
        onRetry={onRetry}
      />,
    );
    expect(document.body.textContent).toContain("Failed");
    expect(document.querySelector('[data-testid="a2ui-email-send"]')).toBeNull();
    await act(async () => {
      click("a2ui-surface-retry");
      await Promise.resolve();
    });
    expect(onRetry).toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("shows UNKNOWN with Check status and no Send", async () => {
    const onCheckStatus = vi.fn(async () => undefined);
    const onSend = vi.fn(async () => undefined);
    render(
      <A2uiNativeSurface
        block={{
          ...block,
          template: "action-reconcile-card",
          lifecycle: "unknown",
        }}
        onCheckStatus={onCheckStatus}
        onSend={onSend}
      />,
    );
    expect(text("a2ui-email-unknown")).toBe("Don't send again");
    expect(document.querySelector('[data-testid="a2ui-email-send"]')).toBeNull();
    await act(async () => {
      click("a2ui-email-check-status");
      await Promise.resolve();
    });
    expect(onCheckStatus).toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("discards without sending", async () => {
    const onDiscard = vi.fn(async () => undefined);
    const onSend = vi.fn(async () => undefined);
    render(<A2uiNativeSurface block={block} onDiscard={onDiscard} onSend={onSend} />);
    await act(async () => {
      click("a2ui-email-discard");
      await Promise.resolve();
    });
    expect(onDiscard).toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
    expect(text("a2ui-email-compose")).toBe("Discarded");
  });

  it("shows the catalog and refuses an unknown component", () => {
    const messages = [
      {
        updateComponents: {
          components: [
            { id: "sheet", component: "Sheet", label: "More", children: ["title", "field", "go"] },
            { id: "title", component: "Text", text: "Hello" },
            { id: "field", component: "TextField", label: "Note", value: "Body" },
            { id: "go", component: "Button", text: "Go" },
          ],
        },
      },
    ];
    const plain = { ...block, intent: undefined };
    render(<A2uiNativeSurface block={plain} messages={messages} />);
    expect(
      document.querySelector('[data-testid="a2ui-native-field-field"]')?.getAttribute("aria-label"),
    ).toBe("Note");
    expect(text("a2ui-native-button-go")).toBe("Go");
    expect(host.textContent).toContain("Hello");
    expect(document.querySelector('[data-testid="a2ui-native-sheet"]')).not.toBeNull();

    act(() =>
      root.render(
        <A2uiNativeSurface
          block={plain}
          messages={[
            { updateComponents: { components: [{ id: "bad", component: "EvilWidget" }] } },
          ]}
        />,
      ),
    );
    expect(text("a2ui-native-refused")).toBe("EvilWidget");
  });

  const resultBlock = {
    kind: "a2ui_surface",
    interactionId: "ix-r",
    surfaceId: "surf-r",
    protocolFamily: "v0_9",
    draftVersion: 1,
    intent: "interaction.result",
    title: "Quarterly totals",
  } satisfies A2uiSurfaceBlock;

  it("draws every cell of a result table and its provenance", async () => {
    // The component renders the compiled document, so the document is what the
    // test compiles — the same one the server would publish.
    const compiled = await compileInteractionSurface({
      schema: { schemaVersion: 1, presentation: "result", fields: [], action: null },
      values: {},
      surfaceId: "surf-r",
      result: {
        title: "Quarterly totals",
        provenance: {
          source: "Upload: sample-quarters.csv",
          asOf: "2026-11-06T00:00:00.000Z",
          window: { from: "2026-01-01", to: "2026-12-31" },
          units: "CNY",
        },
        columns: [
          { key: "quarter", label: "Quarter" },
          { key: "total", label: "Total" },
        ],
        rows: [
          { quarter: "Q1", total: 2000.5 },
          { quarter: "Q2", total: 1500 },
        ],
        truncated: false,
        totalRows: 2,
        empty: false,
      },
    });
    if (!compiled.ok) throw new Error(compiled.error);
    render(<A2uiNativeSurface block={resultBlock} messages={compiled.messages} />);
    const body = document.body.textContent ?? "";
    for (const value of ["Quarter", "Total", "Q1", "2000.5", "Q2", "1500"]) {
      expect(body).toContain(value);
    }
    // Provenance must survive on the phone, not only on web.
    expect(body).toContain("sample-quarters.csv");
    expect(body).toContain("CNY");
    // A result offers nothing to send.
    expect(document.querySelector('[data-testid="a2ui-email-send"]')).toBeNull();
  });
});
