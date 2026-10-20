import { NumberType } from '@dramaflow/contracts';
import { Command, END, interrupt, MemorySaver, START, StateGraph } from '@langchain/langgraph';
import { describe, expect, it, vi } from 'vitest';
import {
  WorkflowRunRecordingError,
  WorkflowStateAnnotation,
  type CompiledWorkflow,
} from '../src/index.js';
import { workflowRunnerFixture } from './workflow-runner-fixture.js';

function fixture() {
  const f = workflowRunnerFixture();
  const saver = new MemorySaver();
  const prepared = vi.fn(() => ({
    outputs: { prepared: { result: { storage: 'inline' as const, type: NumberType, value: 7 } } },
  }));
  const between = vi.fn(() => ({
    outputs: { between: { result: { storage: 'inline' as const, type: NumberType, value: 8 } } },
  }));
  const values: unknown[] = [];
  const finish = vi.fn(() => ({
    outputs: { sum: { result: { storage: 'inline' as const, type: NumberType, value: 30 } } },
  }));
  const graphs: CompiledWorkflow[] = [];
  f.compile.mockImplementation(async () => {
    f.order.push('compile');
    // 原生暂停测试图，不借普通 Action 实现 Human Review 或 NodeRun 关联。
    const graph: CompiledWorkflow = new StateGraph(WorkflowStateAnnotation)
      .addNode('prepare', prepared)
      .addNode('wait_one', () => {
        values.push(interrupt<unknown, unknown>('第一次外部输入'));
        return {};
      })
      .addNode('between', between)
      .addNode('wait_two', () => {
        values.push(interrupt<unknown, unknown>('第二次外部输入'));
        return {};
      })
      .addNode('sum', finish)
      .addEdge(START, 'prepare')
      .addEdge('prepare', 'wait_one')
      .addEdge('wait_one', 'between')
      .addEdge('between', 'wait_two')
      .addEdge('wait_two', 'sum')
      .addEdge('sum', END)
      .compile({ checkpointer: saver });
    const invoke = graph.invoke.bind(graph);
    vi.spyOn(graph, 'invoke').mockImplementation(async (input, config) => {
      f.order.push('invoke');
      return invoke(input, config);
    });
    graphs.push(graph);
    return graph;
  });
  return { ...f, graphs, values, prepared, between, finish };
}

