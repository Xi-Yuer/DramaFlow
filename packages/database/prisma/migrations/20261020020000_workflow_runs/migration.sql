BEGIN;

CREATE TABLE "workflow_run" (
  "id" TEXT NOT NULL,
  "projectId" UUID NOT NULL,
  "workflowId" TEXT NOT NULL,
  "workflowVersionId" TEXT NOT NULL,
  "threadId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "inputs" JSONB NOT NULL,
  "outputs" JSONB,
  "error" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "workflow_run_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "workflow_run_inputs_object" CHECK (jsonb_typeof("inputs") = 'object'),
  CONSTRAINT "workflow_run_outputs_object" CHECK ("outputs" IS NULL OR jsonb_typeof("outputs") = 'object'),
  CONSTRAINT "workflow_run_error_object" CHECK ("error" IS NULL OR jsonb_typeof("error") = 'object'),
  CONSTRAINT "workflow_run_lifecycle" CHECK (
    ("status" = 'pending' AND "startedAt" IS NULL AND "completedAt" IS NULL AND "outputs" IS NULL AND "error" IS NULL) OR
    ("status" IN ('running', 'waiting') AND "startedAt" IS NOT NULL AND "completedAt" IS NULL AND "outputs" IS NULL AND "error" IS NULL) OR
    ("status" = 'completed' AND "startedAt" IS NOT NULL AND "completedAt" IS NOT NULL AND "outputs" IS NOT NULL AND "error" IS NULL) OR
    ("status" = 'failed' AND "startedAt" IS NOT NULL AND "completedAt" IS NOT NULL AND "outputs" IS NULL AND "error" IS NOT NULL) OR
    ("status" = 'cancelled' AND "startedAt" IS NOT NULL AND "completedAt" IS NOT NULL AND "outputs" IS NULL AND "error" IS NULL)
  )
);

CREATE UNIQUE INDEX "workflow_run_threadId_key" ON "workflow_run"("threadId");
CREATE UNIQUE INDEX "workflow_run_id_projectId_key" ON "workflow_run"("id", "projectId");
CREATE INDEX "workflow_run_projectId_idx" ON "workflow_run"("projectId");
CREATE INDEX "workflow_run_workflowId_idx" ON "workflow_run"("workflowId");
CREATE INDEX "workflow_run_workflowVersionId_idx" ON "workflow_run"("workflowVersionId");
CREATE INDEX "workflow_run_status_idx" ON "workflow_run"("status");
ALTER TABLE "workflow_run" ADD CONSTRAINT "workflow_run_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "canvas_project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 固定运行身份、版本、输入与首次开始时间；状态只能按领域操作推进。
CREATE FUNCTION "guard_workflow_run_update"() RETURNS TRIGGER AS $$
BEGIN
  IF ROW(NEW."id", NEW."projectId", NEW."workflowId", NEW."workflowVersionId", NEW."threadId", NEW."inputs", NEW."createdAt")
    IS DISTINCT FROM ROW(OLD."id", OLD."projectId", OLD."workflowId", OLD."workflowVersionId", OLD."threadId", OLD."inputs", OLD."createdAt") THEN
    RAISE EXCEPTION 'WorkflowRun identity, version and inputs are immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD."startedAt" IS NOT NULL AND NEW."startedAt" IS DISTINCT FROM OLD."startedAt" THEN
    RAISE EXCEPTION 'WorkflowRun startedAt is immutable after start' USING ERRCODE = '23514';
  END IF;
  IF NOT (
    (OLD."status" = 'pending' AND NEW."status" = 'running') OR
    (OLD."status" = 'running' AND NEW."status" IN ('waiting', 'completed', 'failed', 'cancelled')) OR
    (OLD."status" = 'waiting' AND NEW."status" IN ('running', 'cancelled'))
  ) THEN
    RAISE EXCEPTION 'Invalid WorkflowRun status transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "workflow_run_update_guard" BEFORE UPDATE ON "workflow_run"
  FOR EACH ROW EXECUTE FUNCTION "guard_workflow_run_update"();

-- 旧开发记录只有逻辑运行 ID，无法证明所属版本；只清理无真实父运行的节点历史，不补造 WorkflowRun。
DELETE FROM "node_run" AS n WHERE NOT EXISTS (
  SELECT 1 FROM "workflow_run" AS r WHERE r."id" = n."workflowRunId" AND r."projectId" = n."projectId"
);
ALTER TABLE "node_run" ADD CONSTRAINT "node_run_workflowRunId_projectId_fkey"
  FOREIGN KEY ("workflowRunId", "projectId") REFERENCES "workflow_run"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
