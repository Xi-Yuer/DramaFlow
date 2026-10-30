-- DropIndex
DROP INDEX "workflow_projectId_key";

-- AlterTable
ALTER TABLE "workflow" ADD COLUMN     "metadataRevision" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "viewport" JSONB NOT NULL DEFAULT '{"x":0,"y":0,"zoom":1}';

-- 既有画布的视口迁至其明确 Workflow；Project 不再保存 Canvas 状态。
UPDATE workflow AS w SET viewport = p.viewport FROM canvas_project AS p WHERE p.id = w."projectId";
ALTER TABLE canvas_project DROP COLUMN viewport;

ALTER TABLE workflow
  ADD CONSTRAINT workflow_metadata_revision_positive CHECK ("metadataRevision" > 0),
  ADD CONSTRAINT workflow_viewport_object CHECK (jsonb_typeof(viewport) = 'object');

-- 仅允许删除未发布且无运行历史的逻辑 Workflow；Project 整体删除保留既有级联语义。
CREATE FUNCTION guard_workflow_delete_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM canvas_project WHERE id = OLD."projectId") AND (
    EXISTS (SELECT 1 FROM workflow_version WHERE "workflowId" = OLD.id) OR
    EXISTS (SELECT 1 FROM workflow_run WHERE "workflowId" = OLD.id)
  ) THEN
    RAISE EXCEPTION 'Workflow with published versions or runs cannot be deleted' USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER workflow_delete_history_guard BEFORE DELETE ON workflow FOR EACH ROW EXECUTE FUNCTION guard_workflow_delete_history();

-- CreateIndex
CREATE INDEX "workflow_projectId_createdAt_id_idx" ON "workflow"("projectId", "createdAt", "id");
