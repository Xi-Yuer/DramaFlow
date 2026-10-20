-- 保留既有记录与三态校验；workflowRunId 继续为逻辑引用。
BEGIN;
ALTER TABLE "node_run" DROP CONSTRAINT "node_run_lifecycle";
ALTER TABLE "node_run" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "node_run" ALTER COLUMN "status" TYPE TEXT USING "status"::text;
ALTER TABLE "node_run" ALTER COLUMN "status" SET DEFAULT 'running';
DROP TYPE "node_run_status";
ALTER TABLE "node_run" ADD CONSTRAINT "node_run_lifecycle" CHECK (
  ("status" = 'running' AND "completedAt" IS NULL AND "outputs" IS NULL AND "error" IS NULL) OR
  ("status" = 'completed' AND "completedAt" IS NOT NULL AND "inputs" IS NOT NULL AND "outputs" IS NOT NULL AND "error" IS NULL) OR
  ("status" = 'failed' AND "completedAt" IS NOT NULL AND "outputs" IS NULL AND "error" IS NOT NULL)
);
CREATE INDEX "node_run_workflowRunId_idx" ON "node_run" ("workflowRunId");
CREATE INDEX "node_run_workflowRunId_nodeId_idx" ON "node_run" ("workflowRunId", "nodeId");
COMMIT;
