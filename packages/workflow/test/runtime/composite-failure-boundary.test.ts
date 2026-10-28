import { describe, expect, it, vi } from 'vitest';
import { Command, END, GraphInterrupt, ParentCommand } from '@langchain/langgraph';
import {
  ChildExecutionRecordingError,
  NodeExecutionError,
  NodeRunRecordingError,
  classifyGraphExecutionFailure,
  failCompositeExecution,
  failNodeRun,
  toNodeRunError,
} from '../../src/index.js';

const business = () =>
  new NodeExecutionError('action', 'test.action', 'execute', new Error('cause'));
const controls = () => [new GraphInterrupt(), new ParentCommand(new Command({ goto: END }))];

describe('Composite failure 分类与生命周期边界', () => {
  it('普通执行错误只转换当前 owner，原样抛出且不序列化 cause', async () => {
    const cause = business();
    const transition = vi.fn().mockResolvedValue(undefined);
    await expect(failCompositeExecution('child', cause, transition)).rejects.toBe(cause);
    expect(transition).toHaveBeenCalledExactlyOnceWith(toNodeRunError(cause));
    expect(transition.mock.calls[0]![0]).not.toHaveProperty('cause');
  });

  it('嵌套 Aggregate 保留原对象和 cause，重复 Error 引用不被误判为循环', async () => {
    const first = business();
    const second = business();
    const cause = new AggregateError([new AggregateError([first, second]), first], 'parallel');
    const transition = vi.fn().mockResolvedValue(undefined);
    await expect(failCompositeExecution('child', cause, transition)).rejects.toBe(cause);
    expect(transition).toHaveBeenCalledExactlyOnceWith(toNodeRunError(first));
    expect(cause.errors[0].errors).toEqual([first, second]);
  });

  it.each(controls())(
    '%s 控制流及其 Aggregate 原样穿透，Action / owner 均不记 failed',
    async (signal) => {
      const markFailed = vi.fn();
      const transition = vi.fn();
      for (const cause of [signal, new AggregateError([business(), signal], 'mixed control')]) {
        expect(classifyGraphExecutionFailure(cause).kind).toBe('control');
        await expect(failCompositeExecution('child', cause, transition)).rejects.toBe(cause);
        await expect(
          failNodeRun(
            { markFailed },
            {
              id: 'action',
              type: 'test.action',
              typeVersion: 1,
              name: 'Action',
              inputs: {},
              config: {},
              ui: { position: { x: 0, y: 0 } },
            },
            'node-run',
            'execute',
            cause,
          ),
        ).rejects.toBe(cause);
      }
      expect(markFailed).not.toHaveBeenCalled();
      expect(transition).not.toHaveBeenCalled();
    },
  );

  it.each(['node', 'child', 'mixed'] as const)('%s 记录故障不触发外层业务终态', async (kind) => {
    const execution = business();
    const recording = new Error('database unavailable');
    const node = new NodeRunRecordingError('node-run', execution, recording);
    const child = new ChildExecutionRecordingError('inner-child', execution, recording);
    const cause =
      kind === 'node' ? node : kind === 'child' ? child : new AggregateError([execution, child]);
    const transition = vi.fn();
    expect(classifyGraphExecutionFailure(cause).kind).toBe('infrastructure');
    await expect(failCompositeExecution('outer-child', cause, transition)).rejects.toBe(cause);
    expect(transition).not.toHaveBeenCalled();
  });

  it('边界记录失败保留完整 Aggregate 与仓储错误，外层不能伪装成功 failed', async () => {
    const cause = new AggregateError([business(), business()], 'parallel');
    const recording = new Error('repository unavailable');
    const transition = vi.fn().mockRejectedValue(recording);
    const failure = await failCompositeExecution('inner', cause, transition).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ChildExecutionRecordingError);
    expect(failure).toMatchObject({
      childExecutionId: 'inner',
      executionError: cause,
      recordingError: recording,
    });
    const outer = vi.fn();
    await expect(failCompositeExecution('outer', failure, outer)).rejects.toBe(failure);
    expect(outer).not.toHaveBeenCalled();
  });

  it('未知仓储 throw、混合未知成员和循环 Aggregate 均不冒充普通业务失败', async () => {
    const cycle = new AggregateError([], 'cycle');
    cycle.errors.push(cycle);
    for (const cause of [
      new Error('repository'),
      new AggregateError([business(), new Error('unknown')]),
      cycle,
    ]) {
      const transition = vi.fn();
      expect(classifyGraphExecutionFailure(cause).kind).toBe('unknown');
      await expect(failCompositeExecution('child', cause, transition)).rejects.toBe(cause);
      expect(transition).not.toHaveBeenCalled();
    }
  });
});
