import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatabaseService } from '../../../../src/database/database.service.js';
import { WorkflowRunQueryService } from '../../../../src/workflow/run/query/workflow-run-query.service.js';
const enabled = process.env.DRAMAFLOW_INTEGRATION === '1';
if (enabled) {
  const url = new URL(process.env.DATABASE_URL ?? '');
  if (!['localhost', '127.0.0.1'].includes(url.hostname) || url.pathname !== '/dramaflow_test')
    throw Error('只允许本机测试数据库');
}
describe.skipIf(!enabled)('Run History PostgreSQL 分页与权限', () => {
  const db = enabled ? new DatabaseService() : undefined;
  const owner = randomUUID(),
    other = randomUUID();
  const projectIds = [randomUUID(), randomUUID(), randomUUID()];
  const workflowIds = [randomUUID(), randomUUID(), randomUUID()];
  const versionIds = [randomUUID(), randomUUID()];
  const ids = Array.from({ length: 25 }, () => randomUUID())
    .sort()
    .reverse();
  const time = new Date('2026-10-28T00:00:00.123Z');
  beforeAll(async () => {
    for (const id of [owner, other])
      await db!.client.user.create({
        data: { id, name: '运行历史测试', email: `${id}@example.test` },
      });
    for (let i = 0; i < 3; i++)
      await db!.client.project.create({
        data: {
          id: projectIds[i],
          ownerId: i === 2 ? other : owner,
          name: '运行历史测试',
          viewport: {},
          workflow: { create: { id: workflowIds[i], name: '测试', draft: {} } },
        },
      });
    for (let i = 0; i < 2; i++)
      await db!.client.workflowVersion.create({
        data: {
          id: versionIds[i],
          workflowId: workflowIds[0]!,
          version: i + 1,
          sourceRevision: i + 1,
          definition: {},
        },
      });
    for (let i = 0; i < ids.length; i++)
      await db!.client.workflowRun.create({
        data: {
          id: ids[i],
          projectId: projectIds[0]!,
          workflowId: workflowIds[0]!,
          workflowVersionId: versionIds[i % 2]!,
          invocationKey: randomUUID(),
          threadId: randomUUID(),
          status: ['completed', 'failed', 'waiting', 'running'][i % 4],
          inputs: {},
          createdAt: time,
          startedAt: time,
          ...(i % 4 === 0 ? { completedAt: time, outputs: {} } : {}),
          ...(i % 4 === 1
            ? {
                completedAt: time,
                error: {
                  stage: 'invoke',
                  code: 'WORKFLOW_EXECUTION_FAILED',
                  message: '工作流执行失败',
                },
              }
            : {}),
        },
      });
    for (let i = 1; i < 3; i++)
      await db!.client.workflowRun.create({
        data: {
          projectId: projectIds[i]!,
          workflowId: workflowIds[i]!,
          workflowVersionId: 'unrelated-version',
          invocationKey: randomUUID(),
          threadId: randomUUID(),
          inputs: {},
          createdAt: new Date(time.getTime() + 1000),
        },
      });
  });
  afterAll(async () => {
    if (db) {
      await db.client.user.deleteMany({ where: { id: { in: [owner, other] } } });
      await db.onModuleDestroy();
    }
  });
  it('同时间的 25 个 Run 无重复遗漏，新增更晚 Run 不改变后续页；固定版本与错误摘要正确且无私有列', async () => {
    const query = new WorkflowRunQueryService(db!);
    const first = await query.listRuns(owner, projectIds[0]!, workflowIds[0]!, {});
    expect(first.items.map((row) => row.id)).toEqual(ids.slice(0, 20));
    expect(first.nextCursor).toBeTruthy();
    await db!.client.workflowRun.create({
      data: {
        projectId: projectIds[0]!,
        workflowId: workflowIds[0]!,
        workflowVersionId: versionIds[0]!,
        invocationKey: randomUUID(),
        threadId: randomUUID(),
        inputs: {},
        createdAt: new Date(time.getTime() + 1),
      },
    });
    const second = await query.listRuns(owner, projectIds[0]!, workflowIds[0]!, {
      cursor: first.nextCursor,
    });
    expect(second.items.map((row) => row.id)).toEqual(ids.slice(20));
    expect(second.nextCursor).toBeNull();
    expect(new Set(first.items.map((row) => row.status))).toEqual(
      new Set(['completed', 'failed', 'waiting', 'running']),
    );
    expect(first.items[0]).toMatchObject({ workflowVersionId: versionIds[0], version: 1 });
    expect(first.items[1]).toMatchObject({
      workflowVersionId: versionIds[1],
      version: 2,
      error: { message: '工作流执行失败' },
    });
    for (const row of [...first.items, ...second.items])
      for (const key of ['threadId', 'inputs', 'outputs', 'jobId', 'checkpoint', 'invocationKey'])
        expect(row).not.toHaveProperty(key);
  });
  it('不同 Workflow / Project / 用户不能串记录', async () => {
    const query = new WorkflowRunQueryService(db!);
    expect((await query.listRuns(owner, projectIds[1]!, workflowIds[1]!, {})).items).toHaveLength(
      1,
    );
    await expect(query.listRuns(owner, projectIds[1]!, workflowIds[0]!, {})).rejects.toMatchObject({
      status: 404,
    });
    await expect(query.listRuns(other, projectIds[0]!, workflowIds[0]!, {})).rejects.toMatchObject({
      status: 404,
    });
    await expect(query.listRuns(owner, projectIds[2]!, workflowIds[2]!, {})).rejects.toMatchObject({
      status: 404,
    });
  });
});
