BEGIN;

-- AlterTable
ALTER TABLE "node_run" ADD COLUMN     "iterationItemRunId" UUID;

-- CreateTable
CREATE TABLE "iteration_item_run" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "workflowRunId" TEXT NOT NULL,
    "iterationNodeRunId" UUID NOT NULL,
    "iterationNodeId" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "error" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "iteration_item_run_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "iteration_item_run_workflowRunId_idx" ON "iteration_item_run"("workflowRunId");

-- CreateIndex
CREATE UNIQUE INDEX "iteration_item_run_iterationNodeRunId_index_key" ON "iteration_item_run"("iterationNodeRunId", "index");

-- CreateIndex
CREATE UNIQUE INDEX "iteration_item_run_workflowRunId_scopeKey_key" ON "iteration_item_run"("workflowRunId", "scopeKey");

-- CreateIndex
CREATE UNIQUE INDEX "iteration_item_run_id_workflowRunId_projectId_key" ON "iteration_item_run"("id", "workflowRunId", "projectId");

-- CreateIndex
CREATE INDEX "node_run_iterationItemRunId_idx" ON "node_run"("iterationItemRunId");

-- CreateIndex
CREATE UNIQUE INDEX "node_run_id_workflowRunId_projectId_nodeId_key" ON "node_run"("id", "workflowRunId", "projectId", "nodeId");

-- AddForeignKey
ALTER TABLE "node_run" ADD CONSTRAINT "node_run_iterationItemRunId_workflowRunId_projectId_fkey" FOREIGN KEY ("iterationItemRunId", "workflowRunId", "projectId") REFERENCES "iteration_item_run"("id", "workflowRunId", "projectId") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "iteration_item_run" ADD CONSTRAINT "iteration_item_run_workflowRunId_projectId_fkey" FOREIGN KEY ("workflowRunId", "projectId") REFERENCES "workflow_run"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "iteration_item_run" ADD CONSTRAINT "iteration_item_run_iterationNodeRunId_workflowRunId_projec_fkey" FOREIGN KEY ("iterationNodeRunId", "workflowRunId", "projectId", "iterationNodeId") REFERENCES "node_run"("id", "workflowRunId", "projectId", "nodeId") ON DELETE CASCADE ON UPDATE RESTRICT;

ALTER TABLE "iteration_item_run"
  ADD CONSTRAINT "iteration_item_run_index_nonnegative" CHECK ("index" >= 0),
  ADD CONSTRAINT "iteration_item_run_scope_nonempty" CHECK (length("scopeKey") > 0 AND "scopeKey" = btrim("scopeKey")),
  ADD CONSTRAINT "iteration_item_run_lifecycle" CHECK (
    ("status" = 'running' AND "completedAt" IS NULL AND "error" IS NULL) OR
    ("status" = 'completed' AND "completedAt" IS NOT NULL AND "error" IS NULL) OR
    ("status" = 'failed' AND "completedAt" IS NOT NULL AND "error" IS NOT NULL)
  );

CREATE FUNCTION "guard_iteration_item_run_update"() RETURNS TRIGGER AS $$
BEGIN
  IF ROW(NEW."id", NEW."projectId", NEW."workflowRunId", NEW."iterationNodeRunId", NEW."iterationNodeId", NEW."scopeKey", NEW."index", NEW."createdAt", NEW."startedAt")
    IS DISTINCT FROM ROW(OLD."id", OLD."projectId", OLD."workflowRunId", OLD."iterationNodeRunId", OLD."iterationNodeId", OLD."scopeKey", OLD."index", OLD."createdAt", OLD."startedAt") THEN
    RAISE EXCEPTION 'IterationItemRun identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD."status" <> 'running' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'IterationItemRun terminal record is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "iteration_item_run_update_guard" BEFORE UPDATE ON "iteration_item_run"
  FOR EACH ROW EXECUTE FUNCTION "guard_iteration_item_run_update"();

CREATE OR REPLACE FUNCTION "guard_node_run_identity_update"() RETURNS TRIGGER AS $$
BEGIN
  IF ROW(NEW."id", NEW."projectId", NEW."workflowRunId", NEW."nodeId", NEW."occurrenceId", NEW."iterationItemRunId", NEW."attempt", NEW."startedAt")
    IS DISTINCT FROM ROW(OLD."id", OLD."projectId", OLD."workflowRunId", OLD."nodeId", OLD."occurrenceId", OLD."iterationItemRunId", OLD."attempt", OLD."startedAt") THEN
    RAISE EXCEPTION 'NodeRun occurrence, item and attempt identity are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 作用域与外键共同保护归属；不能在同 Run 内把某个 Body NodeRun 错挂另一 item。
CREATE FUNCTION "guard_node_run_item_scope"() RETURNS TRIGGER AS $$
DECLARE
  item_id UUID;
BEGIN
  SELECT i."id" INTO item_id FROM "node_occurrence" o
    JOIN "iteration_item_run" i ON i."workflowRunId" = o."workflowRunId" AND i."scopeKey" = o."scopeKey"
    WHERE o."id" = NEW."occurrenceId";
  IF NEW."iterationItemRunId" IS DISTINCT FROM item_id THEN
    RAISE EXCEPTION 'NodeRun item execution scope mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "node_run_item_scope_guard" BEFORE INSERT ON "node_run"
  FOR EACH ROW EXECUTE FUNCTION "guard_node_run_item_scope"();

COMMIT;
