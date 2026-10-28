import { describe, expect, it, vi } from 'vitest';
import {
  executionTreeQuerySchema,
  type ExecutionTreeEntry,
  type ExecutionTreeParentRef,
  type ExecutionTreeRun,
} from '@dramaflow/contracts';
import {
  queryExecutionTree,
  type ExecutionTreeSource,
} from '../../../src/workflow/execution-tree/execution-tree-query.js';
const time = '2026-10-26T00:00:00.000Z';
const run: ExecutionTreeRun = {
  type: 'workflow_run',
  id: 'run',
  workflowId: 'workflow',
  workflowVersionId: 'version',
  status: 'running',
  createdAt: time,
};
const root = { type: 'workflow_run' as const, id: run.id };
const ref = (type: ExecutionTreeParentRef['type'], id: string): ExecutionTreeParentRef => ({
  type,
  id,
});
function node(
  id: string,
  parent: Exclude<ExecutionTreeParentRef, { type: 'node_run' }>,
  attempt = 1,
): ExecutionTreeEntry {
  return {
    type: 'node_run',
    id,
    parent,
    nodeId: 'reused-local-node-id',
    occurrenceId: `occ-${id}`,
    attempt,
    status: 'running',
    startedAt: time,
  };
}
function execution(
  id: string,
  parentId: string,
  kind = 'custom_composite_call',
): ExecutionTreeEntry {
  return {
    type: 'child_execution',
    id,
    kind,
    parent: { type: 'node_run', id: parentId },
    status: 'running',
    createdAt: time,
    startedAt: time,
  };
}
function sourceFor(rows: ExecutionTreeEntry[]) {
  const source = {
    get: vi.fn<ExecutionTreeSource['get']>(
      async (target) =>
        rows.find((row) => row.id === target.id && row.type === target.type) ?? null,
    ),
    children: vi.fn<ExecutionTreeSource['children']>(async (parent, page) => {
      const children = rows.filter(
        (row) => row.parent.id === parent.id && row.parent.type === parent.type,
      );
      const offset = page.afterId ? children.findIndex((row) => row.id === page.afterId) + 1 : 0;
      return children.slice(offset, offset + page.take);
    }),
  };
  return source;
}
const query = (
  parentType: ExecutionTreeParentRef['type'] = 'workflow_run',
  parentId?: string,
  extra: Record<string, unknown> = {},
) => executionTreeQuerySchema.parse({ parentType, ...(parentId ? { parentId } : {}), ...extra });

