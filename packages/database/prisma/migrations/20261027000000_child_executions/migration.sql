BEGIN;

-- 停止旧 API / Worker 写入后部署；原地 rename 保留 UUID、审计、Artifact 与父子关系。
DROP TRIGGER "iteration_item_run_update_guard" ON "iteration_item_run";
DROP FUNCTION "guard_iteration_item_run_update"();
DROP TRIGGER "node_run_item_scope_guard" ON "node_run";
DROP FUNCTION "guard_node_run_item_scope"();
ALTER TABLE "iteration_item_run" RENAME TO "child_execution";
ALTER TABLE "child_execution" RENAME COLUMN "iterationNodeRunId" TO "parentNodeRunId";
ALTER TABLE "child_execution" RENAME COLUMN "iterationNodeId" TO "parentNodeId";
ALTER TABLE "node_run" RENAME COLUMN "iterationItemRunId" TO "childExecutionId";
ALTER TABLE "child_execution" ADD COLUMN "kind" TEXT,
  ADD COLUMN "invocationKey" TEXT,
  ADD COLUMN "metadata" JSONB;
UPDATE "child_execution" SET "kind" = 'iteration_item',
  "invocationKey" = 'iteration-item:' || "index"::text,
  "metadata" = jsonb_build_object('index', "index");
ALTER TABLE "child_execution" ALTER COLUMN "kind" SET NOT NULL,
  ALTER COLUMN "invocationKey" SET NOT NULL, ALTER COLUMN "metadata" SET NOT NULL,
  ALTER COLUMN "index" DROP NOT NULL;

ALTER TABLE "child_execution" RENAME CONSTRAINT "iteration_item_run_pkey" TO "child_execution_pkey";
ALTER TABLE "child_execution" RENAME CONSTRAINT "iteration_item_run_workflowRunId_projectId_fkey" TO "child_execution_workflowRunId_projectId_fkey";
ALTER TABLE "child_execution" RENAME CONSTRAINT "iteration_item_run_iterationNodeRunId_workflowRunId_projec_fkey" TO "child_execution_parentNodeRunId_workflowRunId_projectId_pa_fkey";
ALTER TABLE "node_run" RENAME CONSTRAINT "node_run_iterationItemRunId_workflowRunId_projectId_fkey" TO "node_run_childExecutionId_workflowRunId_projectId_fkey";
ALTER INDEX "iteration_item_run_workflowRunId_idx" RENAME TO "child_execution_workflowRunId_idx";
ALTER INDEX "iteration_item_run_iterationNodeRunId_index_key" RENAME TO "child_execution_parentNodeRunId_index_key";
ALTER INDEX "iteration_item_run_workflowRunId_scopeKey_key" RENAME TO "child_execution_workflowRunId_scopeKey_key";
ALTER INDEX "iteration_item_run_id_workflowRunId_projectId_key" RENAME TO "child_execution_id_workflowRunId_projectId_key";
ALTER INDEX "node_run_iterationItemRunId_idx" RENAME TO "node_run_childExecutionId_idx";
ALTER TABLE "child_execution" RENAME CONSTRAINT "iteration_item_run_index_nonnegative" TO "child_execution_index_nonnegative";
ALTER TABLE "child_execution" RENAME CONSTRAINT "iteration_item_run_scope_nonempty" TO "child_execution_scope_nonempty";
ALTER TABLE "child_execution" RENAME CONSTRAINT "iteration_item_run_lifecycle" TO "child_execution_lifecycle";
CREATE UNIQUE INDEX "child_execution_parentNodeRunId_invocationKey_key" ON "child_execution"("parentNodeRunId", "invocationKey");
ALTER TABLE "child_execution" ADD CONSTRAINT "child_execution_invocation" CHECK (
  length("kind") > 0 AND "kind" = btrim("kind") AND
  length("invocationKey") > 0 AND "invocationKey" = btrim("invocationKey") AND
  "scopeKey" <> 'root' AND jsonb_typeof("metadata") = 'object'
), ADD CONSTRAINT "child_execution_iteration_extension" CHECK (
  CASE WHEN "kind" = 'iteration_item' THEN
    "index" IS NOT NULL AND "metadata" ? 'index' AND jsonb_typeof("metadata"->'index') = 'number'
    AND "metadata"->'index' = to_jsonb("index")
    AND "invocationKey" = 'iteration-item:' || "index"::text
  ELSE "index" IS NULL END
);

CREATE FUNCTION "guard_child_execution_update"() RETURNS TRIGGER AS $$
BEGIN
  IF ROW(NEW."id", NEW."projectId", NEW."workflowRunId", NEW."parentNodeRunId", NEW."parentNodeId", NEW."scopeKey", NEW."kind", NEW."invocationKey", NEW."metadata", NEW."index", NEW."createdAt", NEW."startedAt")
    IS DISTINCT FROM ROW(OLD."id", OLD."projectId", OLD."workflowRunId", OLD."parentNodeRunId", OLD."parentNodeId", OLD."scopeKey", OLD."kind", OLD."invocationKey", OLD."metadata", OLD."index", OLD."createdAt", OLD."startedAt") THEN
    RAISE EXCEPTION 'ChildExecution identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD."status" <> 'running' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'ChildExecution terminal record is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "child_execution_update_guard" BEFORE UPDATE ON "child_execution"
  FOR EACH ROW EXECUTE FUNCTION "guard_child_execution_update"();

CREATE OR REPLACE FUNCTION "guard_node_run_identity_update"() RETURNS TRIGGER AS $$
BEGIN
  IF ROW(NEW."id", NEW."projectId", NEW."workflowRunId", NEW."nodeId", NEW."occurrenceId", NEW."childExecutionId", NEW."attempt", NEW."startedAt")
    IS DISTINCT FROM ROW(OLD."id", OLD."projectId", OLD."workflowRunId", OLD."nodeId", OLD."occurrenceId", OLD."childExecutionId", OLD."attempt", OLD."startedAt") THEN
    RAISE EXCEPTION 'NodeRun occurrence, child execution and attempt identity are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
-- 通过显式 FK 读取 child，仅比较 scope 一致性；绝不按 scopeKey 查找 child。
CREATE FUNCTION "guard_node_run_child_scope"() RETURNS TRIGGER AS $$
DECLARE occurrence_scope TEXT; child_scope TEXT;
BEGIN
  SELECT "scopeKey" INTO occurrence_scope FROM "node_occurrence" WHERE "id" = NEW."occurrenceId";
  IF NEW."childExecutionId" IS NULL THEN
    IF occurrence_scope <> 'root' THEN
      RAISE EXCEPTION 'Non-root NodeRun requires ChildExecution' USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT "scopeKey" INTO child_scope FROM "child_execution" WHERE "id" = NEW."childExecutionId";
    IF child_scope IS NULL OR child_scope IS DISTINCT FROM occurrence_scope OR occurrence_scope = 'root' THEN
      RAISE EXCEPTION 'NodeRun child execution scope mismatch' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "node_run_child_scope_guard" BEFORE INSERT ON "node_run"
  FOR EACH ROW EXECUTE FUNCTION "guard_node_run_child_scope"();
COMMIT;
