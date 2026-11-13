import { expireDueInteractions } from "@matebot/adapters";
import type { PrismaClient } from "@matebot/db";
import { asSystem } from "@matebot/db";
import type { SeededSurface } from "./e2e-seed-expired-surface.js";
import { inspectSeededSurface } from "./e2e-seed-expired-surface.js";

/**
 * Isolated live helper: put a card into `awaiting_approval` with a past
 * `expiresAt`, without settling it. The production closer then has something
 * due to expire. This is not a labeled `expired` seed.
 */
export async function markAwaitingApprovalExpired(
  prisma: PrismaClient,
  interactionId: string,
  expiresAt: Date = new Date(Date.now() - 60_000),
): Promise<SeededSurface> {
  const system = asSystem(prisma, "isolated e2e mark approval expired");
  const row = await system.interaction.findUnique({ where: { id: interactionId } });
  if (!row) throw new Error(`missing interaction ${interactionId}`);
  await system.interaction.update({
    where: { id: interactionId },
    data: { status: "awaiting_approval", expiresAt, staleAt: null },
  });
  return inspectSeededSurface(prisma, interactionId);
}

/** Run the production expiry closer against the isolated database. */
export async function expireDueLiveInteractions(
  prisma: PrismaClient,
  interactionId?: string,
): Promise<{ expired: string[]; surface?: SeededSurface }> {
  const system = asSystem(prisma, "isolated e2e expire due interactions");
  const result = await expireDueInteractions(system, {
    ...(interactionId ? { interactionId } : {}),
  });
  return {
    ...result,
    ...(interactionId ? { surface: await inspectSeededSurface(prisma, interactionId) } : {}),
  };
}