describe('WorkflowRunner 从原 checkpoint 恢复', () => {
  it('两次恢复使用原版本 / 原 thread / Command，保留已有 State 与首次开始时间', async () => {
    const f = fixture();
    const start = await f.start(f.input);
    const before = await f.runs.getById(start.workflowRunId);
    f.order.length = 0;
    const firstValue = { approved: true, note: '继续生成' };
    expect(
      await f.runner.executeResume({ workflowRunId: start.workflowRunId, value: firstValue }),
    ).toEqual(start);
    expect(f.order).toEqual(['get_run', 'claim', 'load_version', 'compile', 'invoke', 'waiting']);
    expect(f.values).toEqual([firstValue]);
    expect(f.prepared).toHaveBeenCalledTimes(1);
    expect(f.between).toHaveBeenCalledTimes(1);
    expect(f.finish).not.toHaveBeenCalled();
    expect(f.runs.markCompleted).not.toHaveBeenCalled();
    f.order.length = 0;
    const completed = await f.runner.executeResume({
      workflowRunId: start.workflowRunId,
      value: false,
    });
    expect(completed).toMatchObject({
      workflowRunId: start.workflowRunId,
      threadId: start.threadId,
      status: 'completed',
      outputs: { answer: { value: 30 } },
    });
    expect(f.order).toEqual([
      'get_run',
      'claim',
      'load_version',
      'compile',
      'invoke',
      'resolve_output',
      'completed',
    ]);
    expect(f.values).toEqual([firstValue, false]);
    expect(f.prepared).toHaveBeenCalledTimes(1);
    expect(f.between).toHaveBeenCalledTimes(1);
    expect(f.finish).toHaveBeenCalledTimes(1);
    const saved = await f.runs.getById(start.workflowRunId);
    expect(saved?.startedAt).toBe(before?.startedAt);
    expect(f.runs.create).toHaveBeenCalledTimes(1);
    expect(f.runs.claimPendingForStart).toHaveBeenCalledTimes(1);
    expect(f.runs.markRunning).not.toHaveBeenCalled();
    expect(f.runs.claimWaitingForResume).toHaveBeenCalledTimes(2);
    expect(f.getVersion.mock.calls).toEqual([
      ['version-3'],
      ['version-3'],
      ['version-3'],
      ['version-3'],
    ]);
    for (const graph of f.graphs.slice(1)) {
      expect(graph.invoke).toHaveBeenCalledTimes(1);
      const [command, config] = vi.mocked(graph.invoke).mock.calls[0]!;
      expect(command).toBeInstanceOf(Command);
      expect(command).not.toHaveProperty('run');
      expect(command).not.toHaveProperty('inputs');
      expect(config).toEqual({ configurable: { thread_id: start.threadId } });
    }
    expect(f.nodeRuns.createRunning).not.toHaveBeenCalled();
    expect(f.nodeRuns.updateInputs).not.toHaveBeenCalled();
    expect(f.nodeRuns.markCompleted).not.toHaveBeenCalled();
    expect(f.nodeRuns.markFailed).not.toHaveBeenCalled();
  });

  it.each([false, 0, '', null, { '0123456789abcdef': false }])(
    'resume value %s 不做审批格式校验或隐式转换',
    async (value) => {
      const f = fixture();
      const run = await f.start(f.input);
      const snapshot = await f.graphs[0]!.getState({ configurable: { thread_id: run.threadId } });
      const interruptId = snapshot.tasks[0]!.interrupts[0]!.id!;
      await f.runner.executeResume({ workflowRunId: run.workflowRunId, value });
      expect(f.values).toEqual([value]);
      const command = vi.mocked(f.graphs[1]!.invoke).mock.calls[0]![0];
      expect(command).toMatchObject({ resume: { [interruptId]: value } });
      expect(f.runs.markFailed).not.toHaveBeenCalled();
    },
  );

  it.each(['pending', 'running', 'completed', 'failed', 'cancelled', 'missing'] as const)(
    '%s 不能 resume，不读取版本、不 claim、不执行 Graph',
    async (status) => {
      const f = fixture();
      const run = await f.start(f.input);
      const saved = await f.runs.getById(run.workflowRunId);
      if (!saved) throw new Error('测试运行不存在');
      f.runs.getById.mockResolvedValue(status === 'missing' ? null : { ...saved, status });
      f.getVersion.mockClear();
      f.compile.mockClear();
      await expect(
        f.runner.executeResume({ workflowRunId: run.workflowRunId, value: true }),
      ).rejects.toMatchObject({ code: 'WORKFLOW_RUN_NOT_WAITING' });
      expect(f.runs.claimWaitingForResume).not.toHaveBeenCalled();
      expect(f.getVersion).not.toHaveBeenCalled();
      expect(f.compile).not.toHaveBeenCalled();
      expect(f.runs.markFailed).not.toHaveBeenCalled();
    },
  );

  it('拒绝调用方覆盖版本、thread 或初始 State', async () => {
    const f = fixture();
    for (const extra of [
      { workflowVersionId: 'latest' },
      { threadId: 'new-thread' },
      { initialState: {} },
    ]) {
      const input = { workflowRunId: 'run-1', value: true, ...extra };
      await expect(f.runner.executeResume(input)).rejects.toThrow();
    }
    expect(f.runs.getById).not.toHaveBeenCalled();
  });

  it('claim 竞争失败不会 invoke 或把胜者运行写 failed', async () => {
    const f = fixture();
    const run = await f.start(f.input);
    f.runs.claimWaitingForResume.mockResolvedValue(null);
    await expect(
      f.runner.executeResume({ workflowRunId: run.workflowRunId, value: true }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_RUN_NOT_WAITING' });
    expect(f.graphs).toHaveLength(1);
    expect(f.runs.markFailed).not.toHaveBeenCalled();
  });

  it('原版本读取返回 null 时只由 claim 成功者记录 load_version 失败，不重新开始', async () => {
    const f = fixture();
    const run = await f.start(f.input);
    f.getVersion.mockResolvedValue(null);
    f.compile.mockClear();
    await expect(
      f.runner.executeResume({ workflowRunId: run.workflowRunId, value: true }),
    ).rejects.toThrow('工作流版本不存在或无权访问');
    expect(f.runs.claimWaitingForResume).toHaveBeenCalledExactlyOnceWith(run.workflowRunId);
    expect(f.runs.markFailed).toHaveBeenCalledWith(
      run.workflowRunId,
      expect.objectContaining({ stage: 'load_version' }),
    );
    expect(f.compile).not.toHaveBeenCalled();
    expect(f.runs.create).toHaveBeenCalledTimes(1);
  });

  it.each(['load_version', 'compile'] as const)(
    '恢复准备阶段 %s 失败后只由 claim 成功者记 failed',
    async (stage) => {
      const f = fixture();
      const run = await f.start(f.input);
      const cause = new Error('恢复准备失败');
      if (stage === 'load_version') f.getVersion.mockRejectedValue(cause);
      else f.compile.mockRejectedValue(cause);
      await expect(
        f.runner.executeResume({ workflowRunId: run.workflowRunId, value: true }),
      ).rejects.toBe(cause);
      expect(f.runs.claimWaitingForResume).toHaveBeenCalledExactlyOnceWith(run.workflowRunId);
      expect(f.runs.markFailed).toHaveBeenCalledWith(
        run.workflowRunId,
        expect.objectContaining({ stage }),
      );
      expect(f.values).toEqual([]);
    },
  );

  it.each(['getById', 'claimWaitingForResume', 'markWaiting', 'markCompleted'] as const)(
    '%s 基础设施失败原样上抛，不反向 failed',
    async (method) => {
      const f = fixture();
      const run = await f.start(f.input);
      if (method === 'markCompleted')
        await f.runner.executeResume({ workflowRunId: run.workflowRunId, value: true });
      const cause = new Error('记录服务不可用');
      f.runs[method].mockRejectedValue(cause);
      await expect(
        f.runner.executeResume({ workflowRunId: run.workflowRunId, value: true }),
      ).rejects.toBe(cause);
      expect(f.runs.markFailed).not.toHaveBeenCalled();
    },
  );

  it('恢复中的业务错误记 WorkflowRun failed，记录再失败保留原始双重原因', async () => {
    const f = fixture();
    const run = await f.start(f.input);
    await f.runner.executeResume({ workflowRunId: run.workflowRunId, value: true });
    const cause = new Error('下游失败');
    const recordingError = new Error('失败记录不可用');
    f.finish.mockImplementation(() => {
      throw cause;
    });
    f.runs.markFailed.mockRejectedValue(recordingError);
    const invocation = f.runner.executeResume({ workflowRunId: run.workflowRunId, value: true });
    await expect(invocation).rejects.toBeInstanceOf(WorkflowRunRecordingError);
    await expect(invocation).rejects.toMatchObject({
      name: 'WorkflowRunRecordingError',
      cause,
      recordingError,
    });
    expect(f.runs.markFailed).toHaveBeenCalledWith(
      run.workflowRunId,
      expect.objectContaining({ stage: 'invoke' }),
    );
    expect(f.finish).toHaveBeenCalledTimes(1);
  });

  it.each(['missing', 'finished', 'wrong_version', 'wrong_thread'] as const)(
    '原 checkpoint %s 时不 invoke Command，明确记录检查失败',
    async (mode) => {
      const f = fixture();
      const run = await f.start(f.input);
      const compile = f.compile.getMockImplementation()!;
      f.compile.mockImplementation(async (definition, loadedRun) => {
        const graph = await compile(definition, loadedRun);
        const read = graph.getState.bind(graph);
        vi.spyOn(graph, 'getState').mockImplementation(async (config) => {
          const snapshot = await read(config);
          if (mode === 'missing') return { ...snapshot, values: {}, tasks: [], next: [] };
          if (mode === 'finished') return { ...snapshot, tasks: [], next: [] };
          if (mode === 'wrong_thread')
            return { ...snapshot, config: { configurable: { thread_id: 'other' } } };
          return {
            ...snapshot,
            values: {
              ...snapshot.values,
              run: { ...snapshot.values.run, workflowVersionId: 'latest' },
            },
          };
        });
        return graph;
      });
      await expect(
        f.runner.executeResume({ workflowRunId: run.workflowRunId, value: true }),
      ).rejects.toThrow();
      expect(f.graphs[1]!.invoke).not.toHaveBeenCalled();
      expect(f.runs.markFailed).toHaveBeenCalledWith(
        run.workflowRunId,
        expect.objectContaining({ stage: 'inspect_state' }),
      );
    },
  );
});
