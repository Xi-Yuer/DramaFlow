BEGIN;

CREATE TABLE "node_occurrence" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "workflowRunId" TEXT NOT NULL,
  "nodeId" TEXT NOT NULL,
  "scopeKey" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "node_occurrence_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "node_occurrence_scope_nonempty" CHECK (length("scopeKey") > 0 AND "scopeKey" = btrim("scopeKey")),
  CONSTRAINT "node_occurrence_node_nonempty" CHECK (length("nodeId") > 0 AND "nodeId" = btrim("nodeId")),
  CONSTRAINT "node_occurrence_workflowRunId_projectId_fkey" FOREIGN KEY ("workflowRunId", "projectId")
    REFERENCES "workflow_run"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "node_occurrence_workflowRunId_scopeKey_nodeId_key" ON "node_occurrence"("workflowRunId", "scopeKey", "nodeId");
CREATE UNIQUE INDEX "node_occurrence_id_workflowRunId_projectId_nodeId_key" ON "node_occurrence"("id", "workflowRunId", "projectId", "nodeId");

ALTER TABLE "node_run" ADD COLUMN "occurrenceId" UUID;
-- 每组旧 Run / node 的所有 attempt 归为一个 root occurrence；审计主键和内容完全保留。
INSERT INTO "node_occurrence" ("id", "projectId", "workflowRunId", "nodeId", "scopeKey", "createdAt")
SELECT gen_random_uuid(), "projectId", "workflowRunId", "nodeId", 'root', min("startedAt")
FROM "node_run" GROUP BY "projectId", "workflowRunId", "nodeId";
UPDATE "node_run" AS n SET "occurrenceId" = o."id" FROM "node_occurrence" AS o
WHERE o."workflowRunId" = n."workflowRunId" AND o."projectId" = n."projectId" AND o."nodeId" = n."nodeId" AND o."scopeKey" = 'root';
ALTER TABLE "node_run" ALTER COLUMN "occurrenceId" SET NOT NULL;
DROP INDEX "node_run_workflowRunId_nodeId_attempt_key";
CREATE UNIQUE INDEX "node_run_occurrenceId_attempt_key" ON "node_run"("occurrenceId", "attempt");
ALTER TABLE "node_run" ADD CONSTRAINT "node_run_occurrenceId_workflowRunId_projectId_nodeId_fkey"
  FOREIGN KEY ("occurrenceId", "workflowRunId", "projectId", "nodeId")
  REFERENCES "node_occurrence"("id", "workflowRunId", "projectId", "nodeId") ON DELETE CASCADE ON UPDATE RESTRICT;

CREATE FUNCTION "guard_node_occurrence_update"() RETURNS TRIGGER AS $$
BEGIN
  IF NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'NodeOccurrence identity is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "node_occurrence_update_guard" BEFORE UPDATE ON "node_occurrence"
  FOR EACH ROW EXECUTE FUNCTION "guard_node_occurrence_update"();

-- 不允许把既有 attempt 改挂其他 occurrence、改号或改写执行身份。
CREATE FUNCTION "guard_node_run_identity_update"() RETURNS TRIGGER AS $$
BEGIN
  IF ROW(NEW."id", NEW."projectId", NEW."workflowRunId", NEW."nodeId", NEW."occurrenceId", NEW."attempt", NEW."startedAt")
    IS DISTINCT FROM ROW(OLD."id", OLD."projectId", OLD."workflowRunId", OLD."nodeId", OLD."occurrenceId", OLD."attempt", OLD."startedAt") THEN
    RAISE EXCEPTION 'NodeRun occurrence and attempt identity are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "node_run_identity_update_guard" BEFORE UPDATE ON "node_run"
  FOR EACH ROW EXECUTE FUNCTION "guard_node_run_identity_update"();

COMMIT;
