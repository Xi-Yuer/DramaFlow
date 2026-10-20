CREATE TYPE "node_run_status" AS ENUM ('running', 'completed', 'failed');

CREATE TABLE "node_run" (
  "id" UUID NOT NULL,
  "projectId" UUID NOT NULL,
  "workflowRunId" TEXT NOT NULL,
  "nodeId" TEXT NOT NULL,
  "attempt" INTEGER NOT NULL,
  "status" "node_run_status" NOT NULL DEFAULT 'running',
  "inputs" JSONB,
  "outputs" JSONB,
  "error" JSONB,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "node_run_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "node_run_attempt_positive" CHECK ("attempt" > 0),
  CONSTRAINT "node_run_inputs_object" CHECK ("inputs" IS NULL OR jsonb_typeof("inputs") = 'object'),
  CONSTRAINT "node_run_outputs_object" CHECK ("outputs" IS NULL OR jsonb_typeof("outputs") = 'object'),
  CONSTRAINT "node_run_lifecycle" CHECK (
    ("status" = 'running' AND "completedAt" IS NULL AND "outputs" IS NULL AND "error" IS NULL) OR
    ("status" = 'completed' AND "completedAt" IS NOT NULL AND "inputs" IS NOT NULL AND "outputs" IS NOT NULL AND "error" IS NULL) OR
    ("status" = 'failed' AND "completedAt" IS NOT NULL AND "outputs" IS NULL AND "error" IS NOT NULL)
  )
);
CREATE UNIQUE INDEX "node_run_workflowRunId_nodeId_attempt_key" ON "node_run" ("workflowRunId", "nodeId", "attempt");
CREATE INDEX "node_run_projectId_workflowRunId_idx" ON "node_run" ("projectId", "workflowRunId");
ALTER TABLE "node_run" ADD CONSTRAINT "node_run_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "canvas_project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
