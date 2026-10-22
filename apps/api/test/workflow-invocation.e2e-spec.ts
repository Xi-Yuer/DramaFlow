import { randomUUID } from 'node:crypto';
import {
  AnyType,
  NumberType,
  type WorkflowDefinition,
} from '@dramaflow/contracts';
import {
  DatabaseService,
  WorkflowRunRepositories,
  WorkflowRunSubmissionFactory,
} from '@dramaflow/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { storeRuntimeTestVersion } from './fixtures/workflow-service.js';

if (
  process.env.DRAMAFLOW_INTEGRATION !== '1' ||
  new URL(process.env.DATABASE_URL ?? 'http://invalid').pathname !==
    '/dramaflow_test'
)
  throw new Error('Invocation 集成测试仅允许隔离测试库');
const database = new DatabaseService();
const db = database.client;
const ownerId = randomUUID();
const runs = new WorkflowRunRepositories(database);
let factory: WorkflowRunSubmissionFactory;

beforeAll(async () => {
  await db.user.create({
    data: { id: ownerId, name: 'Invocation', email: `${ownerId}@example.test` },
  });
  const { WorkflowVersionRepositories } = await import('@dramaflow/server');
  factory = new WorkflowRunSubmissionFactory(
    new WorkflowVersionRepositories(database),
    runs,
  );
});
afterAll(async () => {
  await db.user.deleteMany({ where: { id: ownerId } });
  await database.onModuleDestroy();
});
async function fixture() {
  const project = await db.project.create({
    data: { ownerId, name: 'Invocation', viewport: {} },
  });
  const definition: WorkflowDefinition = {
    inputs: [{ name: 'a', type: AnyType, required: false }],
    nodes: [],
    edges: [],
    outputs: [],
  };
  const workflow = await db.workflow.create({
    data: { projectId: project.id, name: 'Invocation', draft: {} },
  });
  const version = await storeRuntimeTestVersion(database, workflow, definition);
  const input = {
    projectId: project.id,
    workflowId: workflow.id,
    workflowVersionId: version.id,
    invocationKey: randomUUID(),
    inputs: {},
  };
  return {
    input,
    workflow,
    definition,
    submission: await factory.forProject(ownerId, project.id),
    repository: await runs.forProject(ownerId, project.id),
  };
}

describe('PostgreSQL invocation 受理', () => {
  it('新建与相同 key 并发：一个 Run、一个 start Outbox、同一 thread', async () => {
    const f = await fixture();
    const results = await Promise.all(
      Array.from({ length: 12 }, () => f.submission.start(f.input)),
    );
    expect(new Set(results.map((run) => run.id)).size).toBe(1);
    expect(new Set(results.map((run) => run.threadId)).size).toBe(1);
    expect(
      await db.workflowRun.count({ where: { workflowId: f.input.workflowId } }),
    ).toBe(1);
    expect(
      await db.workflowExecutionOutbox.count({
        where: { workflowRunId: results[0]!.id, kind: 'start' },
      }),
    ).toBe(1);
  });

  it('不同 inputs 并发冲突不会留下第二个 Run 或 Outbox', async () => {
    const f = await fixture();
    const results = await Promise.allSettled(
      [1, 2].map((value) =>
        f.submission.start({
          ...f.input,
          inputs: { a: { storage: 'inline', type: NumberType, value } },
        }),
      ),
    );
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.find((result) => result.status === 'rejected'),
    ).toMatchObject({ reason: { code: 'WORKFLOW_INVOCATION_CONFLICT' } });
    const records = await db.workflowRun.findMany({
      where: { workflowId: f.input.workflowId },
    });
    expect(records).toHaveLength(1);
    expect(
      await db.workflowExecutionOutbox.count({
        where: { workflowRunId: records[0]!.id },
      }),
    ).toBe(1);
  });

  it.each([
    'pending',
    'running',
    'waiting',
    'completed',
    'failed',
    'cancelled',
  ] as const)('复用 %s，保留 key 和 start Outbox', async (status) => {
    const f = await fixture();
    const original = await f.submission.start(f.input);
    if (status !== 'pending') await f.repository.markRunning(original.id);
    if (status === 'waiting') await f.repository.markWaiting(original.id);
    if (status === 'completed')
      await f.repository.markCompleted(original.id, {});
    if (status === 'failed')
      await f.repository.markFailed(original.id, {
        stage: 'invoke',
        message: '失败',
      });
    if (status === 'cancelled') await f.repository.markCancelled(original.id);
    expect(await f.submission.start(f.input)).toMatchObject({
      id: original.id,
      invocationKey: f.input.invocationKey,
      status,
    });
    expect(
      await db.workflowExecutionOutbox.count({
        where: { workflowRunId: original.id },
      }),
    ).toBe(1);
  });

  it('不同合法版本冲突，不覆盖已有版本', async () => {
    const f = await fixture();
    const original = await f.submission.start(f.input);
    const version = await storeRuntimeTestVersion(
      database,
      { ...f.workflow, revision: f.workflow.revision + 1 },
      f.definition,
    );
    await expect(
      f.submission.start({ ...f.input, workflowVersionId: version.id }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_INVOCATION_CONFLICT' });
    expect((await f.repository.getById(original.id))?.workflowVersionId).toBe(
      f.input.workflowVersionId,
    );
  });

  it('不同 Workflow 允许相同 key；同 Workflow 的不同 key 允许相同 inputs', async () => {
    const a = await fixture();
    const b = await fixture();
    const first = await a.submission.start(a.input);
    const second = await b.submission.start({
      ...b.input,
      invocationKey: a.input.invocationKey,
    });
    const third = await a.submission.start({
      ...a.input,
      invocationKey: randomUUID(),
    });
    expect(new Set([first.id, second.id, third.id]).size).toBe(3);
  });

  it('invocationKey 不可修改；唯一约束保留到 Run 终态', async () => {
    const f = await fixture();
    const run = await f.submission.start(f.input);
    await expect(
      db.workflowRun.update({
        where: { id: run.id },
        data: {
          invocationKey: 'changed',
          status: 'running',
          startedAt: new Date(),
        },
      }),
    ).rejects.toThrow();
    expect((await f.repository.getById(run.id))?.invocationKey).toBe(
      f.input.invocationKey,
    );
  });
});
