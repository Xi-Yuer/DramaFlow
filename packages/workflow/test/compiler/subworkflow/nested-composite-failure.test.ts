import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Command,
  END,
  GraphInterrupt,
  ParentCommand,
  interrupt,
  type StateSnapshot,
} from '@langchain/langgraph';
import { z } from 'zod';
import { StringType } from '@dramaflow/contracts';
import {
  ChildExecutionRecordingError,
  NodeExecutionError,
  NodeRunRecordingError,
  failCompositeExecution,
  workflowStateSchema,
} from '../../../src/index.js';
import { nestedCompositeFixture } from '../../fixtures/nested-composite-fixture.js';

afterEach(() => vi.restoreAllMocks());
const failure = new Error('内部 Action 业务失败');
const failAction = (f: ReturnType<typeof nestedCompositeFixture>, cause: unknown = failure) =>
  f.execute.mockRejectedValue(cause);

describe('Graph invocation owner 逐层失败传播', () => {
  it.each([false, true])(
    'nested=%s 普通 Action 失败逐层结束，WorkflowRun failed 且不 collect',
    async (nested) => {
      const f = nestedCompositeFixture(nested);
      failAction(f);
      const { run, runner, runs } = await f.runWithRunner();
      await expect(runner.executeStart(run.id)).rejects.toMatchObject({
        stage: 'execute',
        cause: failure,
      });
      expect((await runs.getById(run.id))?.status).toBe('failed');
      expect(runs.markCompleted).not.toHaveBeenCalled();
      const nodes = f.nodeRuns.getRecords();
      const children = f.nodeRuns.getItemRecords();
      expect(nodes).toHaveLength(nested ? 3 : 2);
      expect(children).toHaveLength(nested ? 2 : 1);
      expect(nodes.every((row) => row.status === 'failed' && row.attempt === 1)).toBe(true);
      expect(children.every((row) => row.status === 'failed')).toBe(true);
      const sub = nodes.find((row) => row.nodeId === 'sub')!;
      const child = children.find((row) => row.kind === 'subworkflow')!;
      expect(child.parentNodeRunId).toBe(sub.id);
      expect(nodes.find((row) => row.nodeId === 'format')?.childExecutionId).toBe(child.id);
      expect(f.nodeRuns.markChildExecutionAndParentFailed).toHaveBeenCalledExactlyOnceWith(
        child.id,
        expect.objectContaining({ stage: 'execute' }),
      );
      if (nested) {
        const item = children.find((row) => row.kind === 'iteration_item')!;
        expect(sub.childExecutionId).toBe(item.id);
        expect(item.parentNodeRunId).toBe(nodes.find((row) => row.nodeId === 'iterate')?.id);
        expect(f.nodeRuns.markIterationItemFailed).toHaveBeenCalledExactlyOnceWith(
          item.id,
          expect.objectContaining({ stage: 'execute' }),
        );
      }
    },
  );

  it('SubWorkflow prepare 的 Binding 失败也传播到 Item，不伪造自己的 child', async () => {
    const f = nestedCompositeFixture();
    f.parent.inputs = {};
    await expect(f.compile().invoke(f.initial(), f.config)).rejects.toMatchObject({
      stage: 'resolve_input',
    });
    expect(f.nodeRuns.getRecords()).toMatchObject([
      { nodeId: 'iterate', status: 'failed' },
      { nodeId: 'sub', status: 'failed' },
    ]);
    expect(f.nodeRuns.getItemRecords()).toMatchObject([
      { kind: 'iteration_item', status: 'failed' },
    ]);
  });

  it('并行内部节点产生原生 AggregateError，Item 和两层 Parent 均 failed', async () => {
    const f = nestedCompositeFixture();
    f.child.nodes.push({ ...f.child.nodes[0]!, id: 'right' });
    let ready = 0;
    let release!: () => void;
    const both = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.execute.mockImplementation(async () => {
      if (++ready === 2) release();
      await both;
      throw failure;
    });
    const cause = await f
      .compile()
      .invoke(f.initial(), f.config)
      .catch((error: unknown) => error);
    expect(cause).toBeInstanceOf(AggregateError);
    if (!(cause instanceof AggregateError)) throw new Error('应保留原生 AggregateError');
    expect(cause.errors).toHaveLength(2);
    expect(cause.errors.every((error: unknown) => error instanceof NodeExecutionError)).toBe(true);
    expect(f.nodeRuns.getRecords().every((row) => row.status === 'failed')).toBe(true);
    expect(f.nodeRuns.getItemRecords().every((row) => row.status === 'failed')).toBe(true);
    expect(f.nodeRuns.getRecords()).toHaveLength(4);
    expect(f.nodeRuns.getItemRecords()).toHaveLength(2);
  });

  it.each([new GraphInterrupt(), new ParentCommand(new Command({ goto: END }))])(
    '%s 保持原生控制流，所有 owner 保持 running',
    async (signal) => {
      const f = nestedCompositeFixture();
      failAction(f, signal);
      await f.compile().invoke(f.initial(), f.config);
      expect(f.nodeRuns.getRecords().every((row) => row.status === 'running')).toBe(true);
      expect(f.nodeRuns.getItemRecords().every((row) => row.status === 'running')).toBe(true);
      expect(f.nodeRuns.markFailed).not.toHaveBeenCalled();
      expect(f.nodeRuns.markChildExecutionAndParentFailed).not.toHaveBeenCalled();
      expect(f.nodeRuns.markIterationItemFailed).not.toHaveBeenCalled();
    },
  );

  it('Aggregate 中的控制流不被 Action / Composite / WorkflowRun 标 failed', async () => {
    const f = nestedCompositeFixture();
    const cause = new AggregateError(
      [new NodeExecutionError('probe', 'test.probe', 'execute', failure), new GraphInterrupt()],
      'mixed',
    );
    failAction(f, cause);
    const { run, runner, runs } = await f.runWithRunner();
    await expect(runner.executeStart(run.id)).rejects.toBe(cause);
    expect(runs.markFailed).not.toHaveBeenCalled();
    expect(f.nodeRuns.getRecords().every((row) => row.status === 'running')).toBe(true);
    expect(f.nodeRuns.getItemRecords().every((row) => row.status === 'running')).toBe(true);
  });

  it.each(['node', 'child', 'item'] as const)(
    '%s 记录故障不能伪装成外层业务 failed',
    async (kind) => {
      const f = nestedCompositeFixture();
      failAction(f);
      const recording = new Error('持久化不可用');
      if (kind === 'node') f.nodeRuns.markFailed.mockRejectedValue(recording);
      else if (kind === 'child')
        f.nodeRuns.markChildExecutionAndParentFailed.mockRejectedValue(recording);
      else f.nodeRuns.markIterationItemFailed.mockRejectedValue(recording);
      await expect(f.compile().invoke(f.initial(), f.config)).rejects.toBeInstanceOf(
        kind === 'node' ? NodeRunRecordingError : ChildExecutionRecordingError,
      );
      if (kind === 'item') {
        expect(f.nodeRuns.markIterationItemFailed).toHaveBeenCalledOnce();
        expect(f.nodeRuns.getRecords().find((row) => row.nodeId === 'iterate')?.status).toBe(
          'running',
        );
        expect(
          f.nodeRuns
            .getRecords()
            .filter((row) => row.nodeId !== 'iterate')
            .every((row) => row.status === 'failed'),
        ).toBe(true);
        expect(f.nodeRuns.getItemRecords()).toMatchObject([
          { kind: 'iteration_item', status: 'running' },
          { kind: 'subworkflow', status: 'failed' },
        ]);
        return;
      }
      expect(f.nodeRuns.markIterationItemFailed).not.toHaveBeenCalled();
      expect(
        f.nodeRuns
          .getRecords()
          .filter((row) => row.nodeId !== 'format')
          .every((row) => row.status === 'running'),
      ).toBe(true);
      expect(f.nodeRuns.getItemRecords().every((row) => row.status === 'running')).toBe(true);
    },
  );

  it('一个 Item 内 SubWorkflow 失败，只结束该 Item，保留兄弟成功且不生成部分数组', async () => {
    const f = nestedCompositeFixture();
    const array = { kind: 'array' as const, itemType: StringType };
    f.run.inputs.items = { storage: 'inline', type: array, value: ['A', 'B', 'C'] };
    f.execute.mockImplementation(async (raw: unknown) => {
      const input = z.object({ text: z.string() }).parse(raw);
      if (input.text === 'B') {
        await new Promise((resolve) => setTimeout(resolve, 20));
        throw failure;
      }
      return { text: input.text };
    });
    const graph = f.compile();
    await expect(
      graph.invoke(f.initial(), { ...f.config, maxConcurrency: 3 }),
    ).rejects.toBeInstanceOf(NodeExecutionError);
    const children = f.nodeRuns.getItemRecords();
    const items = children
      .filter((row) => row.kind === 'iteration_item')
      .sort((a, b) => Number(a.metadata.index) - Number(b.metadata.index));
    expect(items.map((row) => row.status)).toEqual(['completed', 'failed', 'completed']);
    const nodes = f.nodeRuns.getRecords();
    for (const item of items) {
      const parent = nodes.find((row) => row.childExecutionId === item.id)!;
      expect(parent.status).toBe(item.status);
      expect(children.find((row) => row.parentNodeRunId === parent.id)?.status).toBe(item.status);
    }
    expect(nodes.find((row) => row.nodeId === 'iterate')).toMatchObject({
      status: 'failed',
      attempt: 1,
    });
    expect(nodes.find((row) => row.nodeId === 'iterate')?.outputs).toBeUndefined();
    expect(children).toHaveLength(6);
    expect(nodes).toHaveLength(7);
  });

  it('已经 failed 的 lifecycle 保留首次摘要；completed lifecycle 拒绝转换', async () => {
    const f = nestedCompositeFixture();
    failAction(f);
    await expect(f.compile().invoke(f.initial(), f.config)).rejects.toBeInstanceOf(
      NodeExecutionError,
    );
    const before = { nodes: f.nodeRuns.getRecords(), children: f.nodeRuns.getItemRecords() };
    for (const child of before.children) {
      const transition =
        child.kind === 'iteration_item'
          ? f.nodeRuns.markIterationItemFailed
          : f.nodeRuns.markChildExecutionAndParentFailed;
      await expect(
        failCompositeExecution(
          child.id,
          new NodeExecutionError('other', 'test.other', 'execute', failure),
          (error) => transition(child.id, error),
        ),
      ).rejects.toBeInstanceOf(NodeExecutionError);
    }
    expect({ nodes: f.nodeRuns.getRecords(), children: f.nodeRuns.getItemRecords() }).toEqual(
      before,
    );
    const success = nestedCompositeFixture();
    await success.compile().invoke(success.initial(), success.config);
    const completed = success.nodeRuns.getItemRecords();
    const child = completed.find((row) => row.kind === 'subworkflow')!;
    await expect(
      failCompositeExecution(
        child.id,
        new NodeExecutionError('late', 'test.late', 'execute', failure),
        (error) => success.nodeRuns.markChildExecutionAndParentFailed(child.id, error),
      ),
    ).rejects.toBeInstanceOf(ChildExecutionRecordingError);
    expect(success.nodeRuns.getItemRecords()).toEqual(completed);
    expect(success.nodeRuns.getRecords().every((row) => row.status === 'completed')).toBe(true);
  });

  it('成功路径仍聚合；原生 interrupt / checkpoint 重建保留父 attempt 与 child IDs', async () => {
    const f = nestedCompositeFixture();
    f.execute.mockImplementation(async (raw: unknown) => {
      const input = z.object({ text: z.string() }).parse(raw);
      interrupt({ kind: 'test_only' });
      return { text: input.text };
    });
    const graph = f.compile();
    await graph.invoke(f.initial(), f.config);
    const owners = f.nodeRuns.getRecords().filter((row) => row.nodeId !== 'format');
    const children = f.nodeRuns.getItemRecords();
    const snapshot = await graph.getState(f.config, { subgraphs: true });
    const pending: string[] = [];
    const visit = (state: StateSnapshot) => {
      for (const task of state.tasks) {
        pending.push(task.name);
        if (task.state && 'tasks' in task.state) visit(task.state);
      }
    };
    visit(snapshot);
    expect(pending).toEqual(expect.arrayContaining(['iterate', 'body', 'sub', 'graph', 'format']));
    const result = workflowStateSchema.parse(
      await f.compile().invoke(new Command({ resume: 'ok' }), f.config),
    );
    expect(result.outputs.iterate?.text).toMatchObject({ value: ['A'] });
    expect(f.nodeRuns.getItemRecords().map((row) => row.id)).toEqual(children.map((row) => row.id));
    expect(f.nodeRuns.getItemRecords().every((row) => row.status === 'completed')).toBe(true);
    expect(f.nodeRuns.getRecords().filter((row) => row.nodeId !== 'format')).toMatchObject(
      owners.map((row) => ({ id: row.id, attempt: 1, status: 'completed' })),
    );
  });
});
