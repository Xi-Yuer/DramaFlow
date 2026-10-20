BEGIN;

CREATE TABLE "workflow" (
  "id" TEXT NOT NULL,
  "projectId" UUID NOT NULL,
  "name" VARCHAR(80) NOT NULL,
  "draft" JSONB NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "workflow_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "workflow_revision_positive" CHECK ("revision" > 0),
  CONSTRAINT "workflow_draft_object" CHECK (jsonb_typeof("draft") = 'object')
);

CREATE UNIQUE INDEX "workflow_projectId_key" ON "workflow"("projectId");
ALTER TABLE "workflow" ADD CONSTRAINT "workflow_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "canvas_project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "workflow_version" (
  "id" TEXT NOT NULL,
  "workflowId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "definition" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "workflow_version_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "workflow_version_number_positive" CHECK ("version" > 0),
  CONSTRAINT "workflow_version_definition_object" CHECK (jsonb_typeof("definition") = 'object')
);

CREATE UNIQUE INDEX "workflow_version_workflowId_version_key" ON "workflow_version"("workflowId", "version");
CREATE INDEX "workflow_version_workflowId_idx" ON "workflow_version"("workflowId");
ALTER TABLE "workflow_version" ADD CONSTRAINT "workflow_version_workflowId_fkey"
  FOREIGN KEY ("workflowId") REFERENCES "workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 版本号、归属、时间及完整定义都不可改写；删除仍服从显式父级级联规则。
CREATE FUNCTION "guard_workflow_version_update"() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'WorkflowVersion is immutable' USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "workflow_version_update_guard" BEFORE UPDATE ON "workflow_version"
  FOR EACH ROW EXECUTE FUNCTION "guard_workflow_version_update"();

COMMIT;
