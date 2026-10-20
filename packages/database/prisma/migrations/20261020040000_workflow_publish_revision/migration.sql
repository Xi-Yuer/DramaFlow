BEGIN;

-- 旧版本没有来源修订信息时不能由 version 或当前 draft.revision 猜测；不自动回填。
ALTER TABLE "workflow_version" ADD COLUMN "sourceRevision" INTEGER NOT NULL;
ALTER TABLE "workflow_version" ADD CONSTRAINT "workflow_version_source_revision_positive"
  CHECK ("sourceRevision" > 0);
CREATE UNIQUE INDEX "workflow_version_workflowId_sourceRevision_key"
  ON "workflow_version"("workflowId", "sourceRevision");

COMMIT;
