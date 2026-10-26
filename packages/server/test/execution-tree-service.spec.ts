import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@dramaflow/database';
import type { ExecutionTreeResponse } from '@dramaflow/contracts';
import { DatabaseService } from '../src/database/database.service.js';
import { WorkflowExecutionTreeService } from '../src/workflow/execution-tree/workflow-execution-tree.service.js';
import { PrismaExecutionTreeAdapter } from '../src/workflow/execution-tree/prisma-execution-tree-adapter.js';

const time = new Date('2026-10-26T00:00:00.000Z');
function fixture(authorized = true) {
  const tx = {
    workflowRun: {
      findFirst: vi.fn().mockResolvedValue(
        authorized
          ? {
              id: 'run',
              projectId: 'project',
              workflowId: 'workflow',
              workflowVersionId: 'version',
              status: 'running',
              error: null,
              createdAt: time,
              startedAt: time,
              completedAt: null,
            }
          : null,
      ),
    },
    nodeRun: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
    },
    iterationItemRun: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
    },
  };
  const transaction = vi.fn(
    async (read: (tx: Prisma.TransactionClient) => Promise<ExecutionTreeResponse>) =>
      read(tx as unknown as Prisma.TransactionClient),
  );
  const database = { client: { $transaction: transaction } } as unknown as DatabaseService;
  return { service: new WorkflowExecutionTreeService(database), tx, transaction };
}
describe('Execution Tree 统一授权与失败边界', () => {
  it('查询先检查 Project Owner / Run，同一只读快照内再读取子记录', async () => {
    const f = fixture();
    expect(await f.service.query('owner', 'run')).toMatchObject({
      run: { id: 'run' },
      parent: { type: 'workflow_run', id: 'run' },
      items: [],
    });
    expect(f.tx.workflowRun.findFirst.mock.calls[0]![0].where).toEqual({
      id: 'run',
      project: { ownerId: 'owner' },
    });
    expect(f.tx.nodeRun.findMany.mock.calls[0]![0]).toMatchObject({
      where: { projectId: 'project', workflowRunId: 'run', iterationItemRunId: null },
      take: 51,
    });
    expect(f.transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'RepeatableRead',
    });
  });
  it('未授权或 Run 不存在统一 404，不读取任何子执行来源', async () => {
    const f = fixture(false);
    await expect(f.service.query('outsider', 'run')).rejects.toMatchObject({
      status: 404,
      response: { code: 'WORKFLOW_RUN_NOT_FOUND' },
    });
    for (const delegate of [f.tx.nodeRun, f.tx.iterationItemRun]) {
      expect(delegate.findFirst).not.toHaveBeenCalled();
      expect(delegate.findMany).not.toHaveBeenCalled();
    }
  });
  it('父 ID 必须在已授权 Run 内，非法参数不触发数据库查询', async () => {
    const f = fixture();
    await expect(
      f.service.query('owner', 'run', { parentType: 'node_run', parentId: 'foreign' }),
    ).rejects.toMatchObject({ status: 404 });
    expect(f.tx.nodeRun.findFirst.mock.calls[0]![0].where).toEqual({
      id: 'foreign',
      workflowRunId: 'run',
      projectId: 'project',
    });
    const invalid = fixture();
    await expect(
      invalid.service.query('owner', 'run', { limit: 'Infinity' }),
    ).rejects.toMatchObject({ status: 400 });
    expect(invalid.transaction).not.toHaveBeenCalled();
  });
  it('孤儿 / 错挂数据安全报错，不返回底层字段或伪造 root', async () => {
    const f = fixture();
    f.tx.nodeRun.findMany.mockResolvedValue([
      {
        id: 'n',
        projectId: 'project',
        workflowRunId: 'run',
        nodeId: 'same',
        occurrenceId: 'o',
        iterationItemRunId: null,
        occurrence: {
          id: 'o',
          projectId: 'project',
          workflowRunId: 'run',
          nodeId: 'same',
          scopeKey: 'private-orphan-scope',
        },
        iterationItemRun: null,
      },
    ]);
    await expect(f.service.query('owner', 'run')).rejects.toMatchObject({
      status: 500,
      response: {
        code: 'WORKFLOW_EXECUTION_TREE_INCONSISTENT',
        message: '运行树记录无法完整关联',
      },
    });
  });
  it('坏游标 400，数据库故障原样传播，查询不回写失败状态', async () => {
    const f = fixture();
    await expect(f.service.query('owner', 'run', { after: 'bad' })).rejects.toMatchObject({
      status: 400,
      response: { code: 'WORKFLOW_EXECUTION_TREE_CURSOR_INVALID' },
    });
    const failure = new Error('database unavailable');
    f.transaction.mockRejectedValue(failure);
    await expect(f.service.query('owner', 'run')).rejects.toBe(failure);
  });
  it('Adapter 核对 occurrence 与 ItemRun 的 Run、scope 及父节点外键', async () => {
    const baseNode = {
      id: 'n',
      projectId: 'project',
      workflowRunId: 'run',
      nodeId: 'local',
      occurrenceId: 'o',
      iterationItemRunId: 'e',
      attempt: 1,
      status: 'running',
      error: null,
      startedAt: time,
      completedAt: null,
      occurrence: {
        id: 'o',
        projectId: 'project',
        workflowRunId: 'run',
        nodeId: 'local',
        scopeKey: 'opaque',
      },
      iterationItemRun: { id: 'e', projectId: 'project', workflowRunId: 'run', scopeKey: 'opaque' },
    };
    for (const row of [
      { ...baseNode, occurrence: { ...baseNode.occurrence, nodeId: 'other' } },
      { ...baseNode, iterationItemRun: null },
      { ...baseNode, iterationItemRun: { ...baseNode.iterationItemRun, scopeKey: 'wrong' } },
      {
        ...baseNode,
        iterationItemRun: { ...baseNode.iterationItemRun, workflowRunId: 'other-run' },
      },
    ]) {
      const f = fixture();
      f.tx.nodeRun.findFirst.mockResolvedValue(row);
      const adapter = new PrismaExecutionTreeAdapter(f.tx as unknown as Prisma.TransactionClient, {
        projectId: 'project',
        workflowRunId: 'run',
      });
      await expect(adapter.get({ type: 'node_run', id: 'n' })).rejects.toMatchObject({
        code: 'INCONSISTENT',
      });
    }
    const f = fixture();
    f.tx.iterationItemRun.findFirst.mockResolvedValue({
      id: 'e',
      projectId: 'project',
      workflowRunId: 'run',
      iterationNodeRunId: 'owner',
      iterationNodeId: 'A',
      scopeKey: 'opaque',
      index: 0,
      iterationNodeRun: { id: 'owner', nodeId: 'B', projectId: 'project', workflowRunId: 'run' },
    });
    const adapter = new PrismaExecutionTreeAdapter(f.tx as unknown as Prisma.TransactionClient, {
      projectId: 'project',
      workflowRunId: 'run',
    });
    await expect(adapter.get({ type: 'child_execution', id: 'e' })).rejects.toMatchObject({
      code: 'INCONSISTENT',
    });
  });
});
