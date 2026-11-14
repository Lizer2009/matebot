import type { Prisma, PrismaClient } from "./client.js";

export const INTERACTION_EVENT_KINDS = [
  "published",
  "amended",
  "settled",
  "dispatch_requested",
  "dispatch_rejected",
  "revived",
] as const;

export type InteractionEventKind = (typeof INTERACTION_EVENT_KINDS)[number];

export type AppendInteractionEventInput = {
  interactionId: string;
  kind: InteractionEventKind;
  fromStatus?: string | null;
  toStatus?: string | null;
  reason?: string | null;
  runId?: string | null;
};

type EventWriter = {
  interactionEvent: {
    create: PrismaClient["interactionEvent"]["create"];
  };
};

/**
 * Append one card-history row. There is no update helper: the table is a log.
 */
export async function appendInteractionEvent(
  prisma: EventWriter | Prisma.TransactionClient,
  input: AppendInteractionEventInput,
): Promise<void> {
  await prisma.interactionEvent.create({
    data: {
      interactionId: input.interactionId,
      kind: input.kind,
      fromStatus: input.fromStatus ?? null,
      toStatus: input.toStatus ?? null,
      reason: input.reason ?? null,
      runId: input.runId ?? null,
    },
  });
}
