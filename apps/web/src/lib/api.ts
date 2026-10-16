import type {
  HumanResponse,
  JsonObject,
  ModelSelection,
  WorkflowDefinition,
  WorkflowDraft,
} from '@dramaflow/contracts';
import {
  chatRequestSchema,
  conversationSummarySchema,
  workspaceMemberSchema,
  createConnectionSchema,
  createWorkflowSchema,
  regenerateSchema,
  saveDraftSchema,
  startRunSchema,
} from '@dramaflow/contracts';
import { request, jsonBody } from './http';
import {
  assetVersionSchema,
  chatReplySchema,
  connectionSchema,
  contextBundleSchema,
  conversationSchema,
  humanTaskSchema,
  messageSchema,
  nodeDefinitionSchema,
  page,
  pluginInstallationSchema,
  proposalSchema,
  runEventSchema,
  runSummarySchema,
  workflowDraftSchema,
  workflowRunSchema,
  workflowSummarySchema,
  workflowValidationSchema,
  workflowVersionSchema,
  workspaceSchema,
} from './api-schemas';

const pathId = (id: string) => encodeURIComponent(id);
const post = (body: unknown = {}) => ({ method: 'POST', body: jsonBody(body) });
export const api = {
  members: (workspaceId: string) => request(`/workspaces/${pathId(workspaceId)}/members`, page(workspaceMemberSchema)),
  addMember: (workspaceId: string, body: { email: string; name: string; password?: string; role: 'admin' | 'editor' | 'viewer' }) =>
    request(`/workspaces/${pathId(workspaceId)}/members`, workspaceMemberSchema.pick({ role: true }).extend({ userId: workspaceMemberSchema.shape.id }), post(body)),
  updateMemberRole: (workspaceId: string, memberId: string, role: 'admin' | 'editor' | 'viewer') =>
    request(`/workspaces/${pathId(workspaceId)}/members/${pathId(memberId)}`, workspaceMemberSchema.pick({ role: true }).extend({ userId: workspaceMemberSchema.shape.id }), { method: 'PUT', body: jsonBody({ role }) }),
  workspaces: () => request('/workspaces', page(workspaceSchema)),
  catalog: () => request('/node-catalog', page(nodeDefinitionSchema)),
  workflows: (workspaceId: string) =>
    request(`/workspaces/${pathId(workspaceId)}/workflows`, page(workflowSummarySchema)),
  createWorkflow: (workspaceId: string, name: string) =>
    request(
      `/workspaces/${pathId(workspaceId)}/workflows`,
      workflowDraftSchema,
      post(createWorkflowSchema.parse({ name })),
    ),
  workflow: (id: string) => request(`/workflows/${pathId(id)}`, workflowDraftSchema),
  saveWorkflow: (
    draft: Pick<WorkflowDraft, 'id' | 'name' | 'description' | 'revision' | 'definition'>,
  ) =>
    request(`/workflows/${pathId(draft.id)}`, workflowDraftSchema, {
      method: 'PUT',
      body: jsonBody(
        saveDraftSchema.parse({
          name: draft.name,
          description: draft.description,
          revision: draft.revision,
          definition: draft.definition,
        }),
      ),
    }),
  validate: (id: string, definition: WorkflowDefinition) =>
    request(`/workflows/${pathId(id)}/validate`, workflowValidationSchema, post({ definition })),
  publish: (id: string) =>
    request(`/workflows/${pathId(id)}/publish`, workflowVersionSchema, post()),
  versions: (id: string) =>
    request(`/workflows/${pathId(id)}/versions`, page(workflowVersionSchema)),
  plugins: (workspaceId: string) =>
    request(`/workspaces/${pathId(workspaceId)}/plugins`, page(pluginInstallationSchema)),
  connections: (workspaceId: string) =>
    request(`/workspaces/${pathId(workspaceId)}/connections`, page(connectionSchema)),
  createConnection: (workspaceId: string, body: unknown) =>
    request(
      `/workspaces/${pathId(workspaceId)}/connections`,
      connectionSchema,
      post(createConnectionSchema.parse(body)),
    ),
  togglePlugin: (workspaceId: string, pluginId: string, version: string, enabled: boolean) =>
    request(
      `/workspaces/${pathId(workspaceId)}/plugins/${pathId(pluginId)}`,
      pluginInstallationSchema,
      { method: 'PUT', body: jsonBody({ enabled, pluginVersion: version }) },
    ),
  runs: (workflowId: string) =>
    request(`/workflows/${pathId(workflowId)}/runs`, page(runSummarySchema)),
  startRun: (workflowId: string, input: JsonObject, versionId: string) =>
    request(
      `/workflows/${pathId(workflowId)}/runs`,
      workflowRunSchema,
      post(startRunSchema.parse({ input, versionId, idempotencyKey: crypto.randomUUID() })),
    ),
  run: (runId: string) => request(`/runs/${pathId(runId)}`, workflowRunSchema),
  events: (runId: string) => request(`/runs/${pathId(runId)}/events`, page(runEventSchema)),
  tasks: (runId: string) => request(`/runs/${pathId(runId)}/tasks`, page(humanTaskSchema)),
  respond: (taskId: string, response: HumanResponse) =>
    request(`/tasks/${pathId(taskId)}/respond`, humanTaskSchema, post(response)),
  cancel: (runId: string) => request(`/runs/${pathId(runId)}/cancel`, workflowRunSchema, post()),
  regenerate: (
    runId: string,
    nodeId: string,
    continueDownstream: boolean,
    configOverrides?: JsonObject,
  ) =>
    request(
      `/runs/${pathId(runId)}/regenerate`,
      workflowRunSchema,
      post(
        regenerateSchema.parse({
          nodeId,
          continueDownstream,
          configOverrides,
          idempotencyKey: crypto.randomUUID(),
        }),
      ),
    ),
  conversations: (workflowId: string) =>
    request(`/workflows/${pathId(workflowId)}/conversations`, page(conversationSchema)),
  createConversation: (
    workflowId: string,
    scope: 'workflow' | 'node',
    model: ModelSelection,
    nodeId?: string,
  ) =>
    request(
      `/workflows/${pathId(workflowId)}/conversations`,
      conversationSchema,
      post({ scope, model, ...(nodeId ? { nodeId } : {}) }),
    ),
  messages: (conversationId: string) =>
    request(`/conversations/${pathId(conversationId)}/messages`, page(messageSchema)),
  summaries: (conversationId: string) =>
    request(`/conversations/${pathId(conversationId)}/summaries`, page(conversationSummarySchema)),
  summarize: (conversationId: string, idempotencyKey: string) =>
    request(
      `/conversations/${pathId(conversationId)}/summarize`,
      conversationSummarySchema,
      post({ idempotencyKey }),
    ),
  chat: (conversationId: string, content: string, assetVersionIds: string[] = [], runId?: string) =>
    request(`/conversations/${pathId(conversationId)}/messages`, chatReplySchema, {
      ...post(chatRequestSchema.parse({ content, assetVersionIds, runId })),
      headers: { 'Idempotency-Key': crypto.randomUUID() },
    }),
  previewContext: (
    conversationId: string,
    content: string,
    assetVersionIds: string[] = [],
    runId?: string,
  ) =>
    request(
      `/conversations/${pathId(conversationId)}/context-preview`,
      contextBundleSchema,
      post(chatRequestSchema.parse({ content, assetVersionIds, runId })),
    ),
  proposals: (conversationId: string) =>
    request(`/conversations/${pathId(conversationId)}/proposals`, page(proposalSchema)),
  applyProposal: (proposalId: string, baseRevision: number) =>
    request(`/proposals/${pathId(proposalId)}/apply`, workflowDraftSchema, post({ baseRevision })),
  assets: (workspaceId: string) =>
    request(`/workspaces/${pathId(workspaceId)}/assets`, page(assetVersionSchema)),
};

export const queryKeys = {
  members: (id: string) => ['members', id] as const,
  workspaces: ['workspaces'] as const,
  catalog: ['node-catalog'] as const,
  workflows: (id: string) => ['workflows', id] as const,
  workflow: (id: string) => ['workflow', id] as const,
  plugins: (id: string) => ['plugins', id] as const,
  connections: (id: string) => ['connections', id] as const,
  runs: (id: string) => ['runs', id] as const,
  run: (id: string) => ['run', id] as const,
  events: (id: string) => ['run-events', id] as const,
  tasks: (id: string) => ['human-tasks', id] as const,
  conversations: (id: string) => ['conversations', id] as const,
  messages: (id: string) => ['messages', id] as const,
  summaries: (id: string) => ['summaries', id] as const,
  proposals: (id: string) => ['proposals', id] as const,
  assets: (id: string) => ['assets', id] as const,
};
