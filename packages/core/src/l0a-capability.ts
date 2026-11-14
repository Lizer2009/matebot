import type { MessageBlock } from "@matebot/contracts";
import type { InteractionStatus } from "./interaction-status.js";

/**
 * L0-A interactive blocks share the interaction kernel without becoming A2UI
 * form capabilities.
 *
 * Spec §3.3.2: `choice` / `ask` / `app_connect` / `connect` / `mcp_approval`
 * stay as views of one Interaction row. Intent prefixes (`connect.` /
 * `approval.` / `question.`) occupy the action-card unique index. The A2UI
 * registry stays the four product intents.
 */

export type L0aBlockKind = "choice" | "ask" | "app_connect" | "connect" | "mcp_approval";

export type L0aBlock = Extract<MessageBlock, { kind: L0aBlockKind }>;

export type L0aIntentOptions = {
  /** Named reconnect (AC-23): two accounts of one provider get two card keys. */
  accountId?: string;
};

export type L0aLegacyStatus = "pending" | "connected" | "answered" | "dismissed";

const SUCCESS_STATUSES = new Set(["sent", "executed", "succeeded", "confirmed"]);

export function isL0aIntent(intent: string): boolean {
  return (
    intent.startsWith("connect.") || intent.startsWith("approval.") || intent.startsWith("question.")
  );
}

export function l0aCardKindForIntent(intent: string): "action" | undefined {
  return isL0aIntent(intent) ? "action" : undefined;
}

export function l0aScene(intent: string): "connect" | "approval" | "question" | undefined {
  if (intent.startsWith("connect.")) return "connect";
  if (intent.startsWith("approval.")) return "approval";
  if (intent.startsWith("question.")) return "question";
  return undefined;
}

export function l0aIntentForBlock(block: L0aBlock, options?: L0aIntentOptions): string {
  switch (block.kind) {
    case "app_connect":
      return connectIntent(block.provider, options?.accountId);
    case "connect":
      return connectIntent(block.name, options?.accountId);
    case "mcp_approval":
      return `approval.mcp.${block.serverId}`;
    case "ask":
      return block.approvalEffectId
        ? `approval.effect.${block.approvalEffectId}`
        : "question.clarify";
    case "choice":
      return "question.clarify";
  }
}

export function isL0aBlock(block: MessageBlock): block is L0aBlock {
  return (
    block.kind === "choice" ||
    block.kind === "ask" ||
    block.kind === "app_connect" ||
    block.kind === "connect" ||
    block.kind === "mcp_approval"
  );
}

export function derivedL0aBlockStatus(
  kind: Exclude<L0aBlockKind, "choice">,
  kernelStatus: string,
): L0aLegacyStatus {
  if (kind === "mcp_approval") {
    if (kernelStatus === "cancelled") return "dismissed";
    if (SUCCESS_STATUSES.has(kernelStatus)) return "connected";
    return "pending";
  }
  if (kind === "ask") {
    if (SUCCESS_STATUSES.has(kernelStatus) || kernelStatus === "cancelled") return "answered";
    return "pending";
  }
  if (SUCCESS_STATUSES.has(kernelStatus)) return "connected";
  return "pending";
}

function connectIntent(provider: string, accountId?: string): string {
  const slug = provider.trim().toLowerCase();
  return accountId ? `connect.${slug}.${accountId}` : `connect.${slug}`;
}

/** Stamp the kernel row onto a live L0-A view and derive the legacy block status. */
export function stampL0aBlock<T extends L0aBlock>(
  block: T,
  input: { interactionId: string; cardStatus: InteractionStatus },
): T {
  if (block.kind === "choice") {
    return { ...block, interactionId: input.interactionId, cardStatus: input.cardStatus };
  }
  return {
    ...block,
    interactionId: input.interactionId,
    cardStatus: input.cardStatus,
    status: derivedL0aBlockStatus(block.kind, input.cardStatus),
  };
}
