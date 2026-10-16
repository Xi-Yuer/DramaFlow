import { z } from 'zod';
import {
  capabilitySchema,
  jsonObjectSchema,
  jsonValueSchema,
  modelSelectionSchema,
  nodeTypeSchema,
  runStatusSchema,
  workflowDefinitionSchema,
} from '@dramaflow/contracts';
import type {
  AssetVersion,
  ChatReply,
  ContextBundle,
  Conversation,
  HumanTask,
  NodeDefinition,
  PlatformMessage,
  PluginConnection,
  PluginInstallation,
  RunEvent,
  RunSummary,
  WorkflowChangeProposal,
  WorkflowDraft,
  WorkflowRun,
  WorkflowSummary,
  WorkflowValidation,
  WorkflowVersion,
  Workspace,
} from '@dramaflow/contracts';

const jsonSchema = z.record(z.string(), jsonValueSchema);
const portSchema = z.object({
  name: z.string(),
  label: z.string(),
  dataType: z.enum([
    'text',
    'number',
    'boolean',
    'json',
    'image',
    'video',
    'audio',
    'file',
    'array',
    'any',
  ]),
  required: z.boolean().optional(),
});
export const workspaceSchema: z.ZodType<Workspace> = z.object({
  id: z.string(),
  name: z.string(),
  role: z.enum(['admin', 'editor', 'viewer']),
});
export const nodeDefinitionSchema: z.ZodType<NodeDefinition> = z.object({
  type: nodeTypeSchema,
  version: z.string(),
  label: z.string(),
  description: z.string(),
  category: z.enum(['flow', 'generation', 'data']),
  inputs: z.array(portSchema),
  outputs: z.array(portSchema),
  configSchema: jsonSchema,
  capability: capabilitySchema.optional(),
  actions: z.object({ regenerate: z.boolean(), editOutput: z.boolean() }),
});
const summaryShape = {
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  description: z.string(),
  revision: z.number(),
  publishedVersionId: z.string().nullable(),
  updatedAt: z.string(),
};
export const workflowSummarySchema: z.ZodType<WorkflowSummary> = z.object(summaryShape);
export const workflowDraftSchema: z.ZodType<WorkflowDraft> = z.object({
  ...summaryShape,
  definition: workflowDefinitionSchema,
});
export const workflowVersionSchema: z.ZodType<WorkflowVersion> = z.object({
  id: z.string(),
  workflowId: z.string(),
  number: z.number(),
  definition: workflowDefinitionSchema,
  createdAt: z.string(),
});
export const workflowValidationSchema: z.ZodType<WorkflowValidation> = z.object({
  valid: z.boolean(),
  issues: z.array(
    z.object({
      code: z.string(),
      message: z.string(),
      nodeId: z.string().optional(),
      path: z.string().optional(),
    }),
  ),
});
const manifestSchema = z.object({
  id: z.string(),
  version: z.string(),
  name: z.string(),
  description: z.string(),
  capabilities: z.array(capabilitySchema),
  models: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      capabilities: z.array(capabilitySchema),
      contextWindow: z.number().optional(),
      maxOutputTokens: z.number().optional(),
      inputModalities: z.array(z.string()).optional(),
    }),
  ),
  connectionSchema: jsonSchema,
  parametersSchema: z.partialRecord(capabilitySchema, jsonSchema),
  supports: z.object({
    streaming: z.boolean(),
    structuredOutput: z.boolean(),
    async: z.boolean(),
    cancellation: z.boolean(),
    idempotency: z.boolean(),
  }),
});
export const pluginInstallationSchema: z.ZodType<PluginInstallation> = z.object({
  pluginId: z.string(),
  pluginVersion: z.string(),
  enabled: z.boolean(),
  manifest: manifestSchema,
});
export const connectionSchema: z.ZodType<PluginConnection> = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  pluginId: z.string(),
  pluginVersion: z.string(),
  configuration: jsonObjectSchema,
  hasCredential: z.boolean(),
  createdAt: z.string(),
});
const runSummaryShape = {
  id: z.string(),
  workflowId: z.string(),
  workflowVersionId: z.string(),
  status: runStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  parentRunId: z.string().nullable(),
};
export const runSummarySchema: z.ZodType<RunSummary> = z.object(runSummaryShape);
export const workflowRunSchema: z.ZodType<WorkflowRun> = z.object({
  ...runSummaryShape,
  input: jsonObjectSchema,
  nodeResults: z.record(
    z.string(),
    z.object({
      status: z.enum(['running', 'waiting', 'succeeded', 'skipped', 'blocked', 'failed']),
      outputs: jsonObjectSchema,
      activePorts: z.array(z.string()),
      error: z.object({ code: z.string(), message: z.string() }).optional(),
      attemptId: z.string().optional(),
      reused: z.boolean().optional(),
    }),
  ),
  outputCollections: z.record(z.string(), jsonObjectSchema),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      details: jsonValueSchema.optional(),
      requestId: z.string().optional(),
    })
    .nullable(),
  invalidatedNodeIds: z.array(z.string()),
});
export const runEventSchema: z.ZodType<RunEvent> = z.object({
  id: z.string(),
  runId: z.string(),
  sequence: z.number(),
  type: z.enum([
    'run.queued',
    'run.started',
    'run.waiting',
    'run.succeeded',
    'run.failed',
    'run.canceled',
    'node.started',
    'node.succeeded',
    'node.skipped',
    'node.blocked',
    'node.failed',
    'node.waiting',
    'output.collected',
    'operation.pending',
    'operation.unknown',
  ]),
  nodeId: z.string().optional(),
  data: jsonObjectSchema,
  createdAt: z.string(),
});
export const humanTaskSchema: z.ZodType<HumanTask> = z.object({
  id: z.string(),
  runId: z.string(),
  nodeId: z.string(),
  interruptId: z.string().nullable(),
  status: z.enum(['pending', 'approved', 'rejected', 'canceled']),
  input: jsonObjectSchema,
  response: jsonObjectSchema.nullable(),
  createdAt: z.string(),
});
export const conversationSchema: z.ZodType<Conversation> = z.object({
  id: z.string(),
  workflowId: z.string(),
  scope: z.enum(['workflow', 'node']),
  nodeId: z.string().nullable(),
  model: modelSelectionSchema,
  createdAt: z.string(),
});
export const messageSchema: z.ZodType<PlatformMessage> = z.object({
  id: z.string(),
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string(),
  createdAt: z.string(),
  toolCallId: z.string().optional(),
  toolCalls: z
    .array(z.object({ id: z.string(), name: z.string(), arguments: jsonObjectSchema }))
    .optional(),
});
export const contextManifestSchema = z.object({
  policyVersion: z.string(),
  workflowRevision: z.number(),
  workflowVersionId: z.string().optional(),
  runId: z.string().optional(),
  sources: z.array(
    z.object({
      kind: z.enum(['workflow', 'node', 'run', 'asset', 'message', 'summary', 'request']),
      id: z.string(),
      version: z.string().optional(),
      label: z.string(),
      included: z.boolean(),
      reason: z.string().optional(),
      estimatedTokens: z.number(),
    }),
  ),
  estimatedInputTokens: z.number(),
  inputBudget: z.number(),
  reservedOutputTokens: z.number(),
  estimation: z.enum(['approximate', 'provider']),
});
export const contextBundleSchema: z.ZodType<ContextBundle> = z.object({
  messages: z.array(messageSchema),
  manifest: contextManifestSchema,
});
export const proposalSchema: z.ZodType<WorkflowChangeProposal> = z.object({
  id: z.string(),
  conversationId: z.string(),
  workflowId: z.string(),
  baseRevision: z.number(),
  title: z.string(),
  explanation: z.string(),
  changes: z.array(
    z.object({
      kind: z.enum([
        'updateNodeConfig',
        'renameNode',
        'addNode',
        'removeNode',
        'addControlEdge',
        'removeControlEdge',
        'setBinding',
        'removeBinding',
      ]),
      nodeId: z.string().optional(),
      value: jsonValueSchema,
    }),
  ),
  status: z.enum(['pending', 'applied', 'rejected']),
  createdAt: z.string(),
});
export const chatReplySchema: z.ZodType<ChatReply> = z.object({
  message: messageSchema,
  context: contextManifestSchema,
  proposal: proposalSchema.optional(),
});
export const assetVersionSchema: z.ZodType<AssetVersion> = z.object({
  assetId: z.string(),
  versionId: z.string(),
  type: z.enum(['image', 'video', 'audio', 'file']),
  mimeType: z.string(),
  name: z.string().optional(),
  workspaceId: z.string(),
  size: z.number(),
  createdAt: z.string(),
  metadata: jsonObjectSchema,
});
export const page = <T>(schema: z.ZodType<T>) => z.object({ items: z.array(schema) });
