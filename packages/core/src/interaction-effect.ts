import { isEmailComposeIntent } from "./interaction-capability.js";

/** ExternalEffect binding for a confirmed Interaction draft. No new approval table. */

export function interactionConfirmIdempotencyKey(
  interactionId: string,
  confirmedVersion: number,
): string {
  return `a2ui:interaction:${interactionId}:confirm:${confirmedVersion}`;
}

/** Email compose confirms a send. Other intents record a neutral confirmation. */
export function interactionEffectKind(intent: string): "email.send" | "interaction.confirm" {
  if (isEmailComposeIntent(intent)) return "email.send";
  return "interaction.confirm";
}

export function interactionConfirmEffectRequest(input: {
  interactionId: string;
  intent: string;
  draftVersion: number;
  confirmedVersion: number;
  slots: Record<string, unknown>;
}): {
  interactionId: string;
  intent: string;
  draftVersion: number;
  confirmedVersion: number;
  slots: Record<string, unknown>;
} {
  return {
    interactionId: input.interactionId,
    intent: input.intent,
    draftVersion: input.draftVersion,
    confirmedVersion: input.confirmedVersion,
    slots: { ...input.slots },
  };
}

export function confirmedEffectMatchesDraft(
  request: { draftVersion?: unknown; confirmedVersion?: unknown },
  state: { draftVersion: number; confirmedVersion: number | null },
): boolean {
  return (
    state.confirmedVersion !== null &&
    request.draftVersion === state.draftVersion &&
    request.confirmedVersion === state.confirmedVersion &&
    state.confirmedVersion === state.draftVersion
  );
}
