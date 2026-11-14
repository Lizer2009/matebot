-- AC-4: Interaction.status is the thirteen-value kernel vocabulary, not a free string.
-- executing/submitting were a runtime lifecycle written onto the row; they are not
-- kernel statuses. Map them to ready_for_review so an in-flight card keeps occupying
-- the open-card slot. Never mark them succeeded — that would invent a send.

UPDATE "interactions"
SET "status" = 'ready_for_review'
WHERE "status" IN ('executing', 'submitting');

UPDATE "interactions"
SET "status" = 'unknown'
WHERE "status" NOT IN (
  'collecting',
  'ready_for_review',
  'awaiting_approval',
  'needs_connection',
  'unknown',
  'sent',
  'executed',
  'succeeded',
  'confirmed',
  'superseded',
  'expired',
  'failed',
  'cancelled'
);

-- After the remap, two open rows can share a key (the in-flight hole). Keep the
-- newest; supersede the rest. Do not delete.
WITH ranked AS (
  SELECT "id",
         ROW_NUMBER() OVER (
           PARTITION BY "cardKey"
           ORDER BY "updatedAt" DESC, "id" DESC
         ) AS rn
  FROM "interactions"
  WHERE "status" IN ('collecting', 'ready_for_review', 'awaiting_approval')
    AND "cardKey" IS NOT NULL
)
UPDATE "interactions" AS i
SET "status" = 'superseded'
FROM ranked AS r
WHERE i."id" = r."id" AND r.rn > 1;

ALTER TABLE "interactions"
  ADD CONSTRAINT "interactions_status_kernel_check"
  CHECK ("status" IN (
    'collecting',
    'ready_for_review',
    'awaiting_approval',
    'needs_connection',
    'unknown',
    'sent',
    'executed',
    'succeeded',
    'confirmed',
    'superseded',
    'expired',
    'failed',
    'cancelled'
  ));
