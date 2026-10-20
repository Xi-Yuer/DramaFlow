import { randomUUID } from 'node:crypto';
import { StringType, type WorkflowDefinition } from '@dramaflow/contracts';
import { DatabaseService } from '@dramaflow/server';
import { createWorkflowDefinitionSnapshot } from '@dramaflow/workflow';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { WorkflowVersionRepositories } from '../src/workflow/workflow-versions/workflow-version-repository.js';
import { WorkflowService } from '../src/workflow/workflows/workflow.service.js';

if (
  process.env.DRAMAFLOW_INTEGRATION !== '1' ||
  new URL(process.env.DATABASE_URL ?? 'http://invalid').pathname !==
    '/dramaflow_test'
)
  throw new Error(
    'WorkflowVersion 集成测试仅允许在 DramaFlow 的隔离测试数据库运行',
  );

const database = new DatabaseService();
const db = database.client;
const ownerId = randomUUID();
const otherId = randomUUID();
const repositories = new WorkflowVersionRepositories(database);
const workflows = new WorkflowService(database);

beforeAll(async () => {
  for (const id of [ownerId, otherId])
    await db.user.create({
      data: { id, name: '版本读取测试', email: `${id}@example.test` },
    });
});
afterAll(async () => {
  await db.user.deleteMany({ where: { id: { in: [ownerId, otherId] } } });
  await database.onModuleDestroy();
});

function definition(text: string): WorkflowDefinition {
  return {
    inputs: [{ name: 'context', type: StringType }],
    nodes: [
      {
        id: 'source',
        type: 'test.text',
        typeVersion: 1,
        name: '文本',
        inputs: { prompt: { type: 'constant', value: text } },
        config: { style: { tags: ['漫剧', text] } },
        ui: { position: { x: 10, y: 20 } },
      },
      {
        id: 'target',
        type: 'test.echo',
        typeVersion: 2,
        name: '输出',
        inputs: { context: { type: 'workflow_input', key: 'context' } },
        config: {},
        ui: { position: { x: 200, y: 20 } },
      },
    ],
    edges: [
      {
        id: 'text-edge',
        kind: 'data',
        source: { nodeId: 'source', portKey: 'text' },
        target: { nodeId: 'target', portKey: 'text' },
      },
    ],
    outputs: [
      {
        name: 'result',
        type: StringType,
        source: { nodeId: 'target', outputKey: 'text' },
      },
    ],
  };
}

function snapshot(input: unknown) {
  return z
    .record(z.string(), z.json())
    .parse(createWorkflowDefinitionSnapshot(input));
}

async function fixture(draft: WorkflowDefinition = definition('A')) {
  const project = await db.project.create({
    data: { ownerId, name: '版本测试', viewport: {} },
  });
  const workflow = await db.workflow.create({
    data: { projectId: project.id, name: '工作流', draft: snapshot(draft) },
  });
  const repository = await repositories.forProject(ownerId, project.id);
  return { project, workflow, repository };
}

// 只为验收显式写入完整快照和指定版本号；不是生产 publish 服务或并发分配器。
async function storeVersion(workflowId: string, version: number) {
  const workflow = await db.workflow.findUniqueOrThrow({
    where: { id: workflowId },
  });
  return db.workflowVersion.create({
    data: {
      workflowId,
      version,
      sourceRevision: workflow.revision,
      definition: snapshot(workflow.draft),
    },
  });
}

