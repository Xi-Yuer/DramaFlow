import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { ImageType, StringType } from '@dramaflow/contracts';
import {
  DatabaseService,
  WorkflowOutboxDispatcher,
  WorkflowRunSubmissionFactory,
  WorkflowHumanReviewService,
  WorkflowRunQueryService,
  WorkflowVersionRepositories,
} from '@dramaflow/server';
import { WorkflowRuntimeService } from './workflow-runtime.service.js';
import { WorkflowRunsController } from './workflow-runs.controller.js';

function fixture() {
  const runRow = {
    id: 'run-a',
    projectId: 'project-a',
    workflowId: 'workflow-a',
    workflowVersionId: 'version-a',
    invocationKey: 'key-a',
    threadId: 'private-thread-id',
    status: 'running',
    inputs: {},
    outputs: null,
    error: null,
    createdAt: new Date('2026-10-23T00:00:00.000Z'),
    startedAt: new Date('2026-10-23T00:00:01.000Z'),
    completedAt: null,
  };
  const nodeRunRows = [
    {
      id: 'node-run-1',
      projectId: 'project-a',
      workflowRunId: 'run-a',
      nodeId: 'node-generate',
      occurrenceId: 'occurrence-node-generate',
      scopeKey: 'root',
      occurrence: { scopeKey: 'root' },
      attempt: 1,
      status: 'failed',
      inputs: {
        prompt: { storage: 'inline', type: StringType, value: '生成角色大纲' },
      },
      outputs: null,
      error: {
        stage: 'execute',
        code: 'PROVIDER_TIMEOUT',
        message: '模型响应超时',
      },
      startedAt: new Date('2026-10-23T00:00:01.000Z'),
      completedAt: new Date('2026-10-23T00:00:03.000Z'),
    },
    {
      id: 'node-run-2',
      projectId: 'project-a',
      workflowRunId: 'run-a',
      nodeId: 'node-generate',
      occurrenceId: 'occurrence-node-generate',
      scopeKey: 'root',
      occurrence: { scopeKey: 'root' },
      attempt: 2,
      status: 'completed',
      inputs: {
        prompt: { storage: 'inline', type: StringType, value: '生成角色大纲' },
      },
      outputs: {
        text: {
          storage: 'inline',
          type: StringType,
          value: '主角是一名冷静的侦探',
        },
        cover: {
          storage: 'reference',
          type: ImageType,
          reference: { kind: 'artifact', id: 'artifact-cover-1' },
        },
      },
      error: null,
      startedAt: new Date('2026-10-23T00:00:04.000Z'),
      completedAt: new Date('2026-10-23T00:00:06.000Z'),
    },
    {
      id: 'node-run-3',
      projectId: 'project-a',
      workflowRunId: 'run-a',
      nodeId: 'review-1',
      occurrenceId: 'occurrence-review-1',
      scopeKey: 'root',
      occurrence: { scopeKey: 'root' },
      attempt: 1,
      status: 'running',
      inputs: {
        content: {
          storage: 'inline',
          type: StringType,
          value: '主角是一名冷静的侦探',
        },
      },
      outputs: null,
      error: null,
      startedAt: new Date('2026-10-23T00:00:07.000Z'),
      completedAt: null,
    },
  ];
  const workflowRun = {
    findFirst: vi.fn(async (query) => {
      if (
        query.where.id === 'run-a' &&
        query.where.project?.ownerId === 'owner-a'
      ) {
        return runRow;
      }
      return null;
    }),
  };
  const nodeRun = {
    findMany: vi.fn(async (query) => {
      if (
        query.where.workflowRunId === 'run-a' &&
        query.where.projectId === 'project-a' &&
        query.where.project?.ownerId === 'owner-a'
      ) {
        return nodeRunRows;
      }
      return [];
    }),
  };
  const submissions = { forProject: vi.fn() };
  const dispatcher = { publishStart: vi.fn(), publishExecution: vi.fn() };
  const database = { client: { workflowRun, nodeRun } };
  const service = new WorkflowRuntimeService(
    submissions as unknown as WorkflowRunSubmissionFactory,
    dispatcher as unknown as WorkflowOutboxDispatcher,
    {} as WorkflowHumanReviewService,
    new WorkflowRunQueryService(database as unknown as DatabaseService),
    {} as WorkflowVersionRepositories,
  );
  return { service, workflowRun, nodeRun, submissions, dispatcher };
}

