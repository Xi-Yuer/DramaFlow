BEGIN;
CREATE TABLE "model_provider" (
  "id" UUID PRIMARY KEY,
  "projectId" UUID NOT NULL REFERENCES "canvas_project"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "name" VARCHAR(80) NOT NULL,
  "pluginId" VARCHAR(100) NOT NULL,
  "pluginVersion" INTEGER NOT NULL CHECK ("pluginVersion" > 0),
  "configuration" JSONB NOT NULL CHECK (jsonb_typeof("configuration") = 'object'),
  "encryptedCredentials" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "model_provider_projectId_idx" ON "model_provider"("projectId");
CREATE UNIQUE INDEX "model_provider_id_projectId_key" ON "model_provider"("id", "projectId");
CREATE TABLE "model_configuration" (
  "id" UUID PRIMARY KEY,
  "projectId" UUID NOT NULL REFERENCES "canvas_project"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "providerId" UUID NOT NULL,
  "capability" VARCHAR(100) NOT NULL,
  "model" VARCHAR(200) NOT NULL CHECK (length(btrim("model")) > 0),
  "settings" JSONB NOT NULL CHECK (jsonb_typeof("settings") = 'object'),
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "model_configuration_providerId_projectId_fkey" FOREIGN KEY ("providerId", "projectId") REFERENCES "model_provider"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "model_configuration_projectId_idx" ON "model_configuration"("projectId");
CREATE INDEX "model_configuration_providerId_idx" ON "model_configuration"("providerId");

CREATE FUNCTION "guard_model_provider_identity"() RETURNS TRIGGER AS $$
BEGIN
  IF ROW(NEW."id", NEW."projectId", NEW."name", NEW."pluginId", NEW."pluginVersion", NEW."configuration", NEW."createdAt")
    IS DISTINCT FROM ROW(OLD."id", OLD."projectId", OLD."name", OLD."pluginId", OLD."pluginVersion", OLD."configuration", OLD."createdAt") THEN
    RAISE EXCEPTION 'Model provider configuration is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "model_provider_identity_guard" BEFORE UPDATE ON "model_provider"
  FOR EACH ROW EXECUTE FUNCTION "guard_model_provider_identity"();
CREATE FUNCTION "guard_model_configuration_identity"() RETURNS TRIGGER AS $$
BEGIN
  IF ROW(NEW."id", NEW."projectId", NEW."providerId", NEW."capability", NEW."model", NEW."settings", NEW."createdAt")
    IS DISTINCT FROM ROW(OLD."id", OLD."projectId", OLD."providerId", OLD."capability", OLD."model", OLD."settings", OLD."createdAt") THEN
    RAISE EXCEPTION 'Model capability binding is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "model_configuration_identity_guard" BEFORE UPDATE ON "model_configuration"
  FOR EACH ROW EXECUTE FUNCTION "guard_model_configuration_identity"();
COMMIT;
