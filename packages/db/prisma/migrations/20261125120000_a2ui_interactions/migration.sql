-- Additive: older releases never read or write these tables (A2UI flag default off).
CREATE TABLE "interactions" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "runId" TEXT,
    "intent" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "draftVersion" INTEGER NOT NULL DEFAULT 1,
    "confirmedVersion" INTEGER,
    "plan" JSONB NOT NULL,
    "slots" JSONB NOT NULL DEFAULT '{}',
    "title" TEXT,
    "summary" TEXT,
    "approvalEffectId" TEXT,
    "messageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "interactions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "interaction_surfaces" (
    "id" TEXT NOT NULL,
    "interactionId" TEXT NOT NULL,
    "surfaceId" TEXT NOT NULL,
    "protocolFamily" TEXT NOT NULL,
    "document" JSONB NOT NULL,
    "draftVersion" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "interaction_surfaces_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "interactions_threadId_updatedAt_idx" ON "interactions"("threadId", "updatedAt");

CREATE INDEX "interactions_spaceId_threadId_idx" ON "interactions"("spaceId", "threadId");

CREATE INDEX "interactions_runId_idx" ON "interactions"("runId");

CREATE UNIQUE INDEX "interaction_surfaces_interactionId_surfaceId_key" ON "interaction_surfaces"("interactionId", "surfaceId");

ALTER TABLE "interactions" ADD CONSTRAINT "interactions_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "interactions" ADD CONSTRAINT "interactions_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "interactions" ADD CONSTRAINT "interactions_runId_fkey" FOREIGN KEY ("runId") REFERENCES "runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "interaction_surfaces" ADD CONSTRAINT "interaction_surfaces_interactionId_fkey" FOREIGN KEY ("interactionId") REFERENCES "interactions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Interactions belong to one Space; surfaces inherit through the parent row.
ALTER TABLE "interactions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY interactions_tenant ON "interactions"
  USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
CREATE POLICY interactions_system ON "interactions"
  USING ((SELECT app_rls_bypass()));

ALTER TABLE "interaction_surfaces" ENABLE ROW LEVEL SECURITY;
CREATE POLICY interaction_surfaces_tenant ON "interaction_surfaces"
  USING (EXISTS (
    SELECT 1 FROM "interactions" i
    WHERE i."id" = "interaction_surfaces"."interactionId"
      AND i."spaceId" = NULLIF(current_setting('app.space_id', true), '')
  ));
CREATE POLICY interaction_surfaces_system ON "interaction_surfaces"
  USING ((SELECT app_rls_bypass()));
