import {
  saveWorkflowDraftRequestSchema,
  saveWorkflowDraftResponseSchema,
  workflowResponseSchema,
  type SaveWorkflowDraftRequest,
} from '@dramaflow/contracts';
import { jsonBody, request } from '../../lib/http';

export const workflowKeys = {
  project: (projectId: string) => ['project-workflow', projectId] as const,
};

export const workflowApi = {
  get: (projectId: string) =>
    request(`/projects/${encodeURIComponent(projectId)}/workflow`, workflowResponseSchema),
  initialize: (projectId: string) =>
    request(`/projects/${encodeURIComponent(projectId)}/workflow`, workflowResponseSchema, {
      method: 'POST',
      body: jsonBody({}),
    }),
  saveDraft: (workflowId: string, input: SaveWorkflowDraftRequest) =>
    request(`/workflows/${encodeURIComponent(workflowId)}/draft`, saveWorkflowDraftResponseSchema, {
      method: 'PUT',
      body: jsonBody(saveWorkflowDraftRequestSchema.parse(input)),
    }),
};
