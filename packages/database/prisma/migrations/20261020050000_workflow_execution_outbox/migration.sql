BEGIN;
ALTER TABLE "workflow_run" ADD COLUMN "waitingRevision" INTEGER NOT NULL DEFAULT 0 CHECK ("waitingRevision" >= 0);
-- 在已有生命周期触发器之后推进 waiting 周期；调用方不能自行改写周期。
CREATE FUNCTION "advance_workflow_waiting_revision"() RETURNS TRIGGER AS $$
BEGIN
  IF NEW."waitingRevision" IS DISTINCT FROM OLD."waitingRevision" THEN
    RAISE EXCEPTION 'Workflow waiting revision is managed by lifecycle' USING ERRCODE = '23514';
  END IF;
  IF OLD."status" = 'running' AND NEW."status" = 'waiting' THEN
    NEW."waitingRevision" := OLD."waitingRevision" + 1;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "workflow_waiting_revision_guard" BEFORE UPDATE ON "workflow_run"
  FOR EACH ROW EXECUTE FUNCTION "advance_workflow_waiting_revision"();

CREATE TABLE "workflow_execution_outbox" (
  "id" TEXT PRIMARY KEY,
  "kind" TEXT NOT NULL CHECK ("kind" IN ('start', 'resume')),
  "workflowRunId" TEXT NOT NULL REFERENCES "workflow_run"("id") ON DELETE CASCADE,
  "waitingRevision" INTEGER NOT NULL DEFAULT 0 CHECK ("waitingRevision" >= 0),
  "payload" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending' CHECK ("status" IN ('pending','published','executing','completed','failed','recovery_required')),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "publishedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "attempts" INTEGER NOT NULL DEFAULT 0 CHECK ("attempts" >= 0),
  "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "workflow_execution_payload_identity" CHECK ((
    jsonb_typeof("payload") = 'object' AND
    "payload"->>'kind' = "kind" AND "payload"->>'workflowRunId' = "workflowRunId" AND
    (("kind" = 'start' AND "waitingRevision" = 0 AND "payload" = jsonb_build_object('kind','start','workflowRunId',"workflowRunId")) OR
     ("kind" = 'resume' AND "waitingRevision" >= 0 AND "payload"->>'executionId' = "id" AND "payload" ? 'value' AND
      "payload" - ARRAY['kind','workflowRunId','executionId','value'] = '{}'::jsonb))
  ) IS TRUE)
);
CREATE UNIQUE INDEX "workflow_execution_outbox_workflowRunId_kind_waitingRevision_key"
  ON "workflow_execution_outbox"("workflowRunId", "kind", "waitingRevision");
CREATE INDEX "workflow_execution_outbox_status_availableAt_createdAt_idx"
  ON "workflow_execution_outbox"("status", "availableAt", "createdAt");
CREATE FUNCTION "guard_workflow_execution_intent"() RETURNS TRIGGER AS $$
BEGIN
  IF ROW(NEW."id", NEW."kind", NEW."workflowRunId", NEW."waitingRevision", NEW."payload", NEW."createdAt")
    IS DISTINCT FROM ROW(OLD."id", OLD."kind", OLD."workflowRunId", OLD."waitingRevision", OLD."payload", OLD."createdAt") THEN
    RAISE EXCEPTION 'Workflow execution intent is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "workflow_execution_intent_guard" BEFORE UPDATE ON "workflow_execution_outbox"
  FOR EACH ROW EXECUTE FUNCTION "guard_workflow_execution_intent"();
COMMIT;
