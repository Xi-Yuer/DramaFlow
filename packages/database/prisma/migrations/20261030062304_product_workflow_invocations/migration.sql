-- CreateTable
CREATE TABLE "product_workflow_invocation" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "sourceVideoId" UUID NOT NULL,
    "sourceVideoName" VARCHAR(80) NOT NULL,
    "workflowRunId" TEXT NOT NULL,
    "invocationKey" VARCHAR(200) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_workflow_invocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "product_workflow_invocation_workflowRunId_key" ON "product_workflow_invocation"("workflowRunId");

-- CreateIndex
CREATE INDEX "product_workflow_invocation_projectId_sourceVideoId_created_idx" ON "product_workflow_invocation"("projectId", "sourceVideoId", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "product_workflow_invocation_projectId_invocationKey_key" ON "product_workflow_invocation"("projectId", "invocationKey");

-- CreateIndex
CREATE UNIQUE INDEX "product_workflow_invocation_workflowRunId_projectId_key" ON "product_workflow_invocation"("workflowRunId", "projectId");

-- AddForeignKey
ALTER TABLE "product_workflow_invocation" ADD CONSTRAINT "product_workflow_invocation_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "canvas_project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_workflow_invocation" ADD CONSTRAINT "product_workflow_invocation_workflowRunId_projectId_fkey" FOREIGN KEY ("workflowRunId", "projectId") REFERENCES "workflow_run"("id", "projectId") ON DELETE CASCADE ON UPDATE RESTRICT;

ALTER TABLE product_workflow_invocation
  ADD CONSTRAINT product_invocation_key_check CHECK (length("invocationKey") > 0 AND "invocationKey" = btrim("invocationKey")),
  ADD CONSTRAINT product_invocation_source_name_check CHECK (length(btrim("sourceVideoName")) > 0);

-- 来源只在首次受理时要求存在；永久删除 Video 不删除或改写历史来源快照。
CREATE FUNCTION guard_product_workflow_invocation_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM video WHERE id = NEW."sourceVideoId" AND "projectId" = NEW."projectId" FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Product invocation source must belong to project' USING ERRCODE = '23503';
  END IF;
  PERFORM 1 FROM workflow_run WHERE id = NEW."workflowRunId" AND "projectId" = NEW."projectId" AND "invocationKey" = NEW."invocationKey" FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Product invocation must match accepted run identity' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION guard_product_workflow_invocation_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Product invocation source and run identity are immutable' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM canvas_project WHERE id = OLD."projectId") THEN
    RAISE EXCEPTION 'Product invocation history belongs to project lifecycle' USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER product_invocation_insert_guard BEFORE INSERT ON product_workflow_invocation FOR EACH ROW EXECUTE FUNCTION guard_product_workflow_invocation_insert();
CREATE TRIGGER product_invocation_history_guard BEFORE UPDATE OR DELETE ON product_workflow_invocation FOR EACH ROW EXECUTE FUNCTION guard_product_workflow_invocation_history();
