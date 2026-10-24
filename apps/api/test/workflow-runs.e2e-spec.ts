import { randomUUID } from 'node:crypto';
import {
  NumberType,
  VideoType,
  type RuntimeValue,
  type WorkflowRunStatus,
} from '@dramaflow/contracts';
import {
  DatabaseService,
  NodeRunRepositories,
  WorkflowRunRepositories,
} from '@dramaflow/server';
import type { WorkflowRunRepository } from '@dramaflow/workflow';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

if (
  process.env.DRAMAFLOW_INTEGRATION !== '1' ||
  new URL(process.env.DATABASE_URL ?? 'http://invalid').pathname !==
    '/dramaflow_test'
)
  throw new Error(
    'WorkflowRun 集成测试仅允许在 DramaFlow 的隔离测试数据库运行',
  );

const database = new DatabaseService();
const db = database.client;
const repositories = new WorkflowRunRepositories(database);
const ownerId = randomUUID();
const otherId = randomUUID();
let projectId: string;
let otherProjectId: string;
let repository: WorkflowRunRepository;
const outputs: Record<string, RuntimeValue> = {
  movie: {
    storage: 'reference',
    type: VideoType,
    reference: { kind: 'artifact', id: 'final-video' },
  },
};
const failure = {
  stage: 'invoke',
  code: 'GRAPH_FAILED',
  message: '图运行失败',
};

beforeAll(async () => {
  for (const id of [ownerId, otherId])
    await db.user.create({
      data: { id, name: '运行记录测试', email: `${id}@example.test` },
    });
  projectId = (
    await db.project.create({
      data: { ownerId, name: '运行记录测试', viewport: {} },
    })
  ).id;
  otherProjectId = (
    await db.project.create({
      data: { ownerId: otherId, name: '其他项目', viewport: {} },
    })
  ).id;
  repository = await repositories.forProject(ownerId, projectId);
});

afterAll(async () => {
  await db.user.deleteMany({ where: { id: { in: [ownerId, otherId] } } });
  await database.onModuleDestroy();
});

function create() {
  return repository.create({
    projectId,
    workflowId: 'workflow-1',
    workflowVersionId: 'version-3',
    invocationKey: randomUUID(),
    inputs: {},
  });
}

async function prepare(status: WorkflowRunStatus) {
  const run = await create();
  if (status !== 'pending') await repository.markRunning(run.id);
  if (status === 'waiting') await repository.markWaiting(run.id);
  if (status === 'completed') await repository.markCompleted(run.id, outputs);
  if (status === 'failed') await repository.markFailed(run.id, failure);
  if (status === 'cancelled') await repository.markCancelled(run.id);
  return run;
}