describe('WorkflowRun NodeRun 查询 API', () => {
  it('已授权用户按 WorkflowRun 查询真实 NodeRun 列表，包含多 attempt、inputs、outputs 与 error，不暴露内部字段', async () => {
    const f = fixture();
    const result = await f.service.listNodeRuns('owner-a', 'run-a');

    expect(f.workflowRun.findFirst).toHaveBeenCalledOnce();
    expect(f.nodeRun.findMany).toHaveBeenCalledWith({
      where: {
        workflowRunId: 'run-a',
        projectId: 'project-a',
        project: { ownerId: 'owner-a' },
      },
      orderBy: [{ startedAt: 'asc' }, { attempt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        workflowRunId: true,
        nodeId: true,
        occurrenceId: true,
        iterationItemRunId: true,
        occurrence: { select: { scopeKey: true } },
        attempt: true,
        status: true,
        inputs: true,
        outputs: true,
        error: true,
        startedAt: true,
        completedAt: true,
      },
    });

    expect(result.items).toHaveLength(3);
    expect(result.items[0]).toEqual({
      id: 'node-run-1',
      workflowRunId: 'run-a',
      nodeId: 'node-generate',
      occurrenceId: 'occurrence-node-generate',
      scopeKey: 'root',
      attempt: 1,
      status: 'failed',
      inputs: {
        prompt: { storage: 'inline', type: StringType, value: '生成角色大纲' },
      },
      error: {
        stage: 'execute',
        code: 'PROVIDER_TIMEOUT',
        message: '模型响应超时',
      },
      startedAt: '2026-10-23T00:00:01.000Z',
      completedAt: '2026-10-23T00:00:03.000Z',
    });
    expect(result.items[1]).toEqual({
      id: 'node-run-2',
      workflowRunId: 'run-a',
      nodeId: 'node-generate',
      occurrenceId: 'occurrence-node-generate',
      scopeKey: 'root',
      attempt: 2,
      status: 'completed',
      inputs: {
        prompt: { storage: 'inline', type: StringType, value: '生成角色大纲' },
      },
      outputs: {
        text: {
          storage: 'inline',
          type: StringType,
          value: '主角是一名冷静的侦探',
        },
        cover: {
          storage: 'reference',
          type: ImageType,
          reference: { kind: 'artifact', id: 'artifact-cover-1' },
        },
      },
      startedAt: '2026-10-23T00:00:04.000Z',
      completedAt: '2026-10-23T00:00:06.000Z',
    });
    expect(result.items[2]).toEqual({
      id: 'node-run-3',
      workflowRunId: 'run-a',
      nodeId: 'review-1',
      occurrenceId: 'occurrence-review-1',
      scopeKey: 'root',
      attempt: 1,
      status: 'running',
      inputs: {
        content: {
          storage: 'inline',
          type: StringType,
          value: '主角是一名冷静的侦探',
        },
      },
      startedAt: '2026-10-23T00:00:07.000Z',
    });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('projectId');
    expect(serialized).not.toContain('threadId');
    expect(serialized).not.toContain('private-thread-id');
  });

  it.each([
    ['owner-b', 'run-a'],
    ['owner-a', 'missing-run'],
  ])(
    '跨用户或不存在的 WorkflowRun (%s, %s) 拒绝访问并返回 404，不查询 NodeRun 表',
    async (owner, runId) => {
      const f = fixture();
      await expect(f.service.listNodeRuns(owner, runId)).rejects.toMatchObject({
        status: 404,
      });
      expect(f.nodeRun.findMany).not.toHaveBeenCalled();
    },
  );

  it('Controller 入口需要认证且返回 Cache-Control: no-store', () => {
    expect(
      Reflect.getMetadata(
        '__headers__',
        WorkflowRunsController.prototype.nodeRuns,
      ),
    ).toContainEqual({ name: 'Cache-Control', value: 'no-store' });
    expect(
      Reflect.getMetadata(
        'auth:public',
        WorkflowRunsController.prototype.nodeRuns,
      ),
    ).not.toBe(true);
  });
});
