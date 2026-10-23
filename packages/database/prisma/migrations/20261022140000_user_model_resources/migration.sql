-- 模型资源归属原项目的 Owner；保留每条记录的 ID、密文和重复配置，不改 Workflow 引用。
BEGIN;
LOCK TABLE "canvas_project", "model_provider", "model_configuration" IN SHARE ROW EXCLUSIVE MODE;
ALTER TABLE "model_provider" ADD COLUMN "ownerId" TEXT;
ALTER TABLE "model_configuration" ADD COLUMN "ownerId" TEXT;
UPDATE "model_provider" m SET "ownerId" = p."ownerId" FROM "canvas_project" p WHERE p."id" = m."projectId";
UPDATE "model_configuration" m SET "ownerId" = p."ownerId" FROM "canvas_project" p WHERE p."id" = m."projectId";
ALTER TABLE "model_provider" ALTER COLUMN "ownerId" SET NOT NULL;
ALTER TABLE "model_configuration" ALTER COLUMN "ownerId" SET NOT NULL;

ALTER TABLE "model_configuration" DROP CONSTRAINT "model_configuration_providerId_projectId_fkey";
ALTER TABLE "model_configuration" DROP CONSTRAINT "model_configuration_projectId_fkey";
ALTER TABLE "model_provider" DROP CONSTRAINT "model_provider_projectId_fkey";
DROP INDEX "model_provider_id_projectId_key";
DROP INDEX "model_provider_projectId_idx";
DROP INDEX "model_configuration_projectId_idx";
CREATE UNIQUE INDEX "model_provider_id_ownerId_key" ON "model_provider"("id", "ownerId");
CREATE INDEX "model_provider_ownerId_idx" ON "model_provider"("ownerId");
CREATE INDEX "model_configuration_ownerId_idx" ON "model_configuration"("ownerId");
ALTER TABLE "model_provider" ADD CONSTRAINT "model_provider_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "auth_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "model_configuration" ADD CONSTRAINT "model_configuration_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "auth_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "model_configuration" ADD CONSTRAINT "model_configuration_providerId_ownerId_fkey" FOREIGN KEY ("providerId", "ownerId") REFERENCES "model_provider"("id", "ownerId") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION "guard_model_provider_identity"() RETURNS TRIGGER AS $$
BEGIN
  IF ROW(NEW."id", NEW."ownerId", NEW."name", NEW."pluginId", NEW."pluginVersion", NEW."configuration", NEW."providerDefinitionId", NEW."createdAt")
    IS DISTINCT FROM ROW(OLD."id", OLD."ownerId", OLD."name", OLD."pluginId", OLD."pluginVersion", OLD."configuration", OLD."providerDefinitionId", OLD."createdAt") THEN
    RAISE EXCEPTION 'Model provider configuration is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION "guard_model_configuration_identity"() RETURNS TRIGGER AS $$
BEGIN
  IF ROW(NEW."id", NEW."ownerId", NEW."providerId", NEW."capability", NEW."model", NEW."settings", NEW."createdAt")
    IS DISTINCT FROM ROW(OLD."id", OLD."ownerId", OLD."providerId", OLD."capability", OLD."model", OLD."settings", OLD."createdAt") THEN
    RAISE EXCEPTION 'Model capability binding is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
ALTER TABLE "model_provider" DROP COLUMN "projectId";
ALTER TABLE "model_configuration" DROP COLUMN "projectId";
COMMIT;
