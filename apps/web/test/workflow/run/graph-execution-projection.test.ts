import { describe, expect, it, vi } from 'vitest';
import type { NodeRun } from '@dramaflow/contracts';
import {
  projectRootGraphExecution,
  resolveNestedGraphExecution,
  loadExecutionChildren,
  selectGraphExecutionInstance,
} from '../../../src/features/workflow/runtime/graph-execution-projection';
import { resolveWorkflowRuntimeNodes } from '../../../src/features/workflow/runtime/runtime-status';
import { graphExecutionFixture, iterationExecutionFixture } from '../../fixtures/graph-execution';
import { pendingReview } from '../../fixtures/human-review';

function fixture() {
  const f = graphExecutionFixture();
  const root = () => projectRootGraphExecution({ ...f, workflowId: f.run.workflowId });
  const load = vi.fn().mockImplementation(async () => f.page());
  const nested = async () => {
    const projection = root();
    if (projection.phase !== 'resolved') throw new Error('测试 root 无效');
    return resolveNestedGraphExecution({ ...f, root: projection, load });
  };
  return { ...f, root, load, nested };
}

describe('通用 Graph Execution Projection', () => {
  it('通用 executionId 选择解决歧义，只接收当前父 attempt 已返回的真实 ChildExecution', async () => {
    const f = iterationExecutionFixture();
    const root = projectRootGraphExecution({ ...f, workflowId: f.run.workflowId });
    if (root.phase !== 'resolved') throw new Error('测试 root 无效');
    const discovered = await resolveNestedGraphExecution({
      ...f,
      root,
      load: vi.fn().mockResolvedValue(f.page(f.executions)),
    });
    expect(discovered.phase).toBe('ambiguous');
    if (!discovered.selection) throw new Error('缺少候选执行');
    expect(discovered.selection.parentNodeRunId).toBe(f.parentRun.id);
    expect(discovered.selection.candidates.map((candidate) => candidate.executionId)).toEqual([
      'item-2',
      'item-0',
      'item-1',
    ]);
    const chosen = selectGraphExecutionInstance({
      selection: discovered.selection,
      executionId: 'item-1',
      nodeRuns: f.nodeRuns,
    });
    expect(chosen).toMatchObject({
      phase: 'resolved',
      instance: { type: 'child_execution', id: 'item-1' },
      nodeRuns: [f.itemRuns[2]!],
    });
    expect(
      selectGraphExecutionInstance({
        selection: discovered.selection,
        executionId: 'unknown',
        nodeRuns: f.nodeRuns,
      }).phase,
    ).toBe('ambiguous');
    expect(
      selectGraphExecutionInstance({
        selection: discovered.selection,
        executionId: 'item-1',
        nodeRuns: [{ ...f.childRun, workflowRunId: 'other-run' }],
      }).phase,
    ).toBe('unavailable');
  });
  it('Root 继续合成 PendingHumanReview，内部同名节点不会继承父图 waiting', async () => {
    const f = fixture();
    f.workflow.nodes.push({ ...f.action });
    f.version.definition = structuredClone(f.workflow);
    f.run.status = 'waiting';
    f.childRun.status = 'running';
    f.nodeRuns.push({
      ...f.parentRun,
      id: 'root-review',
      nodeId: 'generate',
      occurrenceId: 'root-review-occurrence',
      status: 'running',
    });
    f.runStatus.review = {
      phase: 'ready',
      item: { ...pendingReview, node: { id: 'generate', name: '审核' } },
      feedback: '',
      notice: null,
    };
    expect(
      resolveWorkflowRuntimeNodes({
        workflow: f.workflow,
        runStatus: f.runStatus,
        projection: f.root(),
      }).get('generate')?.status,
    ).toBe('waiting');
    const nested = resolveWorkflowRuntimeNodes({
      workflow: f.child,
      runStatus: f.runStatus,
      projection: await f.nested(),
    }).get('generate');
    expect(nested?.status).toBe('running');
    expect(nested?.review).toBeNull();
  });
  it('Root 边界保留旧状态与 occurrence / attempt 语义，不混入内部记录', () => {
    const f = fixture();
    f.nodeRuns.push({ ...f.childRun, nodeId: f.parentRun.nodeId, attempt: 99, status: 'failed' });
    const projection = f.root();
    expect(projection).toMatchObject({
      phase: 'resolved',
      instance: { type: 'workflow_run', id: f.run.id },
      nodeRuns: [f.parentRun],
    });
    expect(
      resolveWorkflowRuntimeNodes({ workflow: f.workflow, runStatus: f.runStatus, projection }).get(
        f.owner.id,
      )?.status,
    ).toBe('completed');
  });

  it.each(['completed', 'running', 'failed'] as const)(
    '父 completed、内部 %s，Canvas 取真实 child 状态',
    async (status) => {
      const f = fixture();
      f.childRun.status = status;
      const projection = await f.nested();
      expect(projection).toMatchObject({
        phase: 'resolved',
        definition: { workflowVersionId: f.version.id, path: f.location },
        instance: { type: 'child_execution', id: f.execution.id },
        nodeRuns: [f.childRun],
      });
      expect(
        resolveWorkflowRuntimeNodes({ workflow: f.child, runStatus: f.runStatus, projection }).get(
          'generate',
        )?.status,
      ).toBe(status);
      expect(f.load.mock.calls[0]![1]).toMatchObject({
        parentType: 'node_run',
        parentId: f.parentRun.id,
      });
    },
  );

  it('父 occurrence 的当前 attempt 决定 ChildExecution；内部再选择自己的当前 attempt', async () => {
    const f = fixture();
    const parent2 = { ...f.parentRun, id: 'parent-attempt-2', attempt: 2 };
    const child2: NodeRun = { ...f.childRun, id: 'child-attempt-2', attempt: 2, status: 'failed' };
    f.nodeRuns.push(child2, parent2);
    f.load.mockImplementation(async (_run, query) => ({
      ...f.page([{ ...f.execution, parent: { type: 'node_run', id: query.parentId } }]),
      parent: { type: 'node_run', id: query.parentId },
    }));
    const projection = await f.nested();
    const state = resolveWorkflowRuntimeNodes({
      workflow: f.child,
      runStatus: f.runStatus,
      projection,
    }).get('generate');
    expect(f.load.mock.calls[0]![1].parentId).toBe(parent2.id);
    expect(state?.nodeRun?.id).toBe(child2.id);
    expect(state?.attempts.map(({ attempt }) => attempt)).toEqual([1, 2]);
  });

  it('同名节点在 Root、其他 graph 与其他 ChildExecution 的高 attempt 均不能串入当前实例', async () => {
    const f = fixture();
    f.workflow.nodes.push({ ...f.action });
    f.version.definition = structuredClone(f.workflow);
    f.nodeRuns.push(
      {
        ...f.parentRun,
        nodeId: 'generate',
        id: 'root-generate',
        occurrenceId: 'root-generate-occurrence',
        attempt: 55,
        status: 'failed',
      },
      {
        ...f.childRun,
        id: 'other-child',
        childExecutionId: 'another-child',
        occurrenceId: 'another-occurrence',
        attempt: 99,
        status: 'running',
      },
    );
    const projection = await f.nested();
    expect(
      resolveWorkflowRuntimeNodes({ workflow: f.child, runStatus: f.runStatus, projection }).get(
        'generate',
      )?.nodeRun?.id,
    ).toBe(f.childRun.id);
    expect(
      resolveWorkflowRuntimeNodes({
        workflow: f.workflow,
        runStatus: f.runStatus,
        projection: f.root(),
      }).get('generate')?.status,
    ).toBe('failed');
  });

  it('同一局部 nodeId 出现多个 occurrence 返回 ambiguous，不跨 occurrence 比较 attempt', async () => {
    const f = fixture();
    f.nodeRuns.push({
      ...f.childRun,
      id: 'another-occurrence-run',
      occurrenceId: 'another-occurrence',
      attempt: 99,
    });
    expect((await f.nested()).phase).toBe('ambiguous');
  });

  it('没有 owner NodeRun 或 ChildExecution 时返回 no_execution', async () => {
    const f = fixture();
    f.load.mockResolvedValue(f.page([]));
    expect((await f.nested()).phase).toBe('no_execution');
    f.nodeRuns.splice(0);
    f.load.mockClear();
    expect((await f.nested()).phase).toBe('no_execution');
    expect(f.load).not.toHaveBeenCalled();
  });

  it('Iteration Body 的多个实例返回 ambiguous，不选第一个或 index=0', async () => {
    const f = fixture();
    f.owner.type = 'flow.iteration';
    f.owner.composite = {
      kind: 'iteration',
      itemType: { kind: 'primitive', name: 'string' },
      invariantInputs: [],
      bodyInputMapping: [],
      body: f.child,
    };
    f.location[0]!.graphKey = 'body';
    f.version.definition = structuredClone(f.workflow);
    f.load.mockResolvedValue(
      f.page([
        { ...f.execution, kind: 'iteration_item', metadata: { index: 0 } },
        { ...f.execution, id: 'second-item', kind: 'iteration_item', metadata: { index: 1 } },
      ]),
    );
    expect((await f.nested()).phase).toBe('ambiguous');
  });

  it.each(['prompt', 'config', 'structure', 'version', 'workflow', 'project'] as const)(
    '拒绝 %s 不匹配，不将旧版本状态覆盖 Draft',
    (change) => {
      const f = fixture();
      if (change === 'prompt')
        f.workflow.nodes[0]!.inputs.text = { type: 'constant', value: '修改' };
      if (change === 'config') f.child.nodes[0]!.config.modelConfigurationId = 'changed-model';
      if (change === 'structure') f.workflow.nodes.push({ ...f.action, id: 'new' });
      if (change === 'version') f.version.id = 'another-version';
      if (change === 'workflow') f.version.workflowId = 'another-workflow';
      if (change === 'project') f.version.projectId = 'another-project';
      expect(f.root().phase).toBe('version_mismatch');
    },
  );

  it('仅移动节点不改变执行定义；不存在的 Definition Location 拒绝投影', async () => {
    const f = fixture();
    f.workflow.nodes[0]!.ui.position.x = 999;
    f.child.nodes[0]!.ui.position.y = 999;
    expect(f.root().phase).toBe('resolved');
    f.location[0]!.nodeId = 'missing';
    expect((await f.nested()).phase).toBe('version_mismatch');
  });

  it('完整读取 ChildExecution 分页，第二页发现另一个实例仍判 ambiguous', async () => {
    const f = fixture();
    f.load
      .mockResolvedValueOnce(f.page([], 'page-2'))
      .mockResolvedValueOnce(f.page([f.execution], 'page-3'))
      .mockResolvedValueOnce(f.page([{ ...f.execution, id: 'second' }]));
    expect((await f.nested()).phase).toBe('ambiguous');
    expect(f.load.mock.calls.map((call) => call[1].after)).toEqual([undefined, 'page-2', 'page-3']);
  });

  it('直属 NodeRuns 使用完整的现有非分页查询集合，第 51 条及以后同样可投影', async () => {
    const f = fixture();
    f.nodeRuns.unshift(
      ...Array.from({ length: 75 }, (_, index) => ({
        ...f.childRun,
        nodeId: `other-${index}`,
        id: `other-run-${index}`,
        occurrenceId: `other-occurrence-${index}`,
      })),
    );
    const projection = await f.nested();
    expect(projection.phase === 'resolved' && projection.nodeRuns).toHaveLength(76);
    expect(
      resolveWorkflowRuntimeNodes({ workflow: f.child, runStatus: f.runStatus, projection }).get(
        'generate',
      )?.status,
    ).toBe('completed');
  });

  it('分页的 parent / version 串线、重复 cursor 与网络失败不会当成 no execution', async () => {
    const f = fixture();
    const read = () => loadExecutionChildren(f.load, f.run, f.execution.parent);
    f.load.mockResolvedValue({ ...f.page(), parent: { type: 'node_run', id: 'other' } });
    await expect(read()).rejects.toThrow('不一致');
    f.load.mockResolvedValue({ ...f.page(), run: { ...f.page().run, workflowVersionId: 'other' } });
    await expect(read()).rejects.toThrow('不一致');
    f.load.mockResolvedValue(f.page([], 'same'));
    await expect(read()).rejects.toThrow('分页位置重复');
    f.load.mockRejectedValue(new Error('读取失败'));
    await expect(read()).rejects.toThrow('读取失败');
  });
});
