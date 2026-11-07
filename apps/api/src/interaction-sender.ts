import type { AdapterContext } from "@matebot/adapter-kit";
import type { InteractionCalendarSender, InteractionEmailSender } from "@matebot/adapters";

/**
 * Which sender an effect of a given kind should use.
 *
 * The execute service used to hard-code `email.send`, which meant any other
 * capability quietly reported "not executed". This makes the choice explicit and
 * refuses a kind with no sender, so adding a domain is a registry entry plus a
 * sender rather than a silent no-op.
 */

export type InteractionSenderResult =
  | { unsupported: false; sender: InteractionEmailSender | InteractionCalendarSender }
  | { unsupported: true; reason: "no_sender_for_kind" | "no_connection" };

export type InteractionSenderDeps = {
  createEmailSender: (input: {
    connectionId: string;
    context: AdapterContext;
  }) => InteractionEmailSender;
  createCalendarSender: (input: {
    connectionId: string;
    context: AdapterContext;
  }) => InteractionCalendarSender;
};

export function resolveInteractionSender(
  deps: InteractionSenderDeps,
  input: { kind: string; connectionId: string | null | undefined; context: AdapterContext },
): InteractionSenderResult {
  if (!input.connectionId) return { unsupported: true, reason: "no_connection" };
  if (input.kind === "email.send") {
    return {
      unsupported: false,
      sender: deps.createEmailSender({ connectionId: input.connectionId, context: input.context }),
    };
  }
  if (input.kind === "calendar.create") {
    return {
      unsupported: false,
      sender: deps.createCalendarSender({
        connectionId: input.connectionId,
        context: input.context,
      }),
    };
  }
  // A recorded confirmation with no external effect, or a kind this build does
  // not know: neither may be reported as executed.
  return { unsupported: true, reason: "no_sender_for_kind" };
}
