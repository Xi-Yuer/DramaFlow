import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
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
  const workflow = {
    findFirst: vi.fn(async (query) =>
      query.where.id === 'workflow-a' &&
      query.where.project.ownerId === 'owner-a'
        ? { projectId: 'project-a' }
        : null,
    ),
  };
  const row = {
    id: 'run-a',
    projectId: 'project-a',
    workflowId: 'workflow-a',
    workflowVersionId: 'version-a',
    invocationKey: 'key-a',
    threadId: 'private-thread',
    status: 'pending',
    inputs: {},
    outputs: null,
    error: null,
    createdAt: new Date('2026-10-22T00:00:00.000Z'),
    startedAt: null,
    completedAt: null,
  };
  const workflowRun = {
    findFirst: vi.fn(async (query) => {
      if (
        query.where.id === 'run-a' &&
        query.where.project.ownerId === 'owner-a'
      )
        return row;
      if (
        query.where.workflowId === 'workflow-a' &&
        query.where.projectId === 'project-a' &&
        query.where.project.ownerId === 'owner-a' &&
        query.where.invocationKey === 'key-a'
      )
        return { id: row.id };
      return null;
    }),
  };
  const submissions = { forProject: vi.fn() };
  const dispatcher = { publishStart: vi.fn(), publishExecution: vi.fn() };
  const database = { client: { workflow, workflowRun } };
  const service = new WorkflowRuntimeService(
    submissions as unknown as WorkflowRunSubmissionFactory,
    dispatcher as unknown as WorkflowOutboxDispatcher,
    {} as WorkflowHumanReviewService,
    new WorkflowRunQueryService(database as unknown as DatabaseService),
    {} as WorkflowVersionRepositories,
  );
  return { service, workflow, workflowRun, submissions, dispatcher };
}
describe('只读 invocation lookup', () => {
  it('授权 lookup 返回现有安全 Run projection，没有执行副作用或 threadId', async () => {
    const f = fixture();
    const result = await f.service.lookupInvocation(
      'owner-a',
      'workflow-a',
      'key-a',
    );
    expect(result.run).toMatchObject({ id: 'run-a', invocationKey: 'key-a' });
    expect(result.run).not.toHaveProperty('threadId');
    expect(result.run).not.toHaveProperty('projectId');
    expect(f.workflowRun.findFirst.mock.calls[0]?.[0].where).toEqual({
      workflowId: 'workflow-a',
      invocationKey: 'key-a',
      projectId: 'project-a',
      project: { ownerId: 'owner-a' },
    });
    expect(f.submissions.forProject).not.toHaveBeenCalled();
    expect(f.dispatcher.publishStart).not.toHaveBeenCalled();
    expect(f.dispatcher.publishExecution).not.toHaveBeenCalled();
  });
  it('已授权 Workflow 没有 invocation 返回明确 null', async () => {
    expect(
      await fixture().service.lookupInvocation(
        'owner-a',
        'workflow-a',
        'missing',
      ),
    ).toEqual({ run: null });
  });
  it('同一用户另一个项目的 Workflow 不能用相同 key 找出原 Run', async () => {
    const f = fixture();
    f.workflow.findFirst.mockResolvedValueOnce({ projectId: 'project-b' });
    expect(
      await f.service.lookupInvocation('owner-a', 'workflow-b', 'key-a'),
    ).toEqual({ run: null });
    expect(f.workflowRun.findFirst.mock.calls[0]?.[0].where).toEqual({
      workflowId: 'workflow-b',
      invocationKey: 'key-a',
      projectId: 'project-b',
      project: { ownerId: 'owner-a' },
    });
  });
  it.each([
    ['owner-a', 'missing'],
    ['owner-b', 'workflow-a'],
    ['owner-a', 'workflow-other-project'],
  ])('不存在 / 跨用户 / 跨项目均隐藏资源 %s %s', async (owner, workflowId) => {
    const f = fixture();
    await expect(
      f.service.lookupInvocation(owner, workflowId, 'key-a'),
    ).rejects.toMatchObject({ status: 404 });
    expect(f.workflowRun.findFirst).not.toHaveBeenCalled();
  });
  it('入口沿用认证 actor，显式 no-store', () => {
    expect(
      Reflect.getMetadata(
        '__headers__',
        WorkflowRunsController.prototype.lookup,
      ),
    ).toContainEqual({ name: 'Cache-Control', value: 'no-store' });
    expect(
      Reflect.getMetadata(
        'auth:public',
        WorkflowRunsController.prototype.lookup,
      ),
    ).not.toBe(true);
  });
});
