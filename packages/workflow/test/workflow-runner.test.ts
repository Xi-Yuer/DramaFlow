import {
  Command,
  END,
  GraphInterrupt,
  interrupt,
  isInterrupted,
  MemorySaver,
  ParentCommand,
  START,
  StateGraph,
  type StateSnapshot,
} from '@langchain/langgraph';
import { describe, expect, it, vi } from 'vitest';
import {
  WorkflowRunRecordingError,
  WorkflowStateAnnotation,
  type CompiledWorkflow,
} from '../src/index.js';
import { workflowRunnerFixture } from './workflow-runner-fixture.js';

function pausedGraph(staticBreakpoint = false) {
  const builder = new StateGraph(WorkflowStateAnnotation)
    .addNode('native_wait', () => {
      if (!staticBreakpoint) interrupt({ question: '外部输入' });
      return {};
    })
    .addEdge(START, 'native_wait')
    .addEdge('native_wait', END);
  return builder.compile({
    checkpointer: new MemorySaver(),
    ...(staticBreakpoint ? { interruptBefore: ['native_wait'] } : {}),
  });
}

describe('WorkflowRunner 首次启动', () => {
  it('真实 Action 执行顺序、固定版本 / thread、初始 State 和最终输出均正确', async () => {
    const f = workflowRunnerFixture();
    const before = structuredClone(f.input);
    const result = await f.runner.start(f.input);
    expect(result).toEqual({
      workflowRunId: 'run-1',
      threadId: 'thread-7',
      status: 'completed',
      outputs: {
        answer: { storage: 'inline', type: { kind: 'primitive', name: 'number' }, value: 30 },
      },
    });
    expect(f.order).toEqual([
      'load_version',
      'create',
      'compile',
      'running',
      'invoke',
      'execute',
      'resolve_output',
      'completed',
    ]);
    expect(f.getVersion).toHaveBeenCalledExactlyOnceWith('version-3');
    expect(f.graphs[0]!.invoke).toHaveBeenCalledExactlyOnceWith(
      {
        run: {
          projectId: 'project-1',
          workflowId: 'workflow-1',
          workflowVersionId: 'version-3',
          workflowRunId: 'run-1',
        },
        inputs: f.input.inputs,
        outputs: {},
        variables: {},
        execution: {},
      },
      { configurable: { thread_id: 'thread-7' } },
    );
    const snapshot = await f.graphs[0]!.getState({ configurable: { thread_id: 'thread-7' } });
    expect(snapshot.next).toEqual([]);
    expect(snapshot.tasks).toEqual([]);
    expect(snapshot.values.outputs.sum.internal).toBeDefined();
    expect(f.runs.markCompleted).toHaveBeenCalledExactlyOnceWith(
      'run-1',
      result.status === 'completed' ? result.outputs : undefined,
    );
    expect(f.nodeRuns.markCompleted).toHaveBeenCalledWith(
      'node-run-1',
      snapshot.values.outputs.sum,
    );
    expect(f.runs.markFailed).not.toHaveBeenCalled();
    expect(f.input).toEqual(before);
  });

  it('加载后与调用方的版本对象隔离，Compiler 和业务上下文中的定义均冻结', async () => {
    const f = workflowRunnerFixture();
    const create = f.runs.create.getMockImplementation()!;
    f.runs.create.mockImplementation(async (input) => {
      f.node.inputs.b = { type: 'constant', value: 999 };
      return create(input);
    });
    const result = await f.runner.start(f.input);
    const definition = f.compile.mock.calls[0]![0];
    expect(Object.isFrozen(definition.nodes[0]!.inputs)).toBe(true);
    expect(Reflect.set(definition.nodes[0]!.inputs, 'b', { type: 'constant', value: 888 })).toBe(
      false,
    );
    expect(f.resolve.mock.calls[0]![0]).toBe(definition);
    expect(result).toMatchObject({ outputs: { answer: { value: 30 } } });
  });

  it.each(['id', 'projectId', 'workflowId'] as const)(
    '版本 %s 归属不符在创建运行前拒绝',
    async (field) => {
      const f = workflowRunnerFixture();
      f.getVersion.mockResolvedValue({ ...f.version, [field]: 'other' });
      await expect(f.runner.start(f.input)).rejects.toThrow('不匹配');
      expect(f.runs.create).not.toHaveBeenCalled();
      expect(f.compile).not.toHaveBeenCalled();
    },
  );

  it('版本读取失败或调用方试图传入 draft，不创建运行', async () => {
    const f = workflowRunnerFixture();
    const failure = new Error('版本未发布或无权访问');
    f.getVersion.mockRejectedValue(failure);
    await expect(f.runner.start(f.input)).rejects.toBe(failure);
    const withDraft = { ...f.input, definition: f.version.definition };
    await expect(f.runner.start(withDraft)).rejects.toThrow();
    expect(f.getVersion).toHaveBeenCalledTimes(1);
    expect(f.runs.create).not.toHaveBeenCalled();
  });

  it('Node business error 先记录 NodeRun failed，再记录 WorkflowRun failed 并保留原错误', async () => {
    const f = workflowRunnerFixture();
    const cause = new Error('provider-secret-marker');
    f.execute.mockRejectedValue(cause);
    const invocation = f.runner.start(f.input);
    await expect(invocation).rejects.toMatchObject({ stage: 'execute', cause });
    expect(f.nodeRuns.markFailed).toHaveBeenCalledWith(
      'node-run-1',
      expect.objectContaining({ stage: 'execute' }),
    );
    expect(f.runs.markFailed).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({ stage: 'invoke' }),
    );
    expect(f.nodeRuns.markFailed.mock.invocationCallOrder[0]).toBeLessThan(
      f.runs.markFailed.mock.invocationCallOrder[0]!,
    );
    expect(JSON.stringify(f.runs.markFailed.mock.calls)).not.toContain('provider-secret-marker');
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.runs.markCompleted).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    '原生暂停（static=%s）记 waiting，不解析最终结果、不标记 failed',
    async (staticBreakpoint) => {
      const f = workflowRunnerFixture();
      const graph = pausedGraph(staticBreakpoint);
      const invoke = vi.spyOn(graph, 'invoke');
      f.compile.mockResolvedValue(graph);
      const result = await f.runner.start(f.input);
      expect(result).toEqual({ workflowRunId: 'run-1', threadId: 'thread-7', status: 'waiting' });
      const snapshot = await graph.getState({ configurable: { thread_id: 'thread-7' } });
      expect(snapshot.next).toEqual(['native_wait']);
      expect(snapshot.tasks.flatMap((task) => task.interrupts)).toHaveLength(
        staticBreakpoint ? 0 : 1,
      );
      expect(isInterrupted(await invoke.mock.results[0]!.value)).toBe(true);
      expect(f.runs.markWaiting).toHaveBeenCalledExactlyOnceWith('run-1');
      expect(f.runs.markFailed).not.toHaveBeenCalled();
      expect(f.runs.markCompleted).not.toHaveBeenCalled();
      expect(f.resolve).not.toHaveBeenCalled();
      expect(f.execute).not.toHaveBeenCalled();
    },
  );

  it('即使 invoke 适配只返回 State、没有中断标记，也根据原生待执行任务记 waiting', async () => {
    const f = workflowRunnerFixture();
    const graph = pausedGraph(true);
    const compiled: CompiledWorkflow = {
      async invoke(state, config) {
        await graph.invoke(state, config);
        return (await graph.getState(config)).values;
      },
      getState: graph.getState.bind(graph),
    };
    f.compile.mockResolvedValue(compiled);
    expect(await f.runner.start(f.input)).toMatchObject({ status: 'waiting' });
    expect(f.runs.markFailed).not.toHaveBeenCalled();
    expect(f.runs.markCompleted).not.toHaveBeenCalled();
  });

  it('编译失败也保留合法 pending → running → failed 路径，不 invoke 或执行节点', async () => {
    const f = workflowRunnerFixture();
    const cause = new Error('不支持的节点');
    f.compile.mockRejectedValue(cause);
    await expect(f.runner.start(f.input)).rejects.toBe(cause);
    expect(f.order).toEqual(['load_version', 'create', 'running', 'failed']);
    expect(f.runs.markFailed).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({ stage: 'compile' }),
    );
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('缺少声明的最终输出时，NodeRun 可已完成，WorkflowRun 必须失败', async () => {
    const f = workflowRunnerFixture();
    f.version.definition.outputs[0]!.source.outputKey = 'missing';
    await expect(f.runner.start(f.input)).rejects.toMatchObject({
      code: 'WORKFLOW_OUTPUT_MISSING',
    });
    expect(f.nodeRuns.markCompleted).toHaveBeenCalledTimes(1);
    expect(f.runs.markFailed).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({ stage: 'resolve_output' }),
    );
    expect(f.runs.markCompleted).not.toHaveBeenCalled();
  });

  it.each(['create', 'markRunning', 'markCompleted', 'markWaiting'] as const)(
    '%s 持久化故障原样上抛，不反向 markFailed',
    async (method) => {
      const f = workflowRunnerFixture();
      if (method === 'markWaiting') f.compile.mockResolvedValue(pausedGraph());
      const failure = new Error('记录服务不可用');
      f.runs[method].mockRejectedValue(failure);
      await expect(f.runner.start(f.input)).rejects.toBe(failure);
      expect(f.runs.markFailed).not.toHaveBeenCalled();
      if (method === 'markRunning' || method === 'create') expect(f.execute).not.toHaveBeenCalled();
    },
  );

  it('markFailed 再失败保留原执行错误和记录错误，不重试业务', async () => {
    const f = workflowRunnerFixture();
    const cause = new Error('业务失败');
    const recordingError = new Error('数据库故障');
    f.execute.mockRejectedValue(cause);
    f.runs.markFailed.mockRejectedValue(recordingError);
    const invocation = f.runner.start(f.input);
    await expect(invocation).rejects.toBeInstanceOf(WorkflowRunRecordingError);
    await expect(invocation).rejects.toMatchObject({
      workflowRunId: 'run-1',
      cause: { cause },
      recordingError,
      errors: [expect.objectContaining({ cause }), recordingError],
    });
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it.each([new GraphInterrupt(), new ParentCommand(new Command({ goto: 'parent' }))])(
    '原生控制异常 $name 原样穿透',
    async (cause) => {
      const f = workflowRunnerFixture();
      const native = pausedGraph();
      vi.spyOn(native, 'invoke').mockRejectedValue(cause);
      f.compile.mockResolvedValue(native);
      await expect(f.runner.start(f.input)).rejects.toBe(cause);
      expect(f.runs.markFailed).not.toHaveBeenCalled();
      expect(f.runs.markWaiting).not.toHaveBeenCalled();
    },
  );

  it.each(['read_failure', 'wrong_run', 'wrong_thread', 'task_error', 'malformed'] as const)(
    'checkpoint %s 不得被视为 Graph END',
    async (mode) => {
      const f = workflowRunnerFixture();
      const compile = f.compile.getMockImplementation()!;
      f.compile.mockImplementation(async (definition, run) => {
        const graph = await compile(definition, run);
        const read = graph.getState.bind(graph);
        vi.spyOn(graph, 'getState').mockImplementation(async (config): Promise<StateSnapshot> => {
          if (mode === 'read_failure') throw new Error('读取 checkpoint 失败');
          const snapshot = await read(config);
          if (mode === 'wrong_run')
            return {
              ...snapshot,
              values: {
                ...snapshot.values,
                run: { ...snapshot.values.run, workflowVersionId: 'other-version' },
              },
            };
          if (mode === 'wrong_thread')
            return { ...snapshot, config: { configurable: { thread_id: 'other-thread' } } };
          if (mode === 'task_error')
            return {
              ...snapshot,
              tasks: [
                { id: 'bad-task', name: 'sum', interrupts: [], error: new Error('未解决错误') },
              ],
            };
          return { ...snapshot, values: {} };
        });
        return graph;
      });
      await expect(f.runner.start(f.input)).rejects.toThrow();
      expect(f.runs.markFailed).toHaveBeenCalledWith(
        'run-1',
        expect.objectContaining({ stage: 'inspect_state' }),
      );
      expect(f.runs.markCompleted).not.toHaveBeenCalled();
      expect(f.resolve).not.toHaveBeenCalled();
    },
  );
});