describe('真实 PostgreSQL Workflow / WorkflowVersion', () => {
  it('完整快照 A/B 与当前草稿隔离，新 Repository 和独立数据库连接仍按 ID 读取旧版本', async () => {
    const a = definition('A');
    const b = definition('B');
    const f = await fixture(a);
    expect(f.workflow.revision).toBe(1);
    const v1 = await workflows.publish(ownerId, {
      workflowId: f.workflow.id,
      expectedRevision: 1,
    });
    await workflows.updateDraft(ownerId, {
      workflowId: f.workflow.id,
      expectedRevision: 1,
      definition: b,
    });
    const v2 = await workflows.publish(ownerId, {
      workflowId: f.workflow.id,
      expectedRevision: 2,
    });
    const first = await f.repository.getVersion(v1.id);
    expect(first).toEqual({
      id: v1.id,
      projectId: f.project.id,
      workflowId: f.workflow.id,
      version: 1,
      publishedAt: v1.publishedAt,
      definition: a,
    });
    expect(await f.repository.getVersion(v2.id)).toMatchObject({
      version: 2,
      definition: b,
    });
    expect(
      await db.workflow.findUniqueOrThrow({ where: { id: f.workflow.id } }),
    ).toMatchObject({
      draft: b,
      revision: 2,
    });
    const freshRepository = await new WorkflowVersionRepositories(
      database,
    ).forProject(ownerId, f.project.id);
    expect(await freshRepository.getVersion(v1.id)).toEqual(first);

    const connection = new DatabaseService();
    try {
      const [original] = await db.$queryRaw<
        { pid: number }[]
      >`SELECT pg_backend_pid() AS pid`;
      const [fresh] = await connection.client.$queryRaw<
        { pid: number }[]
      >`SELECT pg_backend_pid() AS pid`;
      expect(fresh?.pid).not.toBe(original?.pid);
      const reconnected = await new WorkflowVersionRepositories(
        connection,
      ).forProject(ownerId, f.project.id);
      expect(await reconnected.getVersion(v1.id)).toEqual(first);
      expect(await reconnected.getVersion(v2.id)).toMatchObject({
        definition: b,
      });
    } finally {
      await connection.onModuleDestroy();
    }
  });

  it('数据库拒绝修改已创建版本的定义、身份、归属、版本号和时间', async () => {
    const f = await fixture();
    const version = await storeVersion(f.workflow.id, 1);
    for (const data of [
      { definition: snapshot(definition('改写')) },
      { id: randomUUID() },
      { workflowId: randomUUID() },
      { version: 2 },
      { sourceRevision: 2 },
      { createdAt: new Date(0) },
    ])
      await expect(
        db.workflowVersion.update({ where: { id: version.id }, data }),
      ).rejects.toThrow();
    expect(
      await db.workflowVersion.findUniqueOrThrow({ where: { id: version.id } }),
    ).toEqual(version);
  });

  it('每项目一个 Workflow、同工作流版本号唯一，版本和 revision 为正数', async () => {
    const f = await fixture();
    await expect(
      db.workflow.create({
        data: {
          projectId: f.project.id,
          name: '重复工作流',
          draft: snapshot(definition('A')),
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
    await storeVersion(f.workflow.id, 1);
    await expect(storeVersion(f.workflow.id, 1)).rejects.toMatchObject({
      code: 'P2002',
    });
    await expect(storeVersion(f.workflow.id, 0)).rejects.toThrow();
    await expect(
      db.workflow.update({
        where: { id: f.workflow.id },
        data: { revision: 0 },
      }),
    ).rejects.toThrow();
    await expect(
      db.workflowVersion.create({
        data: {
          workflowId: f.workflow.id,
          version: 2,
          sourceRevision: 2,
          definition: [],
        },
      }),
    ).rejects.toThrow();
  });

  it('不存在或跨项目版本返回 null，不回退 draft / latest；工厂拒绝无权访问的项目', async () => {
    const a = await fixture();
    const b = await fixture(definition('B'));
    const version = await storeVersion(a.workflow.id, 1);
    expect(await b.repository.getVersion(version.id)).toBeNull();
    expect(await a.repository.getVersion(a.workflow.id)).toBeNull();
    expect(await a.repository.getVersion('latest')).toBeNull();
    expect(await a.repository.getVersion(randomUUID())).toBeNull();
    await expect(
      repositories.forProject(otherId, a.project.id),
    ).rejects.toThrow('项目不存在或无权访问');
  });

  it('每次读取重新验证所有者，已有 Repository 不能沿用过期权限', async () => {
    const f = await fixture();
    const version = await storeVersion(f.workflow.id, 1);
    await db.project.update({
      where: { id: f.project.id },
      data: { ownerId: otherId },
    });
    expect(await f.repository.getVersion(version.id)).toBeNull();
    const current = await repositories.forProject(otherId, f.project.id);
    expect(await current.getVersion(version.id)).toMatchObject({
      id: version.id,
    });
  });

  it('数据库内容不符合正式 Definition 时拒绝读取，不用有效 draft 补齐', async () => {
    const f = await fixture();
    const version = await db.workflowVersion.create({
      data: {
        workflowId: f.workflow.id,
        version: 1,
        sourceRevision: 1,
        definition: { patch: [] },
      },
    });
    await expect(f.repository.getVersion(version.id)).rejects.toBeInstanceOf(
      z.ZodError,
    );
  });

  it('删除 Workflow 级联删除版本，读取不返回已删除快照', async () => {
    const f = await fixture();
    const version = await storeVersion(f.workflow.id, 1);
    await db.workflow.delete({ where: { id: f.workflow.id } });
    expect(await f.repository.getVersion(version.id)).toBeNull();
    expect(
      await db.workflowVersion.count({ where: { workflowId: f.workflow.id } }),
    ).toBe(0);
  });
});
