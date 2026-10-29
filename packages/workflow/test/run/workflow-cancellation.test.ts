import { describe, expect, it, vi } from 'vitest';
import {
  DefaultWorkflowOutputResolver,
  DefaultWorkflowRunner,
  WorkflowExecutionCancellation,
  WorkflowExecutionCancelled,
  NodeExecutionError,
} from '../../src/index.js';
import { workflowRunnerFixture } from '../fixtures/workflow-runner-fixture.js';

describe('Runner 原生 RunnableConfig 取消接线', () => {
  it('同一 execution signal 传入 invoke，Action 接收原生 task config signal，取消不记录失败', async () => {
    const f = workflowRunnerFixture();
    const run = await f.runs.create(f.input);
    const cancellation = new WorkflowExecutionCancellation(run.id);
    const execute = vi.spyOn(f.executor, 'execute');
    f.execute.mockImplementation(
      async () =>
        new Promise((_resolve, reject) => {
          const signal = execute.mock.calls[0]![1].signal!;
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    );
    const runner = new DefaultWorkflowRunner(
      { getVersion: f.getVersion },
      f.runs,
      { compile: f.compile },
      new DefaultWorkflowOutputResolver(),
      cancellation,
    );
    const pending = runner.executeStart(run.id);
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalledOnce());
    const config = vi.mocked(f.graphs[0]!.invoke).mock.calls[0]![1];
    expect(config.signal).toBe(cancellation.signal);
    const context = execute.mock.calls[0]![1];
    expect(context.signal).toBe(context.runnableConfig!.signal);
    cancellation.request();
    await expect(pending).rejects.toBeInstanceOf(WorkflowExecutionCancelled);
    expect(context.signal!.reason).toBe(cancellation.signal.reason);
    expect(f.runs.markCancelled).toHaveBeenCalledExactlyOnceWith(run.id);
    expect(f.runs.markFailed).not.toHaveBeenCalled();
    expect(f.nodeRuns.markFailed).not.toHaveBeenCalled();
  });
  it('已观察到的 Run 取消优先于尚未收敛的包装错误，已持久化终态由仓储保护', async () => {
    const f = workflowRunnerFixture();
    const run = await f.runs.create(f.input);
    const cancellation = new WorkflowExecutionCancellation(run.id);
    f.compile.mockImplementation(async () => ({
      invoke: async () => {
        cancellation.request();
        throw new NodeExecutionError('sum', 'math.add', 'execute', Error('SDK wrapper'));
      },
      getState: vi.fn(),
    }));
    const runner = new DefaultWorkflowRunner(
      { getVersion: f.getVersion },
      f.runs,
      { compile: f.compile },
      new DefaultWorkflowOutputResolver(),
      cancellation,
    );
    await expect(runner.executeStart(run.id)).rejects.toBeInstanceOf(WorkflowExecutionCancelled);
    expect(f.runs.markFailed).not.toHaveBeenCalled();
    expect(f.runs.markCancelled).toHaveBeenCalledExactlyOnceWith(run.id);
  });
});
