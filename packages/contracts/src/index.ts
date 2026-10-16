import { z } from 'zod';

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);
export const jsonObjectSchema = z.record(z.string(), jsonValueSchema);
export type JsonSchema = Record<string, JsonValue>;

export const capabilitySchema = z.enum([
  'chat',
  'text.generate',
  'image.generate',
  'video.generate',
]);
export type Capability = z.infer<typeof capabilitySchema>;
export const modelSelectionSchema = z
  .object({
    pluginId: z.string().min(1),
    pluginVersion: z.string().min(1),
    connectionId: z.string().min(1),
    modelId: z.string().min(1),
  })
  .strict();
export type ModelSelection = z.infer<typeof modelSelectionSchema>;
export type ModelBinding = ModelSelection;
export const dataTypeSchema = z.enum([
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
]);
export type DataType = z.infer<typeof dataTypeSchema>;
export interface PortDefinition {
  name: string;
  label: string;
  dataType: DataType;
  required?: boolean;
}
export const nodeTypeSchema = z.enum([
  'input',
  'text',
  'image',
  'video',
  'review',
  'condition',
  'merge',
  'batch',
  'output',
]);
export type NodeType = z.infer<typeof nodeTypeSchema>;
export interface NodeDefinition {
  type: NodeType;
  version: string;
  label: string;
  description: string;
  category: 'flow' | 'generation' | 'data';
  inputs: PortDefinition[];
  outputs: PortDefinition[];
  configSchema: JsonSchema;
  capability?: Capability;
  actions: { regenerate: boolean; editOutput: boolean };
}
export const workflowNodeSchema = z
  .object({
    id: z.string().min(1).max(100),
    type: nodeTypeSchema,
    version: z.string().default('1.0.0'),
    title: z.string().min(1).max(200),
    position: z.object({ x: z.number().finite(), y: z.number().finite() }),
    config: jsonObjectSchema.default({}),
  })
  .strict();
export type WorkflowNode = z.infer<typeof workflowNodeSchema>;
export const controlEdgeSchema = z
  .object({
    id: z.string().min(1),
    source: z.string().min(1),
    target: z.string().min(1),
    sourcePort: z.string().default('out'),
  })
  .strict();
export type ControlEdge = z.infer<typeof controlEdgeSchema>;
export const bindingSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('literal'), value: jsonValueSchema }).strict(),
  z.object({ kind: z.literal('input'), path: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal('node'),
      nodeId: z.string().min(1),
      port: z.string().min(1),
      path: z.string().optional(),
    })
    .strict(),
]);
export type BindingSource = z.infer<typeof bindingSourceSchema>;
export const inputBindingSchema = z
  .object({
    nodeId: z.string().min(1),
    port: z.string().min(1),
    source: bindingSourceSchema,
    optional: z.boolean().default(false),
  })
  .strict();
export type InputBinding = z.infer<typeof inputBindingSchema>;
export const workflowDefinitionSchema = z
  .object({
    schemaVersion: z.literal(1),
    nodes: z.array(workflowNodeSchema).max(300),
    controlEdges: z.array(controlEdgeSchema).max(1500),
    bindings: z.array(inputBindingSchema).max(3000),
  })
  .strict();
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;
export interface ValidationIssue {
  code: string;
  message: string;
  nodeId?: string;
  path?: string;
}
export interface WorkflowValidation {
  valid: boolean;
  issues: ValidationIssue[];
}
export interface WorkflowSummary {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  revision: number;
  publishedVersionId: string | null;
  updatedAt: string;
}
export interface WorkflowDraft extends WorkflowSummary {
  definition: WorkflowDefinition;
}
export interface WorkflowVersion {
  id: string;
  workflowId: string;
  number: number;
  definition: WorkflowDefinition;
  createdAt: string;
}
export interface PageResult<T> {
  items: T[];
}
export interface ApiError {
  code: string;
  message: string;
  details?: JsonValue;
  requestId?: string;
}
export interface Workspace {
  id: string;
  name: string;
  role: 'admin' | 'editor' | 'viewer';
}
export const workspaceMemberSchema = z.object({
  id: z.string(), email: z.string(), name: z.string(),
  role: z.enum(['owner', 'admin', 'editor', 'viewer']),
});
export type WorkspaceMember = z.infer<typeof workspaceMemberSchema>;

