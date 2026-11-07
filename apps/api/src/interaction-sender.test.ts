import { describe, expect, it, vi } from "vitest";
import { resolveInteractionSender } from "./interaction-sender.js";

/**
 * The execute path used to hard-code `email.send`, so a calendar effect would be
 * reported as "not executed" and silently do nothing. This resolves the sender
 * for whichever capability the effect belongs to, and refuses an effect it has
 * no sender for rather than pretending.
 */

const context = { signal: new AbortController().signal } as never;

function deps() {
  return {
    connector: { execute: vi.fn() } as never,
    createCalendarSender: vi.fn(),
    createEmailSender: vi.fn(),
  };
}

describe("resolveInteractionSender", () => {
  it("routes an email effect to the mailbox sender", () => {
    const d = deps();
    const sender = { kind: "connector" as const };
    d.createEmailSender.mockReturnValue(sender);
    expect(
      resolveInteractionSender(d, { kind: "email.send", connectionId: "conn-1", context }),
    ).toMatchObject({ unsupported: false, sender });
    expect(d.createCalendarSender).not.toHaveBeenCalled();
  });

  it("routes a calendar effect to the calendar sender", () => {
    const d = deps();
    const sender = { kind: "connector" as const };
    d.createCalendarSender.mockReturnValue(sender);
    expect(
      resolveInteractionSender(d, { kind: "calendar.create", connectionId: "conn-2", context }),
    ).toMatchObject({ unsupported: false, sender });
    expect(d.createEmailSender).not.toHaveBeenCalled();
  });

  // A kind with no sender must be refused, not reported as executed.
  it("refuses an effect kind it has no sender for", () => {
    const d = deps();
    expect(
      resolveInteractionSender(d, { kind: "interaction.confirm", connectionId: null, context }),
    ).toMatchObject({ unsupported: true });
  });

  it("refuses when no connection is available", () => {
    const d = deps();
    expect(
      resolveInteractionSender(d, { kind: "calendar.create", connectionId: null, context }),
    ).toMatchObject({ unsupported: true });
  });
});
