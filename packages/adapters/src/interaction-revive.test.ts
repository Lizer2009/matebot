import type { PrismaClient } from "@matebot/db";
import { describe, expect, it, vi } from "vitest";
import { reviveCard } from "./interaction-kernel-store.js";

const EMPTY_PLAN = {
  intent: "email.compose",
  title: "x",
  fields: [],
  nextStep: "render" as const,
  riskLevel: "low" as const,
};

function fake(row: { status: string; draftVersion: number } | null) {
  const updateMany = vi.fn().mockResolvedValue({ count: 1 });
  const findUnique = vi.fn().mockResolvedValue(
    row
      ? {
          id: "i1",
          status: row.status,
          draftVersion: row.draftVersion,
          plan: EMPTY_PLAN,
          slots: {},
        }
      : null,
  );
  return {
    prisma: { interaction: { findUnique, updateMany } } as unknown as PrismaClient,
    updateMany,
  };
}

describe("reviveCard", () => {
  it("revives an expired card with a compare-and-set on the row it read", async () => {
    const { prisma, updateMany } = fake({ status: "expired", draftVersion: 3 });
    await expect(reviveCard(prisma, { interactionId: "i1" })).resolves.toMatchObject({
      revived: true,
      draftVersion: 4,
    });
    expect(updateMany.mock.calls[0]![0].where).toEqual({
      id: "i1",
      status: "expired",
      draftVersion: 3,
    });
  });

  it("refuses every status the kernel does not allow back", async () => {
    for (const status of [
      "superseded",
      "cancelled",
      "sent",
      "succeeded",
      "executed",
      "confirmed",
      "unknown",
    ]) {
      const { prisma, updateMany } = fake({ status, draftVersion: 1 });
      await expect(reviveCard(prisma, { interactionId: "i1" }), status).resolves.toEqual({
        revived: false,
        reason: "not_revivable",
      });
      expect(updateMany, status).not.toHaveBeenCalled();
    }
  });

  it("reports a lost race instead of overwriting", async () => {
    const { prisma, updateMany } = fake({ status: "failed", draftVersion: 2 });
    updateMany.mockResolvedValue({ count: 0 });
    await expect(reviveCard(prisma, { interactionId: "i1" })).resolves.toEqual({
      revived: false,
      reason: "concurrent",
    });
  });

  it("reports a vanished row", async () => {
    const { prisma } = fake(null);
    await expect(reviveCard(prisma, { interactionId: "gone" })).resolves.toEqual({
      revived: false,
      reason: "not_found",
    });
  });
});
