// @vitest-environment jsdom
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmailComposeEditor } from "./EmailComposeEditor";

/**
 * Typed text survives a re-render that arrives while the commit is in flight.
 *
 * The browser showed the subject field falling back to its old value right after
 * the person typed into it: the write had been sent, the parent re-rendered from a
 * snapshot that did not have the new text yet, and the editor adopted that snapshot
 * wholesale. React state alone cannot hold the value, because the snapshot is newer
 * than the render that produced the state.
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

const fields = (subject: string) => ({
  from: "bot@example.test",
  to: "a@example.test",
  cc: "",
  subject,
  body: "Hello",
});

function subjectInput(): HTMLInputElement {
  const input = container.querySelector('[data-testid="a2ui-email-subject"]');
  if (!input) throw new Error("no subject input");
  return input as HTMLInputElement;
}

function setValue(element: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(element, value);
}

describe("a field the person typed", () => {
  it("keeps the typed text when a stale snapshot arrives before the commit lands", async () => {
    const onFieldChange = vi.fn(
      () => new Promise<{ draftVersion: number } | undefined>(() => undefined),
    );
    act(() =>
      root.render(
        <EmailComposeEditor draftVersion={1} fields={fields("Hi")} onFieldChange={onFieldChange} />,
      ),
    );

    // The person types.
    const input = subjectInput();
    await act(async () => {
      setValue(input, "我写的主题");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(subjectInput().value).toBe("我写的主题");

    // A snapshot from before the commit arrives, with the old subject in it.
    await act(async () => {
      root.render(
        <EmailComposeEditor draftVersion={1} fields={fields("Hi")} onFieldChange={onFieldChange} />,
      );
    });
    expect(subjectInput().value).toBe("我写的主题");

    // Blurring sends it. The write is still in flight when another stale snapshot lands.
    await act(async () => {
      subjectInput().dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      root.render(
        <EmailComposeEditor draftVersion={1} fields={fields("Hi")} onFieldChange={onFieldChange} />,
      );
    });
    expect(onFieldChange).toHaveBeenCalledWith("subject", "我写的主题", 1);
    expect(subjectInput().value).toBe("我写的主题");
  });

  it("follows the server for a field the person did not edit", async () => {
    const onFieldChange = vi.fn(async () => ({ draftVersion: 2 }));
    act(() =>
      root.render(
        <EmailComposeEditor draftVersion={1} fields={fields("Hi")} onFieldChange={onFieldChange} />,
      ),
    );
    // A model edit changes the subject; the person never touched it, so it applies.
    await act(async () => {
      root.render(
        <EmailComposeEditor
          draftVersion={2}
          fields={fields("Model subject")}
          onFieldChange={onFieldChange}
        />,
      );
    });
    expect(subjectInput().value).toBe("Model subject");
  });
});
