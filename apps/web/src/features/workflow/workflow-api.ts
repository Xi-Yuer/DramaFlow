import {
  cancelWorkflowRunRequestSchema,
  cancelWorkflowRunResponseSchema,
  executionTreeQuerySchema,
  workflowRunHistoryResponseSchema,
  executionTreeResponseSchema,
  nodeRunSchema,
  publishWorkflowRequestSchema,
  pendingHumanReviewsResponseSchema,
  resumeWorkflowRunRequestSchema,
  type ExecutionTreeQuery,
  type ResumeWorkflowRunRequest,
  startWorkflowRunRequestSchema,
  workflowRunResponseSchema,
  workflowInvocationLookupResponseSchema,
  workflowVersionResponseSchema,
  workflowVersionListResponseSchema,
  saveWorkflowDraftRequestSchema,
  saveWorkflowDraftResponseSchema,
  workflowResponseSchema,
  type SaveWorkflowDraftRequest,
  type StartWorkflowRunRequest,
} from '@dramaflow/contracts';
import { z } from 'zod';
import type { WorkflowPublicationStatus } from './publish/workflow-publish';
import { ApiError, jsonBody, request } from '../../lib/http';

const workflowNodeRunsResponseSchema = z.object({ items: z.array(nodeRunSchema) }).strict();

export const workflowKeys = {
  runHistory: (projectId: string, workflowId: string) =>
    ['workflow-run-history', projectId, workflowId] as const,
  version: (versionId: string) => ['workflow-version', versionId] as const,
  versions: (workflowId: string) => ['workflow-versions', workflowId] as const,
  publication: (workflowId: string, revision: number) =>
    ['workflow-versions', workflowId, revision] as const,
  project: (projectId: string) => ['project-workflow', projectId] as const,
};

export const workflowApi = {
  cancelRun: (projectId: string, workflowId: string, runId: string) =>
    request(
      `/projects/${encodeURIComponent(projectId)}/workflows/${encodeURIComponent(workflowId)}/runs/${encodeURIComponent(runId)}/cancel`,
      cancelWorkflowRunResponseSchema,
      {
        method: 'POST',
        body: jsonBody(cancelWorkflowRunRequestSchema.parse({})),
      },
    ),
  listRuns: (projectId: string, workflowId: string, cursor?: string, signal?: AbortSignal) =>
    request(
      `/projects/${encodeURIComponent(projectId)}/workflows/${encodeURIComponent(workflowId)}/runs${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
      workflowRunHistoryResponseSchema,
      { signal },
    ),
  lookupInvocation: (workflowId: string, invocationKey: string) =>
    request(
      `/workflow-runs/by-invocation/${encodeURIComponent(workflowId)}/${encodeURIComponent(invocationKey)}`,
      workflowInvocationLookupResponseSchema,
    ),
  getRun: (runId: string, signal?: AbortSignal) =>
    request(`/workflow-runs/${encodeURIComponent(runId)}`, workflowRunResponseSchema, {
      signal,
    }),
  getPendingHumanReviews: (runId: string, signal?: AbortSignal) =>
    request(
      `/workflow-runs/${encodeURIComponent(runId)}/pending-human-reviews`,
      pendingHumanReviewsResponseSchema,
      { signal },
    ),
  getNodeRuns: (runId: string, signal?: AbortSignal) =>
    request(
      `/workflow-runs/${encodeURIComponent(runId)}/node-runs`,
      workflowNodeRunsResponseSchema,
      { signal },
    ),
  getExecutionTree: (runId: string, query: ExecutionTreeQuery, signal?: AbortSignal) => {
    const parsed = executionTreeQuerySchema.parse(query);
    const params = new URLSearchParams();
    params.set('parentType', parsed.parentType);
    if (parsed.parentId !== undefined) params.set('parentId', parsed.parentId);
    params.set('limit', String(parsed.limit));
    if (parsed.after !== undefined) params.set('after', parsed.after);
    return request(
      `/workflow-runs/${encodeURIComponent(runId)}/execution-tree?${params.toString()}`,
      executionTreeResponseSchema,
      { signal },
    );
  },
  resumeRun: (runId: string, input: ResumeWorkflowRunRequest) =>
    request(`/workflow-runs/${encodeURIComponent(runId)}/resume`, workflowRunResponseSchema, {
      method: 'POST',
      body: jsonBody(resumeWorkflowRunRequestSchema.parse(input)),
    }),
  startRun: (input: StartWorkflowRunRequest) =>
    request('/workflow-runs', workflowRunResponseSchema, {
      method: 'POST',
      body: jsonBody(startWorkflowRunRequestSchema.parse(input)),
    }),
  getVersion: (versionId: string) =>
    request(`/workflow-versions/${encodeURIComponent(versionId)}`, workflowVersionResponseSchema),
  listVersions: (workflowId: string, signal?: AbortSignal) =>
    request(
      `/workflows/${encodeURIComponent(workflowId)}/versions`,
      workflowVersionListResponseSchema,
      { signal },
    ),
  publish: (workflowId: string, expectedRevision: number) =>
    request(`/workflows/${encodeURIComponent(workflowId)}/publish`, workflowVersionResponseSchema, {
      method: 'POST',
      body: jsonBody(publishWorkflowRequestSchema.parse({ expectedRevision })),
    }),
  publicationStatus: async (
    workflowId: string,
    revision: number,
    signal?: AbortSignal,
  ): Promise<WorkflowPublicationStatus> => {
    let beforeVersion: number | undefined;
    let latest: WorkflowPublicationStatus['latest'] = null;
    do {
      const query = beforeVersion === undefined ? '' : `?beforeVersion=${beforeVersion}`;
      const page = await request(
        `/workflows/${encodeURIComponent(workflowId)}/versions${query}`,
        workflowVersionListResponseSchema,
        { signal },
      );
      if (page.items.some((version) => version.workflowId !== workflowId))
        throw new ApiError('版本列表与当前工作流不匹配', 200);
      latest ??= page.items[0] ?? null;
      const current = page.items.find((version) => version.sourceRevision === revision);
      if (current) return { latest, current };
      if (!page.nextBeforeVersion || !latest || latest.sourceRevision < revision)
        return { latest, current: null };
      if (beforeVersion !== undefined && page.nextBeforeVersion >= beforeVersion)
        throw new ApiError('版本列表分页游标无效', 200);
      beforeVersion = page.nextBeforeVersion;
    } while (beforeVersion !== undefined);
    return { latest, current: null };
  },
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
