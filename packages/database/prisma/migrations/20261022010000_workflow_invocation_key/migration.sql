BEGIN;
-- 只为已有 Run 填充独立历史身份；迁移后取消默认值，新调用必须明确提供 key。
ALTER TABLE "workflow_run" ADD COLUMN "invocationKey" TEXT NOT NULL DEFAULT ('legacy-' || gen_random_uuid()::text);
ALTER TABLE "workflow_run" ALTER COLUMN "invocationKey" DROP DEFAULT;
CREATE UNIQUE INDEX "workflow_run_workflowId_invocationKey_key" ON "workflow_run"("workflowId", "invocationKey");
CREATE OR REPLACE FUNCTION "guard_workflow_run_update"() RETURNS TRIGGER AS $$
BEGIN
  IF ROW(NEW."id", NEW."projectId", NEW."workflowId", NEW."workflowVersionId", NEW."threadId", NEW."invocationKey", NEW."inputs", NEW."createdAt")
    IS DISTINCT FROM ROW(OLD."id", OLD."projectId", OLD."workflowId", OLD."workflowVersionId", OLD."threadId", OLD."invocationKey", OLD."inputs", OLD."createdAt") THEN
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
COMMIT;