describe('Execution Tree 通用结构遍历', () => {
  it('根层按真实 NodeRun 保留同名节点 / 多 attempt，不以 nodeId 合并', async () => {
    const source = sourceFor([node('n1', root), node('n2', root, 2)]);
    const result = await queryExecutionTree(source, run, query());
    expect(result.items.map((row) => row.id)).toEqual(['n1', 'n2']);
    expect(source.children).toHaveBeenCalledWith(root, { take: 51 });
  });
  it('非 Iteration 数据源也能按相同协议形成多层父子关系，不需要 index', async () => {
    const rows = [
      node('outer', root),
      execution('outer-call', 'outer'),
      node('inner', { type: 'child_execution', id: 'outer-call' }),
      execution('inner-call', 'inner', 'another_kind'),
      node('leaf', { type: 'child_execution', id: 'inner-call' }),
    ];
    const source = sourceFor(rows);
    for (const parent of [
      root,
      ref('node_run', 'outer'),
      ref('child_execution', 'outer-call'),
      ref('node_run', 'inner'),
      ref('child_execution', 'inner-call'),
    ]) {
      const result = await queryExecutionTree(source, run, query(parent.type, parent.id));
      expect(result.items).toEqual(
        rows.filter((row) => row.parent.id === parent.id && row.parent.type === parent.type),
      );
    }
    expect(rows[1]).not.toHaveProperty('metadata');
  });
  it('分页游标绑定 Run 与父条目，身份不由分页位置生成', async () => {
    const source = sourceFor([
      node('owner', root),
      ...['stable-A', 'stable-B', 'stable-C'].map((id) => execution(id, 'owner')),
    ]);
    const first = await queryExecutionTree(source, run, query('node_run', 'owner', { limit: 2 }));
    const second = await queryExecutionTree(
      source,
      run,
      query('node_run', 'owner', { limit: 2, after: first.nextCursor }),
    );
    expect([...first.items, ...second.items].map((row) => row.id)).toEqual([
      'stable-A',
      'stable-B',
      'stable-C',
    ]);
    expect(second.nextCursor).toBeNull();
    await expect(
      queryExecutionTree(source, run, query('workflow_run', run.id, { after: first.nextCursor })),
    ).rejects.toMatchObject({ code: 'CURSOR_INVALID' });
    const otherRun = { ...run, id: 'another-run' };
    const otherSource = sourceFor([node('owner', { type: 'workflow_run', id: otherRun.id })]);
    await expect(
      queryExecutionTree(
        otherSource,
        otherRun,
        query('node_run', 'owner', { after: first.nextCursor }),
      ),
    ).rejects.toMatchObject({ code: 'CURSOR_INVALID' });
    await expect(
      queryExecutionTree(source, run, query('node_run', 'owner', { after: 'broken' })),
    ).rejects.toMatchObject({ code: 'CURSOR_INVALID' });
    source.get.mockImplementation(async (target) =>
      target.id === 'stable-B' ? null : target.id === 'owner' ? node('owner', root) : null,
    );
    await expect(
      queryExecutionTree(source, run, query('node_run', 'owner', { after: first.nextCursor })),
    ).rejects.toMatchObject({ code: 'CURSOR_INVALID' });
  });
  it('没有执行记录的根或没有 Child 的节点返回空层，不虚构执行', async () => {
    expect((await queryExecutionTree(sourceFor([]), run, query())).items).toEqual([]);
    expect(
      (
        await queryExecutionTree(
          sourceFor([node('array-output', root)]),
          run,
          query('node_run', 'array-output'),
        )
      ).items,
    ).toEqual([]);
  });
  it('不把不存在父、孤儿、跨 Run 父链或循环补挂到 root', async () => {
    await expect(
      queryExecutionTree(sourceFor([]), run, query('node_run', 'missing')),
    ).rejects.toMatchObject({ code: 'PARENT_NOT_FOUND' });
    const orphan = node('orphan', { type: 'child_execution', id: 'missing' });
    await expect(
      queryExecutionTree(sourceFor([orphan]), run, query('node_run', 'orphan')),
    ).rejects.toMatchObject({ code: 'INCONSISTENT' });
    await expect(
      queryExecutionTree(
        sourceFor([node('foreign', { type: 'workflow_run', id: 'other-run' })]),
        run,
        query('node_run', 'foreign'),
      ),
    ).rejects.toMatchObject({ code: 'INCONSISTENT' });
    const cycle = sourceFor([node('n', { type: 'child_execution', id: 'e' }), execution('e', 'n')]);
    await expect(queryExecutionTree(cycle, run, query('node_run', 'n'))).rejects.toMatchObject({
      code: 'INCONSISTENT',
    });
    expect(cycle.get).toHaveBeenCalledTimes(2);
  });
  it('拒绝错误父引用、重复身份或原生信息污染的 source 输出', async () => {
    for (const rows of [
      [node('n', { type: 'workflow_run', id: 'wrong' })],
      [node('n', root), node('n', root)],
    ]) {
      const source = sourceFor([]);
      source.children.mockResolvedValue(rows);
      await expect(queryExecutionTree(source, run, query())).rejects.toMatchObject({
        code: 'INCONSISTENT',
      });
    }
    const source = sourceFor([]);
    const polluted = { ...node('n', root), checkpointNs: 'private' };
    source.children.mockResolvedValue([polluted]);
    await expect(queryExecutionTree(source, run, query())).rejects.toMatchObject({
      code: 'INCONSISTENT',
    });
  });
});
