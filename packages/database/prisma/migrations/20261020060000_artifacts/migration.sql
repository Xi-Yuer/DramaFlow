BEGIN;
CREATE UNIQUE INDEX "node_run_id_workflowRunId_projectId_key" ON "node_run"("id", "workflowRunId", "projectId");
CREATE TABLE "artifact" (
  "id" UUID PRIMARY KEY,
  "projectId" UUID NOT NULL,
  "workflowRunId" TEXT NOT NULL,
  "nodeRunId" UUID,
  "nodeId" TEXT NOT NULL,
  "outputKey" TEXT NOT NULL,
  "type" JSONB NOT NULL,
  "contentKind" TEXT NOT NULL CHECK ("contentKind" IN ('json', 'blob')),
  "storageKey" TEXT NOT NULL UNIQUE,
  "mimeType" TEXT NOT NULL,
  "size" INTEGER NOT NULL CHECK ("size" >= 0),
  "checksum" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'writing' CHECK ("status" IN ('writing', 'ready', 'failed')),
  "failureStage" TEXT,
  "cleanupRequired" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "artifact_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "canvas_project"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "artifact_workflowRunId_projectId_fkey" FOREIGN KEY ("workflowRunId", "projectId") REFERENCES "workflow_run"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "artifact_nodeRunId_workflowRunId_projectId_fkey" FOREIGN KEY ("nodeRunId", "workflowRunId", "projectId") REFERENCES "node_run"("id", "workflowRunId", "projectId") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "artifact_write_state" CHECK (
    ("status" = 'writing' AND "completedAt" IS NULL AND "failureStage" IS NULL AND NOT "cleanupRequired") OR
    ("status" = 'ready' AND "completedAt" IS NOT NULL AND "failureStage" IS NULL AND NOT "cleanupRequired") OR
    ("status" = 'failed' AND "completedAt" IS NOT NULL AND "failureStage" = 'upload')
  )
);
CREATE INDEX "artifact_projectId_createdAt_idx" ON "artifact"("projectId", "createdAt");
CREATE INDEX "artifact_workflowRunId_idx" ON "artifact"("workflowRunId");
CREATE INDEX "artifact_nodeRunId_idx" ON "artifact"("nodeRunId");
CREATE INDEX "artifact_status_idx" ON "artifact"("status");

CREATE FUNCTION "guard_artifact_write"() RETURNS TRIGGER AS $$
BEGIN
  IF ROW(NEW."id", NEW."projectId", NEW."workflowRunId", NEW."nodeRunId", NEW."nodeId", NEW."outputKey", NEW."type", NEW."contentKind", NEW."storageKey", NEW."mimeType", NEW."size", NEW."checksum", NEW."createdAt")
    IS DISTINCT FROM ROW(OLD."id", OLD."projectId", OLD."workflowRunId", OLD."nodeRunId", OLD."nodeId", OLD."outputKey", OLD."type", OLD."contentKind", OLD."storageKey", OLD."mimeType", OLD."size", OLD."checksum", OLD."createdAt") THEN
    RAISE EXCEPTION 'Artifact content identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD."status" <> 'writing' OR NEW."status" NOT IN ('ready', 'failed') THEN
    RAISE EXCEPTION 'Invalid artifact write transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "artifact_write_guard" BEFORE UPDATE ON "artifact"
  FOR EACH ROW EXECUTE FUNCTION "guard_artifact_write"();
COMMIT;
