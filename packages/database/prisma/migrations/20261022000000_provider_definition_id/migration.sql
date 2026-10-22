BEGIN;
ALTER TABLE "model_provider"
  ADD COLUMN "providerDefinitionId" VARCHAR(100);
ALTER TABLE "model_provider"
  ADD CONSTRAINT "model_provider_providerDefinitionId_check"
  CHECK (
    "providerDefinitionId" IS NULL
    OR "providerDefinitionId" ~ '^[a-z][a-z0-9_]{0,99}$'
  );

CREATE OR REPLACE FUNCTION "guard_model_provider_identity"() RETURNS TRIGGER AS $$
BEGIN
  IF ROW(
    NEW."id",
    NEW."projectId",
    NEW."name",
    NEW."pluginId",
    NEW."pluginVersion",
    NEW."configuration",
    NEW."providerDefinitionId",
    NEW."createdAt"
  ) IS DISTINCT FROM ROW(
    OLD."id",
    OLD."projectId",
    OLD."name",
    OLD."pluginId",
    OLD."pluginVersion",
    OLD."configuration",
    OLD."providerDefinitionId",
    OLD."createdAt"
  ) THEN
    RAISE EXCEPTION 'Model provider configuration is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
COMMIT;