export interface ModelDescriptor {
  id: string;
  name: string;
  capabilities: Capability[];
  contextWindow?: number;
  maxOutputTokens?: number;
  inputModalities?: string[];
}
export interface PluginManifest {
  id: string;
  version: string;
  name: string;
  description: string;
  capabilities: Capability[];
  models: ModelDescriptor[];
  connectionSchema: JsonSchema;
  parametersSchema: Partial<Record<Capability, JsonSchema>>;
  supports: {
    streaming: boolean;
    structuredOutput: boolean;
    async: boolean;
    cancellation: boolean;
    idempotency: boolean;
  };
}
export interface PluginInstallation {
  pluginId: string;
  pluginVersion: string;
  enabled: boolean;
  manifest: PluginManifest;
}
export interface PluginConnection {
  id: string;
  workspaceId: string;
  name: string;
  pluginId: string;
  pluginVersion: string;
  configuration: JsonObject;
  hasCredential: boolean;
  createdAt: string;
}
export interface AssetReference {
  assetId: string;
  versionId: string;
  type: 'image' | 'video' | 'audio' | 'file';
  mimeType: string;
  name?: string;
}
export interface AssetVersion extends AssetReference {
  workspaceId: string;
  size: number;
  createdAt: string;
  metadata: JsonObject;
}
export const runStatusSchema = z.enum([
  'queued',
  'running',
  'waiting',
  'succeeded',
  'failed',
  'canceled',
]);
export type RunStatus = z.infer<typeof runStatusSchema>;
export type NodeStatus = 'running' | 'waiting' | 'succeeded' | 'skipped' | 'blocked' | 'failed';
export interface NodeResult {
  status: NodeStatus;
  outputs: JsonObject;
  activePorts: string[];
  error?: { code: string; message: string };
  attemptId?: string;
  reused?: boolean;
}
export interface RunSummary {
  id: string;
  workflowId: string;
  workflowVersionId: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  parentRunId: string | null;
}
export interface WorkflowRun extends RunSummary {
  input: JsonObject;
  nodeResults: Record<string, NodeResult>;
  outputCollections: Record<string, JsonObject>;
  error: ApiError | null;
  invalidatedNodeIds: string[];
}
export type RunEventType =
  | 'run.queued'
  | 'run.started'
  | 'run.waiting'
  | 'run.succeeded'
  | 'run.failed'
  | 'run.canceled'
  | 'node.started'
  | 'node.succeeded'
  | 'node.skipped'
  | 'node.blocked'
  | 'node.failed'
  | 'node.waiting'
  | 'output.collected'
  | 'operation.pending'
  | 'operation.unknown';
export interface RunEvent {
  id: string;
  runId: string;
  sequence: number;
  type: RunEventType;
  nodeId?: string;
  data: JsonObject;
  createdAt: string;
}
export interface HumanTask {
  id: string;
  runId: string;
  nodeId: string;
  interruptId: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'canceled';
  input: JsonObject;
  response: JsonObject | null;
  createdAt: string;
}
export const humanResponseSchema = z
  .object({
    decision: z.enum(['approve', 'reject']),
    values: jsonObjectSchema.optional(),
    feedback: z.string().max(10000).optional(),
    idempotencyKey: z.string().min(1).max(200),
  })
  .strict();
export type HumanResponse = z.infer<typeof humanResponseSchema>;
export interface ExecutionContext {
  runId: string;
  nodeId: string;
  attemptId: string;
  signal?: AbortSignal;
}
export interface NodeExecutor<TInput = JsonObject, TOutput = JsonObject> {
  execute(input: TInput, context: ExecutionContext): Promise<TOutput>;
}

