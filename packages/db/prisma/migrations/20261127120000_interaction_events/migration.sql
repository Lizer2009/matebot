-- Append-only card history (spec §4.5). Additive; older releases never read it.
CREATE TABLE "interaction_events" (
    "id" TEXT NOT NULL,
    "interactionId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT,
    "reason" TEXT,
    "runId" TEXT,

    CONSTRAINT "interaction_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "interaction_events_interactionId_at_idx" ON "interaction_events"("interactionId", "at");

ALTER TABLE "interaction_events" ADD CONSTRAINT "interaction_events_interactionId_fkey"
  FOREIGN KEY ("interactionId") REFERENCES "interactions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "interaction_events" ENABLE ROW LEVEL SECURITY;
CREATE POLICY interaction_events_tenant ON "interaction_events"
  USING (EXISTS (
    SELECT 1 FROM "interactions" i
    WHERE i."id" = "interaction_events"."interactionId"
      AND i."spaceId" = NULLIF(current_setting('app.space_id', true), '')
  ));
CREATE POLICY interaction_events_system ON "interaction_events"
  USING ((SELECT app_rls_bypass()));

-- Default privileges grant UPDATE/DELETE on new tables. This log is insert-only.
REVOKE UPDATE, DELETE ON "interaction_events" FROM matebot_app;
GRANT SELECT, INSERT ON "interaction_events" TO matebot_app;
