-- CreateTable
CREATE TABLE "video" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "status" VARCHAR(32) NOT NULL DEFAULT 'draft',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "video_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "video_projectId_createdAt_id_idx" ON "video"("projectId", "createdAt", "id");

-- AddForeignKey
ALTER TABLE "video" ADD CONSTRAINT "video_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "canvas_project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE video
  ADD CONSTRAINT video_status_check CHECK (status IN ('draft', 'active', 'completed')),
  ADD CONSTRAINT video_revision_check CHECK (revision > 0),
  ADD CONSTRAINT video_name_check CHECK (length(btrim(name)) > 0);
