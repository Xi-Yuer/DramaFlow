BEGIN;
ALTER TABLE "workflow_run" ADD COLUMN "cancellationRequestedAt" TIMESTAMP(3);
ALTER TABLE "workflow_run" DROP CONSTRAINT "workflow_run_lifecycle";
ALTER TABLE "workflow_run" ADD CONSTRAINT "workflow_run_lifecycle" CHECK (
  ("status" = 'pending' AND "startedAt" IS NULL AND "completedAt" IS NULL AND "outputs" IS NULL AND "error" IS NULL) OR
  ("status" IN ('running', 'waiting') AND "startedAt" IS NOT NULL AND "completedAt" IS NULL AND "outputs" IS NULL AND "error" IS NULL) OR
  ("status" = 'completed' AND "startedAt" IS NOT NULL AND "completedAt" IS NOT NULL AND "outputs" IS NOT NULL AND "error" IS NULL) OR
  ("status" = 'failed' AND "startedAt" IS NOT NULL AND "completedAt" IS NOT NULL AND "outputs" IS NULL AND "error" IS NOT NULL) OR
  -- 取消未开始的 Run 不伪造 startedAt；保留迁移前已取消记录。
  ("status" = 'cancelled' AND "completedAt" IS NOT NULL AND "outputs" IS NULL AND "error" IS NULL AND ("startedAt" IS NOT NULL OR "cancellationRequestedAt" IS NOT NULL))
);
CREATE OR REPLACE FUNCTION "guard_workflow_run_update"() RETURNS TRIGGER AS $$
BEGIN
  IF ROW(NEW."id", NEW."projectId", NEW."workflowId", NEW."workflowVersionId", NEW."threadId", NEW."invocationKey", NEW."inputs", NEW."createdAt")
    IS DISTINCT FROM ROW(OLD."id", OLD."projectId", OLD."workflowId", OLD."workflowVersionId", OLD."threadId", OLD."invocationKey", OLD."inputs", OLD."createdAt") THEN
    RAISE EXCEPTION 'WorkflowRun identity, version and inputs are immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD."startedAt" IS NOT NULL AND NEW."startedAt" IS DISTINCT FROM OLD."startedAt" THEN
    RAISE EXCEPTION 'WorkflowRun startedAt is immutable after start' USING ERRCODE = '23514';
  END IF;
  IF OLD."cancellationRequestedAt" IS NOT NULL AND NEW."cancellationRequestedAt" IS DISTINCT FROM OLD."cancellationRequestedAt" THEN
    RAISE EXCEPTION 'WorkflowRun cancellation request is immutable' USING ERRCODE = '23514';
  END IF;
  IF NOT (
    (OLD."status" IN ('pending', 'waiting') AND NEW."status" = 'running' AND NEW."cancellationRequestedAt" IS NULL) OR
    (OLD."status" = 'running' AND NEW."status" IN ('waiting', 'completed', 'failed')) OR
    (OLD."status" IN ('pending', 'running', 'waiting') AND NEW."status" = 'cancelled' AND NEW."cancellationRequestedAt" IS NOT NULL AND (OLD."status" <> 'pending' OR NEW."startedAt" IS NULL)) OR
    -- 不改变执行状态，只首次写取消意图；终态不接受新请求或任何更新。
    (OLD."status" IN ('pending', 'running', 'waiting') AND NEW."status" = OLD."status" AND OLD."cancellationRequestedAt" IS NULL AND NEW."cancellationRequestedAt" IS NOT NULL AND
      (to_jsonb(NEW) - 'cancellationRequestedAt') = (to_jsonb(OLD) - 'cancellationRequestedAt'))
  ) THEN
    RAISE EXCEPTION 'Invalid WorkflowRun status transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
ALTER TABLE "workflow_execution_outbox" DROP CONSTRAINT "workflow_execution_outbox_status_check";
ALTER TABLE "workflow_execution_outbox" ADD CONSTRAINT "workflow_execution_outbox_status_check"
  CHECK ("status" IN ('pending','published','executing','completed','failed','recovery_required','cancelled'));
COMMIT;
