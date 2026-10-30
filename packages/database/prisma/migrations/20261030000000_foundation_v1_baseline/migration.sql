-- Foundation v1：直接创建当前 canonical ORM 结构及数据库不变量。
BEGIN;
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "auth_user" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "role" VARCHAR(32) NOT NULL DEFAULT 'user',
    "banned" BOOLEAN NOT NULL DEFAULT false,
    "banReason" TEXT,
    "banExpires" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "auth_user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_profile" (
    "userId" TEXT NOT NULL,
    "bio" VARCHAR(280) NOT NULL DEFAULT '',
    "locale" VARCHAR(32) NOT NULL DEFAULT 'zh-CN',
    "timeZone" VARCHAR(64) NOT NULL DEFAULT 'Asia/Shanghai',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_profile_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "auth_session" (
    "id" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "token" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "impersonatedBy" TEXT,
    "userId" TEXT NOT NULL,

    CONSTRAINT "auth_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_account" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "scope" TEXT,
    "password" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "auth_account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_verification" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "auth_verification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_rate_limit" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "lastRequest" BIGINT NOT NULL,

    CONSTRAINT "auth_rate_limit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "canvas_project" (
    "id" UUID NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "viewport" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "canvas_project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow" (
    "id" TEXT NOT NULL,
    "projectId" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "draft" JSONB NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workflow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_version" (
    "id" TEXT NOT NULL,
    "workflowId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "sourceRevision" INTEGER NOT NULL,
    "definition" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_run" (
    "id" TEXT NOT NULL,
    "projectId" UUID NOT NULL,
    "workflowId" TEXT NOT NULL,
    "workflowVersionId" TEXT NOT NULL,
    "invocationKey" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "inputs" JSONB NOT NULL,
    "outputs" JSONB,
    "error" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancellationRequestedAt" TIMESTAMP(3),
    "waitingRevision" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "workflow_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "node_occurrence" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "workflowRunId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "node_occurrence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "node_run" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "workflowRunId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "occurrenceId" UUID NOT NULL,
    "childExecutionId" UUID,
    "attempt" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "inputs" JSONB,
    "outputs" JSONB,
    "error" JSONB,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "node_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "artifact" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "workflowRunId" TEXT NOT NULL,
    "nodeRunId" UUID,
    "nodeId" TEXT NOT NULL,
    "outputKey" TEXT NOT NULL,
    "type" JSONB NOT NULL,
    "contentKind" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "checksum" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'writing',
    "failureStage" TEXT,
    "cleanupRequired" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "artifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "model_provider" (
    "id" UUID NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "pluginId" VARCHAR(100) NOT NULL,
    "pluginVersion" INTEGER NOT NULL,
    "configuration" JSONB NOT NULL,
    "providerDefinitionId" VARCHAR(100),
    "encryptedCredentials" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "model_provider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "model_configuration" (
    "id" UUID NOT NULL,
    "ownerId" TEXT NOT NULL,
    "providerId" UUID NOT NULL,
    "capability" VARCHAR(100) NOT NULL,
    "model" VARCHAR(200) NOT NULL,
    "settings" JSONB NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "model_configuration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_execution_outbox" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "workflowRunId" TEXT NOT NULL,
    "waitingRevision" INTEGER NOT NULL DEFAULT 0,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_execution_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "child_execution" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "workflowRunId" TEXT NOT NULL,
    "parentNodeRunId" UUID NOT NULL,
    "parentNodeId" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "index" INTEGER,
    "kind" TEXT NOT NULL,
    "invocationKey" TEXT NOT NULL,
    "metadata" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "error" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "child_execution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "auth_user_email_key" ON "auth_user"("email");

-- CreateIndex
CREATE UNIQUE INDEX "auth_session_token_key" ON "auth_session"("token");

-- CreateIndex
CREATE INDEX "auth_session_userId_idx" ON "auth_session"("userId");

-- CreateIndex
CREATE INDEX "auth_session_expiresAt_idx" ON "auth_session"("expiresAt");

-- CreateIndex
CREATE INDEX "auth_account_userId_idx" ON "auth_account"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "auth_account_providerId_accountId_key" ON "auth_account"("providerId", "accountId");

-- CreateIndex
CREATE INDEX "auth_verification_identifier_idx" ON "auth_verification"("identifier");

-- CreateIndex
CREATE UNIQUE INDEX "auth_rate_limit_key_key" ON "auth_rate_limit"("key");

-- CreateIndex
CREATE INDEX "canvas_project_ownerId_updatedAt_id_idx" ON "canvas_project"("ownerId", "updatedAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_projectId_key" ON "workflow"("projectId");

-- CreateIndex
CREATE INDEX "workflow_version_workflowId_idx" ON "workflow_version"("workflowId");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_version_workflowId_version_key" ON "workflow_version"("workflowId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_version_workflowId_sourceRevision_key" ON "workflow_version"("workflowId", "sourceRevision");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_run_threadId_key" ON "workflow_run"("threadId");

-- CreateIndex
CREATE INDEX "workflow_run_projectId_idx" ON "workflow_run"("projectId");

-- CreateIndex
CREATE INDEX "workflow_run_workflowId_idx" ON "workflow_run"("workflowId");

-- CreateIndex
CREATE INDEX "workflow_run_workflowVersionId_idx" ON "workflow_run"("workflowVersionId");

-- CreateIndex
CREATE INDEX "workflow_run_status_idx" ON "workflow_run"("status");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_run_id_projectId_key" ON "workflow_run"("id", "projectId");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_run_workflowId_invocationKey_key" ON "workflow_run"("workflowId", "invocationKey");

-- CreateIndex
CREATE UNIQUE INDEX "node_occurrence_workflowRunId_scopeKey_nodeId_key" ON "node_occurrence"("workflowRunId", "scopeKey", "nodeId");

-- CreateIndex
CREATE UNIQUE INDEX "node_occurrence_id_workflowRunId_projectId_nodeId_key" ON "node_occurrence"("id", "workflowRunId", "projectId", "nodeId");

-- CreateIndex
CREATE INDEX "node_run_workflowRunId_idx" ON "node_run"("workflowRunId");

-- CreateIndex
CREATE INDEX "node_run_workflowRunId_nodeId_idx" ON "node_run"("workflowRunId", "nodeId");

-- CreateIndex
CREATE INDEX "node_run_childExecutionId_idx" ON "node_run"("childExecutionId");

-- CreateIndex
CREATE INDEX "node_run_projectId_workflowRunId_idx" ON "node_run"("projectId", "workflowRunId");

-- CreateIndex
CREATE UNIQUE INDEX "node_run_id_workflowRunId_projectId_nodeId_key" ON "node_run"("id", "workflowRunId", "projectId", "nodeId");

-- CreateIndex
CREATE UNIQUE INDEX "node_run_id_workflowRunId_projectId_key" ON "node_run"("id", "workflowRunId", "projectId");

-- CreateIndex
CREATE UNIQUE INDEX "node_run_occurrenceId_attempt_key" ON "node_run"("occurrenceId", "attempt");

-- CreateIndex
ALTER TABLE "artifact" ADD CONSTRAINT "artifact_storageKey_key" UNIQUE ("storageKey");

-- CreateIndex
CREATE INDEX "artifact_projectId_createdAt_idx" ON "artifact"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "artifact_workflowRunId_idx" ON "artifact"("workflowRunId");

-- CreateIndex
CREATE INDEX "artifact_nodeRunId_idx" ON "artifact"("nodeRunId");

-- CreateIndex
CREATE INDEX "artifact_status_idx" ON "artifact"("status");

-- CreateIndex
CREATE INDEX "model_provider_ownerId_idx" ON "model_provider"("ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "model_provider_id_ownerId_key" ON "model_provider"("id", "ownerId");

-- CreateIndex
CREATE INDEX "model_configuration_ownerId_idx" ON "model_configuration"("ownerId");

-- CreateIndex
CREATE INDEX "model_configuration_providerId_idx" ON "model_configuration"("providerId");

-- CreateIndex
CREATE INDEX "workflow_execution_outbox_status_availableAt_createdAt_idx" ON "workflow_execution_outbox"("status", "availableAt", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_execution_outbox_workflowRunId_kind_waitingRevisio_key" ON "workflow_execution_outbox"("workflowRunId", "kind", "waitingRevision");

-- CreateIndex
CREATE INDEX "child_execution_workflowRunId_idx" ON "child_execution"("workflowRunId");

-- CreateIndex
CREATE UNIQUE INDEX "child_execution_parentNodeRunId_index_key" ON "child_execution"("parentNodeRunId", "index");

-- CreateIndex
CREATE UNIQUE INDEX "child_execution_parentNodeRunId_invocationKey_key" ON "child_execution"("parentNodeRunId", "invocationKey");

-- CreateIndex
CREATE UNIQUE INDEX "child_execution_workflowRunId_scopeKey_key" ON "child_execution"("workflowRunId", "scopeKey");

-- CreateIndex
CREATE UNIQUE INDEX "child_execution_id_workflowRunId_projectId_key" ON "child_execution"("id", "workflowRunId", "projectId");

-- AddForeignKey
ALTER TABLE "user_profile" ADD CONSTRAINT "user_profile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "auth_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_session" ADD CONSTRAINT "auth_session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "auth_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_account" ADD CONSTRAINT "auth_account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "auth_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "canvas_project" ADD CONSTRAINT "canvas_project_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "auth_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow" ADD CONSTRAINT "workflow_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "canvas_project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_version" ADD CONSTRAINT "workflow_version_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_run" ADD CONSTRAINT "workflow_run_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "canvas_project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "node_occurrence" ADD CONSTRAINT "node_occurrence_workflowRunId_projectId_fkey" FOREIGN KEY ("workflowRunId", "projectId") REFERENCES "workflow_run"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "node_run" ADD CONSTRAINT "node_run_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "canvas_project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "node_run" ADD CONSTRAINT "node_run_workflowRunId_projectId_fkey" FOREIGN KEY ("workflowRunId", "projectId") REFERENCES "workflow_run"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "node_run" ADD CONSTRAINT "node_run_occurrenceId_workflowRunId_projectId_nodeId_fkey" FOREIGN KEY ("occurrenceId", "workflowRunId", "projectId", "nodeId") REFERENCES "node_occurrence"("id", "workflowRunId", "projectId", "nodeId") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "node_run" ADD CONSTRAINT "node_run_childExecutionId_workflowRunId_projectId_fkey" FOREIGN KEY ("childExecutionId", "workflowRunId", "projectId") REFERENCES "child_execution"("id", "workflowRunId", "projectId") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "artifact" ADD CONSTRAINT "artifact_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "canvas_project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artifact" ADD CONSTRAINT "artifact_workflowRunId_projectId_fkey" FOREIGN KEY ("workflowRunId", "projectId") REFERENCES "workflow_run"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artifact" ADD CONSTRAINT "artifact_nodeRunId_workflowRunId_projectId_fkey" FOREIGN KEY ("nodeRunId", "workflowRunId", "projectId") REFERENCES "node_run"("id", "workflowRunId", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_provider" ADD CONSTRAINT "model_provider_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "auth_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_configuration" ADD CONSTRAINT "model_configuration_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "auth_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_configuration" ADD CONSTRAINT "model_configuration_providerId_ownerId_fkey" FOREIGN KEY ("providerId", "ownerId") REFERENCES "model_provider"("id", "ownerId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_execution_outbox" ADD CONSTRAINT "workflow_execution_outbox_workflowRunId_fkey" FOREIGN KEY ("workflowRunId") REFERENCES "workflow_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "child_execution" ADD CONSTRAINT "child_execution_workflowRunId_projectId_fkey" FOREIGN KEY ("workflowRunId", "projectId") REFERENCES "workflow_run"("id", "projectId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "child_execution" ADD CONSTRAINT "child_execution_parentNodeRunId_workflowRunId_projectId_pa_fkey" FOREIGN KEY ("parentNodeRunId", "workflowRunId", "projectId", "parentNodeId") REFERENCES "node_run"("id", "workflowRunId", "projectId", "nodeId") ON DELETE CASCADE ON UPDATE RESTRICT;


-- Prisma 无法表达的 CHECK、身份 / 生命周期与归属保护。
ALTER TABLE "artifact" ADD CONSTRAINT "artifact_contentKind_check" CHECK (("contentKind" = ANY (ARRAY['json'::text, 'blob'::text])));

ALTER TABLE "artifact" ADD CONSTRAINT "artifact_size_check" CHECK ((size >= 0));

ALTER TABLE "artifact" ADD CONSTRAINT "artifact_status_check" CHECK ((status = ANY (ARRAY['writing'::text, 'ready'::text, 'failed'::text])));

ALTER TABLE "artifact" ADD CONSTRAINT "artifact_write_state" CHECK ((((status = 'writing'::text) AND ("completedAt" IS NULL) AND ("failureStage" IS NULL) AND (NOT "cleanupRequired")) OR ((status = 'ready'::text) AND ("completedAt" IS NOT NULL) AND ("failureStage" IS NULL) AND (NOT "cleanupRequired")) OR ((status = 'failed'::text) AND ("completedAt" IS NOT NULL) AND ("failureStage" = 'upload'::text))));

ALTER TABLE "child_execution" ADD CONSTRAINT "child_execution_index_nonnegative" CHECK ((index >= 0));

ALTER TABLE "child_execution" ADD CONSTRAINT "child_execution_invocation" CHECK (((length(kind) > 0) AND (kind = btrim(kind)) AND (length("invocationKey") > 0) AND ("invocationKey" = btrim("invocationKey")) AND ("scopeKey" <> 'root'::text) AND (jsonb_typeof(metadata) = 'object'::text)));

ALTER TABLE "child_execution" ADD CONSTRAINT "child_execution_iteration_extension" CHECK (
CASE
    WHEN (kind = 'iteration_item'::text) THEN ((index IS NOT NULL) AND (metadata ? 'index'::text) AND (jsonb_typeof((metadata -> 'index'::text)) = 'number'::text) AND ((metadata -> 'index'::text) = to_jsonb(index)) AND ("invocationKey" = ('iteration-item:'::text || (index)::text)))
    ELSE (index IS NULL)
END);

ALTER TABLE "child_execution" ADD CONSTRAINT "child_execution_lifecycle" CHECK ((((status = 'running'::text) AND ("completedAt" IS NULL) AND (error IS NULL)) OR ((status = ANY (ARRAY['completed'::text, 'cancelled'::text])) AND ("completedAt" IS NOT NULL) AND (error IS NULL)) OR ((status = 'failed'::text) AND ("completedAt" IS NOT NULL) AND (error IS NOT NULL))));

ALTER TABLE "child_execution" ADD CONSTRAINT "child_execution_scope_nonempty" CHECK (((length("scopeKey") > 0) AND ("scopeKey" = btrim("scopeKey"))));

ALTER TABLE "model_configuration" ADD CONSTRAINT "model_configuration_model_check" CHECK ((length(btrim((model)::text)) > 0));

ALTER TABLE "model_configuration" ADD CONSTRAINT "model_configuration_settings_check" CHECK ((jsonb_typeof(settings) = 'object'::text));

ALTER TABLE "model_provider" ADD CONSTRAINT "model_provider_configuration_check" CHECK ((jsonb_typeof(configuration) = 'object'::text));

ALTER TABLE "model_provider" ADD CONSTRAINT "model_provider_pluginVersion_check" CHECK (("pluginVersion" > 0));

ALTER TABLE "model_provider" ADD CONSTRAINT "model_provider_providerDefinitionId_check" CHECK ((("providerDefinitionId" IS NULL) OR (("providerDefinitionId")::text ~ '^[a-z][a-z0-9_]{0,99}$'::text)));

ALTER TABLE "node_occurrence" ADD CONSTRAINT "node_occurrence_node_nonempty" CHECK (((length("nodeId") > 0) AND ("nodeId" = btrim("nodeId"))));

ALTER TABLE "node_occurrence" ADD CONSTRAINT "node_occurrence_scope_nonempty" CHECK (((length("scopeKey") > 0) AND ("scopeKey" = btrim("scopeKey"))));

ALTER TABLE "node_run" ADD CONSTRAINT "node_run_attempt_positive" CHECK ((attempt > 0));

ALTER TABLE "node_run" ADD CONSTRAINT "node_run_inputs_object" CHECK (((inputs IS NULL) OR (jsonb_typeof(inputs) = 'object'::text)));

ALTER TABLE "node_run" ADD CONSTRAINT "node_run_lifecycle" CHECK ((((status = 'running'::text) AND ("completedAt" IS NULL) AND (outputs IS NULL) AND (error IS NULL)) OR ((status = 'completed'::text) AND ("completedAt" IS NOT NULL) AND (inputs IS NOT NULL) AND (outputs IS NOT NULL) AND (error IS NULL)) OR ((status = 'failed'::text) AND ("completedAt" IS NOT NULL) AND (outputs IS NULL) AND (error IS NOT NULL)) OR ((status = 'cancelled'::text) AND ("completedAt" IS NOT NULL) AND (outputs IS NULL) AND (error IS NULL))));

ALTER TABLE "node_run" ADD CONSTRAINT "node_run_outputs_object" CHECK (((outputs IS NULL) OR (jsonb_typeof(outputs) = 'object'::text)));

ALTER TABLE "workflow" ADD CONSTRAINT "workflow_draft_object" CHECK ((jsonb_typeof(draft) = 'object'::text));

ALTER TABLE "workflow" ADD CONSTRAINT "workflow_revision_positive" CHECK ((revision > 0));

ALTER TABLE "workflow_execution_outbox" ADD CONSTRAINT "workflow_execution_outbox_attempts_check" CHECK ((attempts >= 0));

ALTER TABLE "workflow_execution_outbox" ADD CONSTRAINT "workflow_execution_outbox_kind_check" CHECK ((kind = ANY (ARRAY['start'::text, 'resume'::text])));

ALTER TABLE "workflow_execution_outbox" ADD CONSTRAINT "workflow_execution_outbox_status_check" CHECK ((status = ANY (ARRAY['pending'::text, 'published'::text, 'executing'::text, 'completed'::text, 'failed'::text, 'recovery_required'::text, 'cancelled'::text])));

ALTER TABLE "workflow_execution_outbox" ADD CONSTRAINT "workflow_execution_outbox_waitingRevision_check" CHECK (("waitingRevision" >= 0));

ALTER TABLE "workflow_execution_outbox" ADD CONSTRAINT "workflow_execution_payload_identity" CHECK ((((jsonb_typeof(payload) = 'object'::text) AND ((payload ->> 'kind'::text) = kind) AND ((payload ->> 'workflowRunId'::text) = "workflowRunId") AND (((kind = 'start'::text) AND ("waitingRevision" = 0) AND (payload = jsonb_build_object('kind', 'start', 'workflowRunId', "workflowRunId"))) OR ((kind = 'resume'::text) AND ("waitingRevision" >= 0) AND ((payload ->> 'executionId'::text) = id) AND (payload ? 'value'::text) AND ((payload - ARRAY['kind'::text, 'workflowRunId'::text, 'executionId'::text, 'value'::text]) = '{}'::jsonb)))) IS TRUE));

ALTER TABLE "workflow_run" ADD CONSTRAINT "workflow_run_error_object" CHECK (((error IS NULL) OR (jsonb_typeof(error) = 'object'::text)));

ALTER TABLE "workflow_run" ADD CONSTRAINT "workflow_run_inputs_object" CHECK ((jsonb_typeof(inputs) = 'object'::text));

ALTER TABLE "workflow_run" ADD CONSTRAINT "workflow_run_lifecycle" CHECK ((((status = 'pending'::text) AND ("startedAt" IS NULL) AND ("completedAt" IS NULL) AND (outputs IS NULL) AND (error IS NULL)) OR ((status = ANY (ARRAY['running'::text, 'waiting'::text])) AND ("startedAt" IS NOT NULL) AND ("completedAt" IS NULL) AND (outputs IS NULL) AND (error IS NULL)) OR ((status = 'completed'::text) AND ("startedAt" IS NOT NULL) AND ("completedAt" IS NOT NULL) AND (outputs IS NOT NULL) AND (error IS NULL)) OR ((status = 'failed'::text) AND ("startedAt" IS NOT NULL) AND ("completedAt" IS NOT NULL) AND (outputs IS NULL) AND (error IS NOT NULL)) OR ((status = 'cancelled'::text) AND ("completedAt" IS NOT NULL) AND (outputs IS NULL) AND (error IS NULL) AND (("startedAt" IS NOT NULL) OR ("cancellationRequestedAt" IS NOT NULL)))));

ALTER TABLE "workflow_run" ADD CONSTRAINT "workflow_run_outputs_object" CHECK (((outputs IS NULL) OR (jsonb_typeof(outputs) = 'object'::text)));

ALTER TABLE "workflow_run" ADD CONSTRAINT "workflow_run_waitingRevision_check" CHECK (("waitingRevision" >= 0));

ALTER TABLE "workflow_version" ADD CONSTRAINT "workflow_version_definition_object" CHECK ((jsonb_typeof(definition) = 'object'::text));

ALTER TABLE "workflow_version" ADD CONSTRAINT "workflow_version_number_positive" CHECK ((version > 0));

ALTER TABLE "workflow_version" ADD CONSTRAINT "workflow_version_source_revision_positive" CHECK (("sourceRevision" > 0));

CREATE OR REPLACE FUNCTION public.advance_workflow_waiting_revision()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."waitingRevision" IS DISTINCT FROM OLD."waitingRevision" THEN
    RAISE EXCEPTION 'Workflow waiting revision is managed by lifecycle' USING ERRCODE = '23514';
  END IF;
  IF OLD."status" = 'running' AND NEW."status" = 'waiting' THEN
    NEW."waitingRevision" := OLD."waitingRevision" + 1;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.guard_artifact_write()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF ROW(NEW."id", NEW."projectId", NEW."workflowRunId", NEW."nodeRunId", NEW."nodeId", NEW."outputKey", NEW."type", NEW."contentKind", NEW."storageKey", NEW."mimeType", NEW."size", NEW."checksum", NEW."createdAt")
    IS DISTINCT FROM ROW(OLD."id", OLD."projectId", OLD."workflowRunId", OLD."nodeRunId", OLD."nodeId", OLD."outputKey", OLD."type", OLD."contentKind", OLD."storageKey", OLD."mimeType", OLD."size", OLD."checksum", OLD."createdAt") THEN
    RAISE EXCEPTION 'Artifact content identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD."status" <> 'writing' OR NEW."status" NOT IN ('ready', 'failed') THEN
    RAISE EXCEPTION 'Invalid artifact write transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.guard_child_execution_update()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF ROW(NEW."id", NEW."projectId", NEW."workflowRunId", NEW."parentNodeRunId", NEW."parentNodeId", NEW."scopeKey", NEW."kind", NEW."invocationKey", NEW."metadata", NEW."index", NEW."createdAt", NEW."startedAt")
    IS DISTINCT FROM ROW(OLD."id", OLD."projectId", OLD."workflowRunId", OLD."parentNodeRunId", OLD."parentNodeId", OLD."scopeKey", OLD."kind", OLD."invocationKey", OLD."metadata", OLD."index", OLD."createdAt", OLD."startedAt") THEN
    RAISE EXCEPTION 'ChildExecution identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD."status" <> 'running' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'ChildExecution terminal record is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.guard_model_configuration_identity()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF ROW(NEW."id", NEW."ownerId", NEW."providerId", NEW."capability", NEW."model", NEW."settings", NEW."createdAt")
    IS DISTINCT FROM ROW(OLD."id", OLD."ownerId", OLD."providerId", OLD."capability", OLD."model", OLD."settings", OLD."createdAt") THEN
    RAISE EXCEPTION 'Model capability binding is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.guard_model_provider_identity()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF ROW(NEW."id", NEW."ownerId", NEW."name", NEW."pluginId", NEW."pluginVersion", NEW."configuration", NEW."providerDefinitionId", NEW."createdAt")
    IS DISTINCT FROM ROW(OLD."id", OLD."ownerId", OLD."name", OLD."pluginId", OLD."pluginVersion", OLD."configuration", OLD."providerDefinitionId", OLD."createdAt") THEN
    RAISE EXCEPTION 'Model provider configuration is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.guard_node_occurrence_update()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'NodeOccurrence identity is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.guard_node_run_child_scope()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE occurrence_scope TEXT; child_scope TEXT;
BEGIN
  SELECT "scopeKey" INTO occurrence_scope FROM "node_occurrence" WHERE "id" = NEW."occurrenceId";
  IF NEW."childExecutionId" IS NULL THEN
    IF occurrence_scope <> 'root' THEN
      RAISE EXCEPTION 'Non-root NodeRun requires ChildExecution' USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT "scopeKey" INTO child_scope FROM "child_execution" WHERE "id" = NEW."childExecutionId";
    IF child_scope IS NULL OR child_scope IS DISTINCT FROM occurrence_scope OR occurrence_scope = 'root' THEN
      RAISE EXCEPTION 'NodeRun child execution scope mismatch' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.guard_node_run_identity_update()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF ROW(NEW."id", NEW."projectId", NEW."workflowRunId", NEW."nodeId", NEW."occurrenceId", NEW."childExecutionId", NEW."attempt", NEW."startedAt")
    IS DISTINCT FROM ROW(OLD."id", OLD."projectId", OLD."workflowRunId", OLD."nodeId", OLD."occurrenceId", OLD."childExecutionId", OLD."attempt", OLD."startedAt") THEN
    RAISE EXCEPTION 'NodeRun occurrence, child execution and attempt identity are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.guard_node_run_terminal()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD."status" <> 'running' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'NodeRun terminal record is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.guard_workflow_execution_intent()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF ROW(NEW."id", NEW."kind", NEW."workflowRunId", NEW."waitingRevision", NEW."payload", NEW."createdAt")
    IS DISTINCT FROM ROW(OLD."id", OLD."kind", OLD."workflowRunId", OLD."waitingRevision", OLD."payload", OLD."createdAt") THEN
    RAISE EXCEPTION 'Workflow execution intent is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.guard_workflow_run_update()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF ROW(NEW."id", NEW."projectId", NEW."workflowId", NEW."workflowVersionId", NEW."threadId", NEW."invocationKey", NEW."inputs", NEW."createdAt")
    IS DISTINCT FROM ROW(OLD."id", OLD."projectId", OLD."workflowId", OLD."workflowVersionId", OLD."threadId", OLD."invocationKey", OLD."inputs", OLD."createdAt") THEN
    RAISE EXCEPTION 'WorkflowRun identity, version and inputs are immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD."startedAt" IS NOT NULL AND NEW."startedAt" IS DISTINCT FROM OLD."startedAt" THEN
    RAISE EXCEPTION 'WorkflowRun startedAt is immutable after start' USING ERRCODE = '23514';
  END IF;
  IF OLD."cancellationRequestedAt" IS NOT NULL AND NEW."cancellationRequestedAt" IS DISTINCT FROM OLD."cancellationRequestedAt" THEN
    RAISE EXCEPTION 'WorkflowRun cancellation request is immutable' USING ERRCODE = '23514';
  END IF;
  IF NOT (
    (OLD."status" IN ('pending', 'waiting') AND NEW."status" = 'running' AND NEW."cancellationRequestedAt" IS NULL) OR
    (OLD."status" = 'running' AND NEW."status" IN ('waiting', 'completed', 'failed')) OR
    (OLD."status" IN ('pending', 'running', 'waiting') AND NEW."status" = 'cancelled' AND NEW."cancellationRequestedAt" IS NOT NULL AND (OLD."status" <> 'pending' OR NEW."startedAt" IS NULL)) OR
    -- 不改变执行状态，只首次写取消意图；终态不接受新请求或任何更新。
    (OLD."status" IN ('pending', 'running', 'waiting') AND NEW."status" = OLD."status" AND OLD."cancellationRequestedAt" IS NULL AND NEW."cancellationRequestedAt" IS NOT NULL AND
      (to_jsonb(NEW) - 'cancellationRequestedAt') = (to_jsonb(OLD) - 'cancellationRequestedAt'))
  ) THEN
    RAISE EXCEPTION 'Invalid WorkflowRun status transition' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.guard_workflow_version_update()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'WorkflowVersion is immutable' USING ERRCODE = '23514';
END;
$function$;

CREATE TRIGGER artifact_write_guard BEFORE UPDATE ON public.artifact FOR EACH ROW EXECUTE FUNCTION guard_artifact_write();

CREATE TRIGGER child_execution_update_guard BEFORE UPDATE ON public.child_execution FOR EACH ROW EXECUTE FUNCTION guard_child_execution_update();

CREATE TRIGGER model_configuration_identity_guard BEFORE UPDATE ON public.model_configuration FOR EACH ROW EXECUTE FUNCTION guard_model_configuration_identity();

CREATE TRIGGER model_provider_identity_guard BEFORE UPDATE ON public.model_provider FOR EACH ROW EXECUTE FUNCTION guard_model_provider_identity();

CREATE TRIGGER node_occurrence_update_guard BEFORE UPDATE ON public.node_occurrence FOR EACH ROW EXECUTE FUNCTION guard_node_occurrence_update();

CREATE TRIGGER node_run_child_scope_guard BEFORE INSERT ON public.node_run FOR EACH ROW EXECUTE FUNCTION guard_node_run_child_scope();

CREATE TRIGGER node_run_identity_update_guard BEFORE UPDATE ON public.node_run FOR EACH ROW EXECUTE FUNCTION guard_node_run_identity_update();

CREATE TRIGGER node_run_terminal_guard BEFORE UPDATE ON public.node_run FOR EACH ROW EXECUTE FUNCTION guard_node_run_terminal();

CREATE TRIGGER workflow_execution_intent_guard BEFORE UPDATE ON public.workflow_execution_outbox FOR EACH ROW EXECUTE FUNCTION guard_workflow_execution_intent();

CREATE TRIGGER workflow_run_update_guard BEFORE UPDATE ON public.workflow_run FOR EACH ROW EXECUTE FUNCTION guard_workflow_run_update();

CREATE TRIGGER workflow_waiting_revision_guard BEFORE UPDATE ON public.workflow_run FOR EACH ROW EXECUTE FUNCTION advance_workflow_waiting_revision();

CREATE TRIGGER workflow_version_update_guard BEFORE UPDATE ON public.workflow_version FOR EACH ROW EXECUTE FUNCTION guard_workflow_version_update();
COMMIT;
