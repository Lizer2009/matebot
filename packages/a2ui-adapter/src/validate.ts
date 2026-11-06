import type { A2uiProtocolFamily } from "@matebot/contracts";
import { DEFAULT_PROTOCOL_FAMILY } from "./protocol.js";
import { isV09Module, loadWebCoreSchemas } from "./web-core.js";

export type ValidateA2uiMessagesInput = {
  messages: unknown;
  protocolFamily?: A2uiProtocolFamily;
};

export type ValidateA2uiMessagesResult =
  | { ok: true; protocolFamily: A2uiProtocolFamily; messages: unknown }
  | { ok: false; protocolFamily: A2uiProtocolFamily; error: string };

/**
 * Schema-validate an A2UI server→client / agent→renderer message list
 * for the requested protocol family (dual-track).
 */
export async function validateA2uiMessages(
  input: ValidateA2uiMessagesInput,
): Promise<ValidateA2uiMessagesResult> {
  const protocolFamily = input.protocolFamily ?? DEFAULT_PROTOCOL_FAMILY;
  const mod = await loadWebCoreSchemas(protocolFamily);

  if (isV09Module(mod)) {
    const parsed = mod.A2uiMessageListSchema.safeParse(input.messages);
    if (!parsed.success) {
      return {
        ok: false,
        protocolFamily,
        error: parsed.error?.message ?? "v0_9 message list failed schema validation",
      };
    }
    return { ok: true, protocolFamily, messages: parsed.data };
  }

  if (!Array.isArray(input.messages)) {
    return {
      ok: false,
      protocolFamily,
      error: "v1_0 messages must be an array of agent→renderer messages",
    };
  }

  const messages: unknown[] = [];
  for (let i = 0; i < input.messages.length; i += 1) {
    const parsed = mod.AgentToRendererMessageSchema.safeParse(input.messages[i]);
    if (!parsed.success) {
      return {
        ok: false,
        protocolFamily,
        error: parsed.error?.message ?? `v1_0 message at index ${i} failed schema validation`,
      };
    }
    messages.push(parsed.data);
  }

  return { ok: true, protocolFamily, messages };
}

/** Validate a single message (useful for incremental streams). */
export async function validateA2uiMessage(
  message: unknown,
  protocolFamily: A2uiProtocolFamily = DEFAULT_PROTOCOL_FAMILY,
): Promise<ValidateA2uiMessagesResult> {
  return validateA2uiMessages({ messages: [message], protocolFamily });
}
