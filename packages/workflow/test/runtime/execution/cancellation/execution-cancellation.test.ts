import { describe, expect, it, vi } from 'vitest';
import { GraphInterrupt, ParentCommand, Command, END } from '@langchain/langgraph';
import {
  WorkflowExecutionCancellation,
  WorkflowExecutionCancelled,
  CancellationRecordingError,
  classifyGraphExecutionFailure,
  failCompositeExecution,
  failNodeRun,
  NodeExecutionError,
} from '../../../../src/index.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('执行取消控制与 owner 写入', () => {
  it('显式控制类型与同名普通错误、timeout、业务失败不同，Aggregate 保持分类', async () => {
    const cancelled = new WorkflowExecutionCancelled('run');
    expect(classifyGraphExecutionFailure(cancelled).kind).toBe('cancellation');
    expect(classifyGraphExecutionFailure(new Error('WORKFLOW_EXECUTION_CANCELLED')).kind).toBe(
      'unknown',
    );
    expect(classifyGraphExecutionFailure(new DOMException('timeout', 'TimeoutError')).kind).toBe(
      'unknown',
    );
    const business = new NodeExecutionError('n', 'test.action', 'execute', Error('network'));
    expect(classifyGraphExecutionFailure(business).kind).toBe('execution');
    expect(classifyGraphExecutionFailure(new AggregateError([business, cancelled])).kind).toBe(
      'cancellation',
    );
    for (const control of [new GraphInterrupt(), new ParentCommand(new Command({ goto: END }))])
      expect(classifyGraphExecutionFailure(control).kind).toBe('control');
    const failed = vi.fn(),
      transition = vi.fn();
    await expect(
      failNodeRun(
        { markFailed: failed },
        {
          id: 'n',
          type: 'test.action',
          typeVersion: 1,
          name: '测试',
          inputs: {},
          config: {},
          ui: { position: { x: 0, y: 0 } },
        },
        'node',
        'execute',
        cancelled,
      ),
    ).rejects.toBe(cancelled);
    await expect(failCompositeExecution('child', cancelled, transition)).rejects.toBe(cancelled);
    expect(failed).not.toHaveBeenCalled();
    expect(transition).not.toHaveBeenCalled();
  });
  it('只结束已注册的 owner；completed sibling 解除注册，重复请求不重复写入', async () => {
    const scope = new WorkflowExecutionCancellation('run');
    const completed = vi.fn(),
      running = vi.fn();
    await scope.own(
      async () => ({ id: 'done' }),
      () => ({ key: 'done', cancel: completed }),
    );
    scope.release('done');
    await scope.own(
      async () => ({ id: 'active' }),
      () => ({ key: 'active', cancel: running }),
    );
    scope.request();
    scope.request();
    await scope.settle();
    expect(completed).not.toHaveBeenCalled();
    expect(running).toHaveBeenCalledTimes(1);
    expect(scope.signal.reason).toBeInstanceOf(WorkflowExecutionCancelled);
    const start = vi.fn();
    await expect(scope.own(start, () => ({ key: 'not-started', cancel: vi.fn() }))).rejects.toBe(
      scope.signal.reason,
    );
    expect(start).not.toHaveBeenCalled();
  });
  it('abort 期间的 create 提交必须先注册并结束；不等待底层业务 Promise', async () => {
    const scope = new WorkflowExecutionCancellation('run');
    const pending = deferred<{ id: string }>();
    const cancel = vi.fn(async () => undefined);
    const create = scope.own(
      () => pending.promise,
      () => ({ key: 'late', cancel }),
    );
    const rejected = expect(create).rejects.toBeInstanceOf(WorkflowExecutionCancelled);
    scope.request();
    let settled = false;
    const drain = scope.settle().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    pending.resolve({ id: 'late' });
    await rejected;
    await drain;
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it('迟到的业务失败遇到已取消记录时，仓储取消控制不被包成 infrastructure', async () => {
    const cancelled = new WorkflowExecutionCancelled('run');
    const business = new NodeExecutionError('n', 'test.action', 'execute', Error('late'));
    await expect(
      failCompositeExecution('child', business, async () => {
        throw cancelled;
      }),
    ).rejects.toBe(cancelled);
    await expect(
      failNodeRun(
        {
          markFailed: async () => {
            throw cancelled;
          },
        },
        {
          id: 'n',
          type: 'test.action',
          typeVersion: 1,
          name: '测试',
          inputs: {},
          config: {},
          ui: { position: { x: 0, y: 0 } },
        },
        'node',
        'execute',
        business,
      ),
    ).rejects.toBe(cancelled);
  });
  it('invocation 已返回后关闭作用域，不能用迟到通知取消下一等待周期', async () => {
    const scope = new WorkflowExecutionCancellation('run');
    scope.finish();
    scope.request();
    expect(scope.signal.aborted).toBe(false);
    const create = vi.fn();
    await expect(scope.own(create, () => ({ key: 'late', cancel: vi.fn() }))).rejects.toThrow(
      '该执行调用已结束',
    );
    expect(create).not.toHaveBeenCalled();
  });
  it('create 提交结果不明时不假定没有记录，取消收尾保留 infrastructure 故障', async () => {
    const scope = new WorkflowExecutionCancellation('run');
    const error = Error('commit acknowledgement unavailable');
    const create = scope.own(
      async () => {
        await Promise.resolve();
        throw error;
      },
      () => ({ key: 'unknown', cancel: vi.fn() }),
    );
    const rejected = expect(create).rejects.toBe(error);
    scope.request();
    await rejected;
    await expect(scope.settle()).rejects.toBeInstanceOf(CancellationRecordingError);
  });
  it('持久化失败不伪装取消成功，原 cause 保留且分类为 infrastructure', async () => {
    const scope = new WorkflowExecutionCancellation('run');
    const error = Error('database unavailable');
    await scope.own(
      async () => ({ id: 'node' }),
      () => ({
        key: 'node',
        cancel: async () => {
          throw error;
        },
      }),
    );
    scope.request();
    const failure = await scope.settle().catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(CancellationRecordingError);
    expect((failure as AggregateError).errors).toEqual([error]);
    expect(classifyGraphExecutionFailure(failure).kind).toBe('infrastructure');
  });
});
