-- One action card per thread per intent, enforced by the database.
-- Additive: older releases never read these columns.

ALTER TABLE "interactions" ADD COLUMN "cardKey" TEXT;
ALTER TABLE "interactions" ADD COLUMN "staleAt" TIMESTAMP(3);
ALTER TABLE "interactions" ADD COLUMN "expiresAt" TIMESTAMP(3);

-- Backfill with the same digest the application computes, so old and new rows
-- share one identity. `sha256(bytea)` is built into PostgreSQL 11+. The bytes are
-- assembled with convert_to so no text value ever holds a NUL (PostgreSQL forbids
-- one): UTF-8 thread id, one 0x00 byte, UTF-8 intent.
UPDATE "interactions"
SET "cardKey" = encode(sha256(convert_to("threadId", 'UTF8') || '\x00'::bytea || convert_to("intent", 'UTF8')), 'hex')
WHERE "cardKey" IS NULL;

-- Historical duplicates: keep the newest live card per key and supersede the rest.
-- `needs_connection` is included even though the index below does not cover it: the
-- open-card lookup now amends a waiting connection card in place, so it can only see
-- the newest one — an older duplicate would stay live forever. This is a one-time
-- cleanup of rows that predate the lookup, not a settlement of cards people are
-- waiting on (that exemption is runtime behaviour and stays).
WITH ranked AS (
  SELECT "id",
         ROW_NUMBER() OVER (
           PARTITION BY "cardKey"
           ORDER BY "updatedAt" DESC, "id" DESC
         ) AS rn
  FROM "interactions"
  WHERE "status" IN ('collecting', 'ready_for_review', 'awaiting_approval', 'needs_connection')
)
UPDATE "interactions" AS i
SET "status" = 'superseded'
FROM ranked AS r
WHERE i."id" = r."id" AND r.rn > 1;

-- The column stays nullable for the rollout window: the previous release keeps
-- running for seconds after this migration and does not write a key. A later
-- migration tightens it to NOT NULL once that release has drained. The partial
-- unique index below still keeps every row that has a key unique.

-- Partial unique index: exactly the three open statuses. Must stay in sync with
-- OPEN_STATUSES in packages/core/src/interaction-status.ts.
CREATE UNIQUE INDEX "interactions_one_open_card_per_intent"
  ON "interactions" ("cardKey")
  WHERE "status" IN ('collecting', 'ready_for_review', 'awaiting_approval');

CREATE INDEX "interactions_threadId_cardKey_idx"
  ON "interactions" ("threadId", "cardKey");