export type ConversationScope = 'workflow' | 'node';
export interface Conversation {
  id: string;
  workflowId: string;
  scope: ConversationScope;
  nodeId: string | null;
  model: ModelSelection;
  createdAt: string;
}
export interface PlatformMessage {
  id: string;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  createdAt: string;
  toolCallId?: string;
  toolCalls?: { id: string; name: string; arguments: JsonObject }[];
}
export interface ContextSource {
  kind: 'workflow' | 'node' | 'run' | 'asset' | 'message' | 'summary' | 'request';
  id: string;
  version?: string;
  label: string;
  included: boolean;
  reason?: string;
  estimatedTokens: number;
}
export interface ContextManifest {
  policyVersion: string;
  workflowRevision: number;
  workflowVersionId?: string;
  runId?: string;
  sources: ContextSource[];
  estimatedInputTokens: number;
  inputBudget: number;
  reservedOutputTokens: number;
  estimation: 'approximate' | 'provider';
}
export interface ContextBundle {
  messages: PlatformMessage[];
  manifest: ContextManifest;
}
export interface ConversationSummary {
  id: string;
  content: string;
  throughMessageId: string;
  messageIds: string[];
  createdAt: string;
}
export const conversationSummarySchema: z.ZodType<ConversationSummary> = z.object({
  id: z.string(),
  content: z.string(),
  throughMessageId: z.string(),
  messageIds: z.array(z.string()),
  createdAt: z.string(),
});
export interface WorkflowChange {
  kind:
    | 'updateNodeConfig'
    | 'renameNode'
    | 'addNode'
    | 'removeNode'
    | 'addControlEdge'
    | 'removeControlEdge'
    | 'setBinding'
    | 'removeBinding';
  nodeId?: string;
  value: JsonValue;
}
export interface WorkflowChangeProposal {
  id: string;
  conversationId: string;
  workflowId: string;
  baseRevision: number;
  title: string;
  explanation: string;
  changes: WorkflowChange[];
  status: 'pending' | 'applied' | 'rejected';
  createdAt: string;
}
export interface ChatReply {
  message: PlatformMessage;
  context: ContextManifest;
  proposal?: WorkflowChangeProposal;
}

export const createWorkflowSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().max(2000).default(''),
  })
  .strict();
export const saveDraftSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().max(2000).default(''),
    revision: z.number().int().nonnegative(),
    definition: workflowDefinitionSchema,
  })
  .strict();
export const startRunSchema = z
  .object({
    versionId: z.string().optional(),
    input: jsonObjectSchema.default({}),
    idempotencyKey: z.string().min(1).max(200),
  })
  .strict();
export const regenerateSchema = z
  .object({
    nodeId: z.string().min(1),
    continueDownstream: z.boolean(),
    idempotencyKey: z.string().min(1).max(200),
    configOverrides: jsonObjectSchema.optional(),
  })
  .strict();
export const createConnectionSchema = z
  .object({
    name: z.string().min(1).max(120),
    pluginId: z.string().min(1),
    pluginVersion: z.string().min(1),
    configuration: jsonObjectSchema,
    credential: z.string().min(1).max(20000),
  })
  .strict();
export const createConversationSchema = z
  .object({
    scope: z.enum(['workflow', 'node']),
    nodeId: z.string().optional(),
    model: modelSelectionSchema,
  })
  .strict();
export const chatRequestSchema = z
  .object({
    content: z.string().trim().min(1).max(50000),
    runId: z.string().optional(),
    assetVersionIds: z.array(z.string()).max(30).default([]),
  })
  .strict();

/** 可编辑的起始模板不预选模型、不包含示例运行结果。 */
export const emptyWorkflowDefinition: WorkflowDefinition = {
  schemaVersion: 1,
  nodes: [
    {
      id: 'input',
      type: 'input',
      version: '1.0.0',
      title: '工作流输入',
      position: { x: 80, y: 160 },
      config: {},
    },
    {
      id: 'output',
      type: 'output',
      version: '1.0.0',
      title: '收集结果',
      position: { x: 460, y: 160 },
      config: {},
    },
  ],
  controlEdges: [{ id: 'input-output', source: 'input', target: 'output', sourcePort: 'out' }],
  bindings: [
    {
      nodeId: 'output',
      port: 'result',
      source: { kind: 'node', nodeId: 'input', port: 'value' },
      optional: false,
    },
  ],
};