describe('真实 PostgreSQL WorkflowRun', () => {
  it('创建 pending、独立 thread 和不可变版本 / RuntimeValue 输入快照', async () => {
    const inputs = {
      count: { storage: 'inline' as const, type: NumberType, value: 3 },
    };
    const run = await repository.create({
      projectId,
      workflowId: 'workflow-1',
      workflowVersionId: 'version-3',
      invocationKey: randomUUID(),
      inputs,
    });
    inputs.count.value = 99;
    expect(run).toMatchObject({
      projectId,
      workflowId: 'workflow-1',
      workflowVersionId: 'version-3',
      status: 'pending',
      inputs: { count: { value: 3 } },
    });
    expect(run.threadId).not.toBe(run.id);
    expect(run.createdAt).toBe(new Date(run.createdAt).toISOString());
    expect(run).not.toHaveProperty('startedAt');
    expect(run).not.toHaveProperty('outputs');
    const row = await db.workflowRun.findUniqueOrThrow({
      where: { id: run.id },
    });
    expect(row.inputs).toEqual(run.inputs);
    expect(row.startedAt).toBeNull();
    await expect(
      repository.create({
        projectId,
        workflowId: 'workflow-1',
        workflowVersionId: '',
        invocationKey: randomUUID(),
        inputs: {},
      }),
    ).rejects.toThrow();
    await expect(
      db.workflowRun.create({
        data: {
          projectId,
          workflowId: 'workflow-1',
          workflowVersionId: 'version-4',
          invocationKey: randomUUID(),
          threadId: run.threadId,
          inputs: {},
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('pending → running → waiting → running → completed，保留首次开始时间，只记录最终对外输出', async () => {
    const run = await create();
    await repository.markRunning(run.id);
    const started = await db.workflowRun.findUniqueOrThrow({
      where: { id: run.id },
    });
    await repository.markWaiting(run.id);
    expect(
      await db.workflowRun.findUniqueOrThrow({ where: { id: run.id } }),
    ).toMatchObject({ status: 'waiting', completedAt: null });
    await repository.markRunning(run.id);
    await repository.markCompleted(run.id, outputs);
    const completed = await db.workflowRun.findUniqueOrThrow({
      where: { id: run.id },
    });
    expect(completed).toMatchObject({
      status: 'completed',
      workflowVersionId: 'version-3',
      threadId: run.threadId,
      outputs,
      error: null,
      startedAt: started.startedAt,
    });
    expect(completed.completedAt).toBeInstanceOf(Date);
    expect(completed.outputs).not.toHaveProperty('nodeId');
  });

  const statuses = [
    'pending',
    'running',
    'waiting',
    'completed',
    'failed',
    'cancelled',
  ] as const;
  const targets = [
    'running',
    'waiting',
    'completed',
    'failed',
    'cancelled',
  ] as const;
  const allowed = new Set([
    'pending:running',
    'running:waiting',
    'running:completed',
    'running:failed',
    'running:cancelled',
    'waiting:running',
    'waiting:cancelled',
  ]);
  it.each(statuses.flatMap((from) => targets.map((to) => ({ from, to }))))(
    '$from → $to 严格遵守状态转换',
    async ({ from, to }) => {
      const run = await prepare(from);
      const before = await db.workflowRun.findUniqueOrThrow({
        where: { id: run.id },
      });
      const actions = {
        running: () => repository.markRunning(run.id),
        waiting: () => repository.markWaiting(run.id),
        completed: () => repository.markCompleted(run.id, outputs),
        failed: () => repository.markFailed(run.id, failure),
        cancelled: () => repository.markCancelled(run.id),
      };
      if (allowed.has(`${from}:${to}`)) {
        await actions[to]();
        const row = await db.workflowRun.findUniqueOrThrow({
          where: { id: run.id },
        });
        expect(row.status).toBe(to);
        expect(row.workflowVersionId).toBe(run.workflowVersionId);
        expect(row.threadId).toBe(run.threadId);
        if (from !== 'pending') expect(row.startedAt).toEqual(before.startedAt);
        if (to === 'failed') expect(row.error).toEqual(failure);
        if (to === 'cancelled') expect(row.completedAt).toBeInstanceOf(Date);
      } else {
        await expect(actions[to]()).rejects.toThrow('状态不允许');
        expect(
          await db.workflowRun.findUniqueOrThrow({ where: { id: run.id } }),
        ).toEqual(before);
      }
    },
  );

  it('数据库拒绝修改版本、身份、输入及首次开始时间，也拒绝跳过 running 直接失败', async () => {
    const run = await prepare('waiting');
    const before = await db.workflowRun.findUniqueOrThrow({
      where: { id: run.id },
    });
    for (const data of [
      { workflowVersionId: 'version-4' },
      { workflowId: 'other' },
      { threadId: 'other-thread' },
      { inputs: { changed: true } },
      { startedAt: new Date(0) },
      { status: 'failed', error: failure, completedAt: new Date() },
    ])
      await expect(
        db.workflowRun.update({ where: { id: run.id }, data }),
      ).rejects.toThrow();
    expect(
      await db.workflowRun.findUniqueOrThrow({ where: { id: run.id } }),
    ).toEqual(before);
  });

  it('并发终态操作只能成功一次，不覆盖已经提交的结果', async () => {
    const run = await prepare('running');
    const results = await Promise.allSettled([
      repository.markCompleted(run.id, outputs),
      repository.markFailed(run.id, failure),
      repository.markCancelled(run.id),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const row = await db.workflowRun.findUniqueOrThrow({
      where: { id: run.id },
    });
    if (row.status === 'completed') expect(row.outputs).toEqual(outputs);
    if (row.status === 'failed') expect(row.error).toEqual(failure);
    expect(row.completedAt).toBeInstanceOf(Date);
  });

  it('每次写入检查项目 / 所有者，不能使用已有 Repository 越权操作', async () => {
    await expect(repositories.forProject(otherId, projectId)).rejects.toThrow(
      '无权访问',
    );
    await expect(
      repository.create({
        projectId: otherProjectId,
        workflowId: 'w',
        workflowVersionId: 'v',
        invocationKey: randomUUID(),
        inputs: {},
      }),
    ).rejects.toThrow('不匹配');
    const other = await repositories.forProject(otherId, otherProjectId);
    const run = await create();
    await expect(other.markRunning(run.id)).rejects.toThrow('无权访问');
    await db.project.update({
      where: { id: projectId },
      data: { ownerId: otherId },
    });
    try {
      await expect(repository.markRunning(run.id)).rejects.toThrow('无权访问');
      await expect(create()).rejects.toThrow('无权访问');
    } finally {
      await db.project.update({ where: { id: projectId }, data: { ownerId } });
    }
  });

  it('NodeRun 必须引用同项目真实 WorkflowRun，删除父运行级联删除节点历史', async () => {
    const run = await prepare('running');
    const nodes = new NodeRunRepositories(database);
    await expect(
      nodes.forRun(ownerId, projectId, 'missing-run'),
    ).rejects.toThrow('运行不存在');
    const nodeRepository = await nodes.forRun(ownerId, projectId, run.id);
    const occurrence = await nodeRepository.getOrCreateOccurrence({
      workflowRunId: run.id,
      nodeId: 'node-1',
      scopeKey: 'root',
    });
    const node = await nodeRepository.createRunning({
      occurrenceId: occurrence.id,
      workflowRunId: run.id,
      nodeId: 'node-1',
    });
    for (const [project, parent] of [
      [projectId, 'missing-run'],
      [otherProjectId, run.id],
    ])
      await expect(
        db.nodeRun.create({
          data: {
            projectId: project!,
            workflowRunId: parent!,
            nodeId: 'invalid',
            occurrenceId: occurrence.id,
            attempt: 2,
          },
        }),
      ).rejects.toMatchObject({ code: 'P2003' });
    await db.workflowRun.delete({ where: { id: run.id } });
    expect(await db.nodeRun.findUnique({ where: { id: node.id } })).toBeNull();
    expect(
      await db.project.findUnique({ where: { id: projectId } }),
    ).not.toBeNull();
  });
});

describe('WorkflowRun 读取与原子恢复 claim', () => {
  it.each([
    'pending',
    'running',
    'waiting',
    'completed',
    'failed',
    'cancelled',
  ] as const)('读取完整 %s 记录，JSON / ISO 字段转换正确', async (status) => {
    const run = await prepare(status);
    const read = await repository.getById(run.id);
    expect(read).toMatchObject({
      id: run.id,
      projectId,
      workflowId: run.workflowId,
      workflowVersionId: run.workflowVersionId,
      threadId: run.threadId,
      status,
      inputs: {},
      createdAt: run.createdAt,
    });
    if (status !== 'pending')
      expect(read?.startedAt).toEqual(expect.any(String));
    if (status === 'completed') expect(read?.outputs).toEqual(outputs);
    if (status === 'failed') expect(read?.error).toEqual(failure);
    if (['completed', 'failed', 'cancelled'].includes(status))
      expect(read?.completedAt).toEqual(expect.any(String));
    expect(await repository.getById('missing-run')).toBeNull();
  });

  it('两个生产 Repository 的 12 个首次执行 claim 只有一个成功，startedAt 在抢占时写入', async () => {
    const run = await create();
    const second = await repositories.forProject(ownerId, projectId);
    const claims = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        (index % 2 ? repository : second).claimPendingForStart(run.id),
      ),
    );
    const claimed = claims.filter((value) => value !== null);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({
      ...run,
      status: 'running',
      startedAt: expect.any(String),
    });
    expect(await repository.getById(run.id)).toEqual(claimed[0]);
    expect(await repository.claimPendingForStart(run.id)).toBeNull();
    expect(await repository.claimPendingForStart('missing-run')).toBeNull();
    expect(await db.workflowRun.count({ where: { id: run.id } })).toBe(1);
  });

  it.each(['running', 'waiting', 'completed', 'failed', 'cancelled'] as const)(
    '%s 不能通过首次 claim 修改原记录',
    async (status) => {
      const run = await prepare(status);
      const before = await repository.getById(run.id);
      expect(await repository.claimPendingForStart(run.id)).toBeNull();
      expect(await repository.getById(run.id)).toEqual(before);
    },
  );

  it('12 个并发 claim 只有一个成功，返回 running 并保留原身份、输入与首次开始时间', async () => {
    const run = await prepare('waiting');
    const before = await repository.getById(run.id);
    const second = await repositories.forProject(ownerId, projectId);
    const claims = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        (index % 2 ? repository : second).claimWaitingForResume(run.id),
      ),
    );
    const claimed = claims.filter((value) => value !== null);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toEqual({ ...before, status: 'running' });
    expect(await repository.getById(run.id)).toEqual(claimed[0]);
    expect(await repository.claimWaitingForResume(run.id)).toBeNull();
    expect(await repository.claimWaitingForResume('missing-run')).toBeNull();
  });

  it.each(['pending', 'running', 'completed', 'failed', 'cancelled'] as const)(
    '%s 的 claim 不写入任何字段',
    async (status) => {
      const run = await prepare(status);
      const before = await repository.getById(run.id);
      expect(await repository.claimWaitingForResume(run.id)).toBeNull();
      expect(await repository.getById(run.id)).toEqual(before);
    },
  );

  it.each(['pending', 'waiting'] as const)(
    '%s 的读取和 claim 继续检查所有者 / 项目，不使用过期权限',
    async (status) => {
      const run = await prepare(status);
      const claim =
        status === 'pending' ? 'claimPendingForStart' : 'claimWaitingForResume';
      const before = await repository.getById(run.id);
      const other = await repositories.forProject(otherId, otherProjectId);
      expect(await other.getById(run.id)).toBeNull();
      expect(await other[claim](run.id)).toBeNull();
      await db.project.update({
        where: { id: projectId },
        data: { ownerId: otherId },
      });
      try {
        expect(await repository.getById(run.id)).toBeNull();
        expect(await repository[claim](run.id)).toBeNull();
      } finally {
        await db.project.update({
          where: { id: projectId },
          data: { ownerId },
        });
      }
      expect(await repository.getById(run.id)).toEqual(before);
    },
  );
});
