CREATE TABLE "canvas_project" (
  "id" UUID NOT NULL,
  "ownerId" TEXT NOT NULL,
  "name" VARCHAR(80) NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "definition" JSONB NOT NULL,
  "viewport" JSONB NOT NULL,
  "nodeCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "canvas_project_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "canvas_project_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "auth_user"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "canvas_project_ownerId_updatedAt_id_idx" ON "canvas_project"("ownerId", "updatedAt", "id");
