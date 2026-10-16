CREATE TABLE "plugin_installation" (
  "id" UUID NOT NULL,
  "ownerId" TEXT NOT NULL,
  "pluginId" VARCHAR(80) NOT NULL,
  "pluginVersion" INTEGER NOT NULL,
  "label" VARCHAR(80) NOT NULL,
  "secretCipher" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "plugin_installation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "plugin_installation_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "auth_user"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "plugin_installation_ownerId_updatedAt_idx" ON "plugin_installation"("ownerId", "updatedAt");
