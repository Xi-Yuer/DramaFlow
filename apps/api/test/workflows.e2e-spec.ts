import { randomUUID } from 'node:crypto';
import { StringType, type WorkflowDefinition } from '@dramaflow/contracts';
import {
  DatabaseService,
  WorkflowVersionRepositories,
} from '@dramaflow/server';
import { NotFoundException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { WorkflowService } from '../src/workflow/workflows/workflow.service.js';

if (
  process.env.DRAMAFLOW_INTEGRATION !== '1' ||
  new URL(process.env.DATABASE_URL ?? 'http://invalid').pathname !==
    '/dramaflow_test'
)
  throw new Error(
    'Workflow 发布集成测试仅允许在 DramaFlow 的隔离测试数据库运行',
  );

const database = new DatabaseService();
const secondConnection = new DatabaseService();
const db = database.client;
const service = new WorkflowService(database);
const otherService = new WorkflowService(secondConnection);
const ownerId = randomUUID();
const otherId = randomUUID();

beforeAll(async () => {
  for (const id of [ownerId, otherId])
    await db.user.create({
      data: { id, name: '发布测试', email: `${id}@example.test` },
    });
});
afterAll(async () => {
  await db.user.deleteMany({ where: { id: { in: [ownerId, otherId] } } });
  await Promise.all([
    database.onModuleDestroy(),
    secondConnection.onModuleDestroy(),
  ]);
});

function definition(text: string): WorkflowDefinition {
  return {
    inputs: [],
    nodes: [
      {
        id: 'text',
        type: 'test.text',
        typeVersion: 1,
        name: '文本',
        inputs: { prompt: { type: 'constant', value: text } },
        config: { style: { tags: [text] } },
        ui: { position: { x: 0, y: 0 } },
      },
    ],
    edges: [],
    outputs: [
      {
        name: 'text',
        type: StringType,
        source: { nodeId: 'text', outputKey: 'text' },
      },
    ],
  };
}

async function fixture(revision = 10) {
  const draft = definition('A');
  const project = await db.project.create({
    data: { ownerId, name: '发布测试', viewport: {} },
  });
  const workflow = await db.workflow.create({
    data: {
      projectId: project.id,
      name: '工作流',
      revision,
      draft: z.record(z.string(), z.json()).parse(draft),
    },
  });
  return { workflow, project, draft };
}

function conflict(
  code: 'WORKFLOW_REVISION_CONFLICT' | 'WORKFLOW_REVISION_ALREADY_PUBLISHED',
) {
  return expect.objectContaining({
    response: expect.objectContaining({ code }),
    status: 409,
  });
}

describe('真实 PostgreSQL Draft 乐观锁与发布序列', () => {
  it('两个独立连接并发以 revision 8 编辑，只有一个成功写入 revision 9', async () => {
    const f = await fixture(8);
    const requests = Array.from({ length: 12 }, (_, index) =>
      definition(`编辑 ${index}`),
    );
    const outcomes = await Promise.allSettled(
      requests.map(async (draft, index) => ({
        draft,
        result: await (index % 2 ? service : otherService).updateDraft(
          ownerId,
          {
            workflowId: f.workflow.id,
            expectedRevision: 8,
            definition: draft,
          },
        ),
      })),
    );
    const successful = outcomes.filter(
      (outcome) => outcome.status === 'fulfilled',
    );
    expect(successful).toHaveLength(1);
    const winner = successful[0];
    if (!winner) throw new Error('没有成功编辑');
    expect(winner.value.result).toEqual({ revision: 9 });
    expect(
      await db.workflow.findUniqueOrThrow({ where: { id: f.workflow.id } }),
    ).toMatchObject({
      revision: 9,
      draft: winner.value.draft,
    });
    const failed = outcomes.filter((outcome) => outcome.status === 'rejected');
    expect(failed).toHaveLength(11);
    for (const outcome of failed)
      expect(outcome.reason).toEqual(conflict('WORKFLOW_REVISION_CONFLICT'));
  });

  it('过期页面发布 revision 9，而数据库为 10 时不产生版本或修改草稿', async () => {
    const f = await fixture();
    await expect(
      service.publish(ownerId, {
        workflowId: f.workflow.id,
        expectedRevision: 9,
      }),
    ).rejects.toEqual(conflict('WORKFLOW_REVISION_CONFLICT'));
    expect(
      await db.workflowVersion.count({ where: { workflowId: f.workflow.id } }),
    ).toBe(0);
    expect(
      await db.workflow.findUniqueOrThrow({ where: { id: f.workflow.id } }),
    ).toEqual(f.workflow);
  });

  it('12 次同 revision 并发发布只有一个版本，重复发布明确冲突，新修订获得下一版本号', async () => {
    const f = await fixture();
    const input = { workflowId: f.workflow.id, expectedRevision: 10 };
    const outcomes = await Promise.allSettled(
      Array.from({ length: 12 }, (_, index) =>
        (index % 2 ? service : otherService).publish(ownerId, input),
      ),
    );
    const successful = outcomes.filter(
      (outcome) => outcome.status === 'fulfilled',
    );
    expect(successful).toHaveLength(1);
    const first = successful[0]?.value;
    if (!first) throw new Error('没有成功发布');
    expect(first).toMatchObject({
      version: 1,
      sourceRevision: 10,
      definition: f.draft,
    });
    const failed = outcomes.filter((outcome) => outcome.status === 'rejected');
    expect(failed).toHaveLength(11);
    for (const outcome of failed)
      expect(outcome.reason).toEqual(
        conflict('WORKFLOW_REVISION_ALREADY_PUBLISHED'),
      );
    expect(
      await db.workflowVersion.count({ where: { workflowId: f.workflow.id } }),
    ).toBe(1);
    await expect(otherService.publish(ownerId, input)).rejects.toEqual(
      conflict('WORKFLOW_REVISION_ALREADY_PUBLISHED'),
    );

    const b = definition('B');
    expect(
      await otherService.updateDraft(ownerId, { ...input, definition: b }),
    ).toEqual({ revision: 11 });
    const second = await service.publish(ownerId, {
      ...input,
      expectedRevision: 11,
    });
    expect(second).toMatchObject({
      version: 2,
      sourceRevision: 11,
      definition: b,
    });
    const versions = await db.workflowVersion.findMany({
      where: { workflowId: f.workflow.id },
      orderBy: { version: 'asc' },
    });
    expect(
      versions.map(({ version, sourceRevision }) => [version, sourceRevision]),
    ).toEqual([
      [1, 10],
      [2, 11],
    ]);
    const reader = await new WorkflowVersionRepositories(
      secondConnection,
    ).forProject(ownerId, f.project.id);
    expect(await reader.getVersion(first.id)).toMatchObject({
      definition: f.draft,
    });
    expect(
      await db.workflow.findUniqueOrThrow({ where: { id: f.workflow.id } }),
    ).toMatchObject({ draft: b, revision: 11 });
  });

  it('版本号沿用已存在的最大版本，不把 draft revision 当成版本号', async () => {
    const f = await fixture();
    await db.workflowVersion.create({
      data: {
        workflowId: f.workflow.id,
        version: 7,
        sourceRevision: 1,
        definition: z.record(z.string(), z.json()).parse(f.draft),
      },
    });
    expect(
      await service.publish(ownerId, {
        workflowId: f.workflow.id,
        expectedRevision: 10,
      }),
    ).toMatchObject({ version: 8, sourceRevision: 10 });
  });

  it('发布等待未提交的 Draft 行锁，编辑提交后按新 revision 拒绝过期发布', async () => {
    const f = await fixture();
    let release!: () => void;
    let ready!: (pid: number) => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const locked = new Promise<number>((resolve) => {
      ready = resolve;
    });
    const editing = db.$transaction(
      async (tx) => {
        const [connection] = await tx.$queryRaw<
          { pid: number }[]
        >`SELECT pg_backend_pid() AS pid`;
        if (!connection) throw new Error('未取得编辑连接');
        await tx.workflow.update({
          where: { id: f.workflow.id },
          data: {
            draft: z.record(z.string(), z.json()).parse(definition('B')),
            revision: { increment: 1 },
          },
        });
        ready(connection.pid);
        await gate;
      },
      { timeout: 15000 },
    );
    let publication: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
      const blocker = await Promise.race([
        locked,
        editing.then(() => {
          throw new Error('编辑事务未持锁等待');
        }),
      ]);
      publication = Promise.allSettled([
        otherService.publish(ownerId, {
          workflowId: f.workflow.id,
          expectedRevision: 10,
        }),
      ]);
      await vi.waitFor(
        async () => {
          const waiters = await db.$queryRaw<{ pid: number }[]>`
          SELECT pid FROM pg_stat_activity WHERE ${blocker} = ANY(pg_blocking_pids(pid))
        `;
          expect(waiters.length).toBeGreaterThan(0);
        },
        { timeout: 2000 },
      );
    } finally {
      release();
      await Promise.all([editing, publication]);
    }
    const outcome = (await publication)?.[0];
    expect(outcome?.status).toBe('rejected');
    if (outcome?.status !== 'rejected') throw new Error('过期发布未被拒绝');
    expect(outcome.reason).toEqual(conflict('WORKFLOW_REVISION_CONFLICT'));
    expect(
      await db.workflowVersion.count({ where: { workflowId: f.workflow.id } }),
    ).toBe(0);
  });

  it('publish 重新校验数据库 Draft，无效定义不创建版本，修复后仍从版本 1 开始', async () => {
    const f = await fixture();
    await db.workflow.update({
      where: { id: f.workflow.id },
      data: { draft: { patch: [] } },
    });
    await expect(
      service.publish(ownerId, {
        workflowId: f.workflow.id,
        expectedRevision: 10,
      }),
    ).rejects.toBeInstanceOf(z.ZodError);
    expect(
      await db.workflowVersion.count({ where: { workflowId: f.workflow.id } }),
    ).toBe(0);
    await service.updateDraft(ownerId, {
      workflowId: f.workflow.id,
      expectedRevision: 10,
      definition: definition('修复'),
    });
    expect(
      await service.publish(ownerId, {
        workflowId: f.workflow.id,
        expectedRevision: 11,
      }),
    ).toMatchObject({ version: 1, sourceRevision: 11 });
  });

  it('服务端校验输入，缺少 expectedRevision、额外字段或无效定义均不写入', async () => {
    const f = await fixture();
    for (const expectedRevision of [undefined, 0, -1, 1.5, '10']) {
      await expect(
        service.updateDraft(ownerId, {
          workflowId: f.workflow.id,
          expectedRevision,
          definition: definition('B'),
        }),
      ).rejects.toBeInstanceOf(z.ZodError);
      await expect(
        service.publish(ownerId, {
          workflowId: f.workflow.id,
          expectedRevision,
        }),
      ).rejects.toBeInstanceOf(z.ZodError);
    }
    await expect(
      service.updateDraft(ownerId, {
        workflowId: f.workflow.id,
        expectedRevision: 10,
        definition: { patch: [] },
      }),
    ).rejects.toBeInstanceOf(z.ZodError);
    await expect(
      service.publish(ownerId, {
        workflowId: f.workflow.id,
        expectedRevision: 10,
        definition: definition('B'),
      }),
    ).rejects.toBeInstanceOf(z.ZodError);
    expect(
      await db.workflow.findUniqueOrThrow({ where: { id: f.workflow.id } }),
    ).toEqual(f.workflow);
    expect(
      await db.workflowVersion.count({ where: { workflowId: f.workflow.id } }),
    ).toBe(0);
  });

  it('编辑与发布都检查所有者，不泄漏其他所有者的修订冲突，转移后旧权限失效', async () => {
    const f = await fixture();
    const input = { workflowId: f.workflow.id, expectedRevision: 9 };
    await expect(
      service.updateDraft(otherId, {
        ...input,
        definition: definition('越权'),
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.publish(otherId, input)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await db.project.update({
      where: { id: f.project.id },
      data: { ownerId: otherId },
    });
    await expect(
      service.updateDraft(ownerId, {
        ...input,
        definition: definition('过期权限'),
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.publish(ownerId, input)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(
      await db.workflowVersion.count({ where: { workflowId: f.workflow.id } }),
    ).toBe(0);
    expect(
      await otherService.publish(otherId, { ...input, expectedRevision: 10 }),
    ).toMatchObject({ version: 1, sourceRevision: 10 });
  });

  it('数据库唯一约束兜底禁止同修订生成第二版本，sourceRevision 必须为正数', async () => {
    const f = await fixture();
    await service.publish(ownerId, {
      workflowId: f.workflow.id,
      expectedRevision: 10,
    });
    const data = {
      workflowId: f.workflow.id,
      version: 2,
      definition: z.record(z.string(), z.json()).parse(f.draft),
    };
    await expect(
      db.workflowVersion.create({ data: { ...data, sourceRevision: 10 } }),
    ).rejects.toMatchObject({ code: 'P2002' });
    await expect(
      db.workflowVersion.create({ data: { ...data, sourceRevision: 0 } }),
    ).rejects.toThrow();
    expect(
      await db.workflowVersion.count({ where: { workflowId: f.workflow.id } }),
    ).toBe(1);
  });
});
