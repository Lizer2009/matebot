/**
 * Turns a dispatched surface action into the existing effect path.
 *
 * A compiled button must not get its own execution route: it confirms the
 * exact revision the click came from and then runs the same execute service the
 * dedicated card uses. If either step refuses, the refusal is reported as-is so
 * the surface renders the matching state instead of an implied success.
 */

export type ConfirmResult = {
  confirmedVersion: number;
  effectId: string;
  idempotencyKey: string;
};

export type ExecuteResult = {
  effectId: string;
  idempotencyKey: string;
  duplicate: boolean;
  executed: boolean;
  providerMessageId?: string;
};

export type ConfirmThenExecuteDeps = {
  confirm: (input: {
    spaceId: string;
    threadId: string;
    botId: string;
    interactionId: string;
    draftVersion: number;
    userId: string;
  }) => Promise<ConfirmResult>;
  execute: (input: {
    spaceId: string;
    threadId: string;
    botId: string;
    interactionId: string;
    userId: string;
  }) => Promise<ExecuteResult>;
};

export type ConfirmThenExecuteInput = {
  spaceId: string;
  threadId: string;
  botId: string;
  interactionId: string;
  revision: number;
  userId: string;
  /** The capability's effect kind; null means the action has no sender yet. */
  kind: "email.send" | "calendar.create" | null;
};

/** The error code a rejected service call carries, when it has one. */
export function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && code ? code : "action_failed";
}

export async function confirmThenExecute(
  deps: ConfirmThenExecuteDeps,
  input: ConfirmThenExecuteInput,
): Promise<{ ok: true } | { ok: false; error: string }> {
  // Only an effect with a real sender may run. A result surface never gets here
  // because it declares no action; a registered-but-unimplemented one does not
  // either, since its schema has no action for the bridge to accept.
  if (input.kind === null) return { ok: false, error: "unknown_action" };

  try {
    await deps.confirm({
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: input.botId,
      interactionId: input.interactionId,
      draftVersion: input.revision,
      userId: input.userId,
    });
  } catch (error) {
    // A preflight or version refusal is the card's next state, not a success.
    return { ok: false, error: codeOf(error) };
  }

  try {
    await deps.execute({
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: input.botId,
      interactionId: input.interactionId,
      userId: input.userId,
    });
  } catch (error) {
    return { ok: false, error: codeOf(error) };
  }

  return { ok: true };
}
