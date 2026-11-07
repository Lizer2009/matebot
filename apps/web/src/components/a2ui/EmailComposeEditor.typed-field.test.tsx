// @vitest-environment jsdom
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmailComposeEditor } from "./EmailComposeEditor";

/**
 * Typed text survives a re-render, and is still saved.
 *
 * Two failures this guards, both seen in a real browser. A snapshot arriving while
 * the person is typing re-rendered the old value over their text. And a snapshot
 * arriving between typing and blur made the write look redundant, so the text stayed
 * on screen but never reached the server.
 *
 * The re-render here carries *different* props — a republish of another field — so
 * the effect actually runs. A test that re-renders with identical props asserts
 * nothing, because React bails out.
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

const fields = (subject: string, body = "Hello") => ({
  from: "bot@example.test",
  to: "a@example.test",
  cc: "",
  subject,
  body,
});

function subjectInput(): HTMLInputElement {
  const input = container.querySelector('[data-testid="a2ui-email-subject"]');
  if (!input) throw new Error("no subject input");
  return input as HTMLInputElement;
}

function setValue(element: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(element, value);
}

function render(props: {
  draftVersion: number;
  fields: ReturnType<typeof fields>;
  onFieldChange?: () => Promise<{ draftVersion: number } | undefined>;
}) {
  act(() => root.render(<EmailComposeEditor {...props} />));
}

describe("a field the person typed", () => {
  it("keeps the typed text when a snapshot of another field arrives mid-typing", async () => {
    const onFieldChange = vi.fn(
      () => new Promise<{ draftVersion: number } | undefined>(() => undefined),
    );
    render({ draftVersion: 1, fields: fields("Hi"), onFieldChange });

    const input = subjectInput();
    await act(async () => {
      setValue(input, "我写的主题");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(subjectInput().value).toBe("我写的主题");

    // A republish of a different field: the props really change, so the effect runs.
    render({ draftVersion: 2, fields: fields("Hi", "A different body"), onFieldChange });
    expect(subjectInput().value).toBe("我写的主题");
  });

  it("still saves the typed text after a republish of another field", async () => {
    const onFieldChange = vi.fn(async () => ({ draftVersion: 3 }));
    render({ draftVersion: 1, fields: fields("Hi"), onFieldChange });

    const input = subjectInput();
    await act(async () => {
      setValue(input, "我写的主题");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // The republish lands before the blur that would send it.
    render({ draftVersion: 2, fields: fields("Hi", "A different body"), onFieldChange });
    await act(async () => {
      subjectInput().dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      await Promise.resolve();
    });

    expect(onFieldChange).toHaveBeenCalledWith("subject", "我写的主题", 2);
    expect(subjectInput().value).toBe("我写的主题");
  });

  it("does not send a value the server already holds", async () => {
    const onFieldChange = vi.fn(async () => ({ draftVersion: 2 }));
    render({ draftVersion: 1, fields: fields("Hi"), onFieldChange });
    // Blur without typing an edit.
    await act(async () => {
      subjectInput().dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      await Promise.resolve();
    });
    expect(onFieldChange).not.toHaveBeenCalled();
  });

  it("follows the server for a field the person did not edit", async () => {
    const onFieldChange = vi.fn(async () => ({ draftVersion: 2 }));
    render({ draftVersion: 1, fields: fields("Hi"), onFieldChange });
    render({ draftVersion: 2, fields: fields("Model subject"), onFieldChange });
    expect(subjectInput().value).toBe("Model subject");
  });

  it("lets the server's own value win once it matches what was typed", async () => {
    const onFieldChange = vi.fn(async () => ({ draftVersion: 2 }));
    render({ draftVersion: 1, fields: fields("Hi"), onFieldChange });
    const input = subjectInput();
    await act(async () => {
      setValue(input, "Typed");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // The server echoes the typed text back: the field is no longer special.
    render({ draftVersion: 2, fields: fields("Typed"), onFieldChange });
    expect(subjectInput().value).toBe("Typed");
    // And a later model edit applies, because nothing here is unsaved.
    render({ draftVersion: 3, fields: fields("Model subject"), onFieldChange });
    expect(subjectInput().value).toBe("Model subject");
  });
});
