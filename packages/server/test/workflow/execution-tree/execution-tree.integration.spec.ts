import { randomUUID } from 'node:crypto';
import { describe, beforeAll, afterAll, expect, it } from 'vitest';
import { StringType, type NodeRun } from '@dramaflow/contracts';
import { deriveChildScope, type IterationRunRepository } from '@dramaflow/workflow';
import { DatabaseService } from '../../../src/database/database.service.js';
import { WorkflowRunRepositories } from '../../../src/workflow/run/repository/workflow-run-repository.js';
import { NodeRunRepositories } from '../../../src/workflow/runtime/execution/node-run-repository.js';
import { WorkflowExecutionTreeService } from '../../../src/workflow/execution-tree/workflow-execution-tree.service.js';

const enabled = process.env.DRAMAFLOW_INTEGRATION === '1';
if (enabled) {
  const url = new URL(process.env.DATABASE_URL ?? '');
  if (!['localhost', '127.0.0.1'].includes(url.hostname) || url.pathname !== '/dramaflow_test')
    throw new Error('Execution Tree 集成测试仅允许本机 dramaflow_test');
}
describe.skipIf(!enabled)('只读 Execution Tree PostgreSQL Adapter', () => {
  const database = enabled ? new DatabaseService() : undefined;
  const db = () => database!.client;
  const ownerId = randomUUID();
  let projectId: string;
  const trees = () => new WorkflowExecutionTreeService(database!);
  beforeAll(async () => {
    await db().user.create({
      data: { id: ownerId, name: '运行树测试', email: `${ownerId}@example.test` },
    });
    projectId = (await db().project.create({ data: { ownerId, name: '运行树测试' } })).id;
  });
  afterAll(async () => {
    if (database) {
      await db().user.delete({ where: { id: ownerId } });
      await database.onModuleDestroy();
    }
  });
  async function fixture() {
    const runs = await new WorkflowRunRepositories(database!).forProject(ownerId, projectId);
    const run = await runs.create({
      projectId,
      workflowId: 'workflow',
      workflowVersionId: 'version',
      invocationKey: randomUUID(),
      inputs: {},
    });
    await runs.markRunning(run.id);
    const repository = await new NodeRunRepositories(database!).forRun(ownerId, projectId, run.id);
    return { run, repository };
  }
  async function node(
    f: Awaited<ReturnType<typeof fixture>>,
    nodeId: string,
    scopeKey = 'root',
    childExecutionId?: string,
  ) {
    const occurrence = await f.repository.getOrCreateOccurrence({
      workflowRunId: f.run.id,
      nodeId,
      scopeKey,
    });
    return f.repository.createRunning({
      workflowRunId: f.run.id,
      nodeId,
      occurrenceId: occurrence.id,
      ...(childExecutionId ? { childExecutionId } : {}),
    });
  }
  async function item(repository: IterationRunRepository, parent: NodeRun, index: number) {
    return repository.getOrCreateIterationItemRunning({
      workflowRunId: parent.workflowRunId,
      parentNodeRunId: parent.id,
      parentNodeId: parent.nodeId,
      index,
      scopeKey: deriveChildScope(parent.scopeKey, {
        kind: 'iteration_item',
        ownerOccurrenceId: parent.occurrenceId,
        ownerNodeRunId: parent.id,
        slot: 'body',
        index,
      }),
    });
  }
  const children = (runId: string, type: 'node_run' | 'child_execution', id: string, extra = {}) =>
    trees().query(ownerId, runId, { parentType: type, parentId: id, ...extra });

  it('普通 Run、空 Run、多 attempt 和普通数组输出；查询不会创建 Child 或修改审计', async () => {
    const f = await fixture();
    expect((await trees().query(ownerId, f.run.id)).items).toEqual([]);
    const first = await node(f, 'same');
    await f.repository.updateInputs(first.id, {});
    await f.repository.markCompleted(first.id, {
      values: {
        storage: 'inline',
        type: { kind: 'array', itemType: StringType },
        value: ['A', 'B', 'C'],
      },
    });
    const second = await node(f, 'same');
    const before = await db().nodeRun.findMany({
      where: { workflowRunId: f.run.id },
      orderBy: { attempt: 'asc' },
    });
    const root = await trees().query(ownerId, f.run.id, { limit: 1 });
    const next = await trees().query(ownerId, f.run.id, { limit: 1, after: root.nextCursor });
    expect([...root.items, ...next.items]).toMatchObject([
      { id: first.id, attempt: 1, occurrenceId: first.occurrenceId },
      { id: second.id, attempt: 2, occurrenceId: first.occurrenceId },
    ]);
    expect((await children(f.run.id, 'node_run', first.id)).items).toEqual([]);
    expect(await db().childExecution.count({ where: { workflowRunId: f.run.id } })).toBe(0);
    expect(
      await db().nodeRun.findMany({
        where: { workflowRunId: f.run.id },
        orderBy: { attempt: 'asc' },
      }),
    ).toEqual(before);
  });
  it('[A,B,C] 的三个稳定 ID、顺序、Body 外键和 completed / failed / running 独立投影', async () => {
    const f = await fixture();
    const owner = await node(f, 'iteration');
    // 故意按非 index 顺序写入，查询必须依赖正式字段排序。
    const c = await item(f.repository, owner, 2);
    const a = await item(f.repository, owner, 0);
    const b = await item(f.repository, owner, 1);
    const bodies = await Promise.all(
      [a, b, c].map(async (execution, index) => {
        const body = await node(f, 'same', execution.scopeKey, execution.id);
        await f.repository.updateInputs(body.id, {
          item: { storage: 'inline', type: StringType, value: ['A', 'B', 'C'][index]! },
        });
        return body;
      }),
    );
    await f.repository.markCompleted(bodies[0]!.id, {});
    await f.repository.markIterationItemCompleted(a.id);
    const error = { stage: 'execute', message: '执行失败' };
    await f.repository.markFailed(bodies[1]!.id, error);
    await f.repository.markIterationItemFailed(b.id, error);
    const first = await children(f.run.id, 'node_run', owner.id, { limit: 2 });
    const last = await children(f.run.id, 'node_run', owner.id, {
      limit: 2,
      after: first.nextCursor,
    });
    const entries = [...first.items, ...last.items];
    expect(entries).toMatchObject([
      { id: a.id, metadata: { index: 0 }, status: 'completed' },
      { id: b.id, metadata: { index: 1 }, status: 'failed' },
      { id: c.id, metadata: { index: 2 }, status: 'running' },
    ]);
    for (const [index, entry] of entries.entries()) {
      expect(entry.parent).toEqual({ type: 'node_run', id: owner.id });
      expect((await children(f.run.id, 'child_execution', entry.id)).items).toMatchObject([
        { id: bodies[index]!.id, parent: { type: 'child_execution', id: entry.id } },
      ]);
    }
    const serialized = JSON.stringify(first);
    for (const field of [
      'ChildExecution',
      'childExecutionId',
      'parentNodeRunId',
      'scopeKey',
      'threadId',
      'checkpoint',
      'taskId',
      'inputs',
      'outputs',
    ])
      expect(serialized).not.toContain(field);
  });
  it('现有 A#2 → B#5 → NodeRun 外键能够无歧义表达嵌套，同名 nodeId 不合并', async () => {
    const f = await fixture();
    const a = await node(f, 'same');
    const aItem = await item(f.repository, a, 2);
    const b = await node(f, 'same', aItem.scopeKey, aItem.id);
    const bItem = await item(f.repository, b, 5);
    const leaf = await node(f, 'same', bItem.scopeKey, bItem.id);
    expect((await trees().query(ownerId, f.run.id)).items).toMatchObject([{ id: a.id }]);
    expect((await children(f.run.id, 'node_run', a.id)).items).toMatchObject([
      { id: aItem.id, metadata: { index: 2 } },
    ]);
    expect((await children(f.run.id, 'child_execution', aItem.id)).items).toMatchObject([
      { id: b.id },
    ]);
    expect((await children(f.run.id, 'node_run', b.id)).items).toMatchObject([
      { id: bItem.id, metadata: { index: 5 } },
    ]);
    expect((await children(f.run.id, 'child_execution', bItem.id)).items).toMatchObject([
      { id: leaf.id },
    ]);
    expect(new Set([a.occurrenceId, b.occurrenceId, leaf.occurrenceId]).size).toBe(3);
  });
  it('尚无 Body NodeRun 的 running item 仍出现；不同父 attempt 的相同 index 不混淆', async () => {
    const f = await fixture();
    const p1 = await node(f, 'iteration');
    const e1 = await item(f.repository, p1, 0);
    const p2 = await node(f, 'iteration');
    const e2 = await item(f.repository, p2, 0);
    expect((await children(f.run.id, 'node_run', p1.id)).items).toMatchObject([
      { id: e1.id, status: 'running' },
    ]);
    expect((await children(f.run.id, 'node_run', p2.id)).items).toMatchObject([
      { id: e2.id, status: 'running' },
    ]);
    expect((await children(f.run.id, 'child_execution', e1.id)).items).toEqual([]);
    expect(e1.id).not.toBe(e2.id);
  });
  it('统一 Owner / Project / Run 权限，跨 Run 父 ID 和游标拒绝', async () => {
    const f = await fixture();
    const other = await fixture();
    const p = await node(f, 'owner');
    const e = await item(f.repository, p, 0);
    await item(f.repository, p, 1);
    const page = await children(f.run.id, 'node_run', p.id, { limit: 1 });
    await expect(trees().query('outsider', f.run.id)).rejects.toMatchObject({ status: 404 });
    await expect(children(other.run.id, 'child_execution', e.id)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      trees().query(ownerId, f.run.id, { after: page.nextCursor }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(trees().query(ownerId, 'missing-run')).rejects.toMatchObject({ status: 404 });
  });
});
