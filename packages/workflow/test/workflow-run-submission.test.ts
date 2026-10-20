import { END, interrupt, START, StateGraph } from '@langchain/langgraph';
import { describe, expect, it, vi } from 'vitest';
import { DefaultWorkflowRunner, WorkflowStateAnnotation } from '../src/index.js';
import { workflowRunnerFixture } from './workflow-runner-fixture.js';

describe('Workflow 提交 / 执行边界', () => {
  it('提交只创建 pending；新执行实例按 ID 读取原输入、版本与 thread，不再创建 Run', async () => {
    const f = workflowRunnerFixture();
    const run = await f.submission.start(f.input);
    expect(run.status).toBe('pending');
    expect(run.startedAt).toBeUndefined();
    expect(f.compile).not.toHaveBeenCalled();
    expect(f.executorFactory).not.toHaveBeenCalled();
    expect(f.runs.claimPendingForStart).not.toHaveBeenCalled();
    expect(
      await f.checkpointer.getTuple({ configurable: { thread_id: run.threadId } }),
    ).toBeUndefined();
    f.input.inputs.a.value = 999;
    const other = new DefaultWorkflowRunner(
      { getVersion: f.getVersion },
      f.runs,
      { compile: f.compile },
      { resolve: f.resolve },
    );
    expect(await other.executeStart(run.id)).toMatchObject({
      workflowRunId: run.id,
      threadId: run.threadId,
      status: 'completed',
      outputs: { answer: { value: 30 } },
    });
    expect(f.runs.create).toHaveBeenCalledTimes(1);
    expect(f.runs.markRunning).not.toHaveBeenCalled();
    expect(f.getVersion).toHaveBeenCalledTimes(2);
  });

  it('并发首次执行只允许一个 claim 和 invoke；重复 Job 不重跑或写坏胜者状态', async () => {
    const f = workflowRunnerFixture();
    const run = await f.submission.start(f.input);
    const outcomes = await Promise.allSettled([
      f.runner.executeStart(run.id),
      f.runner.executeStart(run.id),
    ]);
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'WORKFLOW_RUN_NOT_PENDING' },
    });
    expect(f.compile).toHaveBeenCalledTimes(1);
    expect(f.execute).toHaveBeenCalledTimes(1);
    await expect(f.runner.executeStart(run.id)).rejects.toMatchObject({
      code: 'WORKFLOW_RUN_NOT_PENDING',
    });
    expect(f.runs.markFailed).not.toHaveBeenCalled();
    expect((await f.runs.getById(run.id))?.status).toBe('completed');
    expect(f.runs.create).toHaveBeenCalledTimes(1);
  });

  it('恢复提交保存意图并保留 waiting；实际执行者才 claim，重投同一意图只 invoke 一次', async () => {
    const f = workflowRunnerFixture();
    const resumed = vi.fn();
    f.version.definition.outputs = [];
    f.compile.mockImplementation(async () =>
      new StateGraph(WorkflowStateAnnotation)
        .addNode('native_wait', () => {
          resumed(interrupt('外部输入'));
          return {};
        })
        .addEdge(START, 'native_wait')
        .addEdge('native_wait', END)
        .compile({ checkpointer: f.checkpointer }),
    );
    const pending = await f.submission.start(f.input);
    await f.runner.executeStart(pending.id);
    f.compile.mockClear();
    const job = await f.submission.resume({ workflowRunId: pending.id, value: false });
    const second = structuredClone(job);
    expect(job).toMatchObject({
      kind: 'resume',
      workflowRunId: pending.id,
      executionId: 'execution-1',
      value: false,
    });
    expect((await f.runs.getById(pending.id))?.status).toBe('waiting');
    expect(f.runs.claimWaitingForResume).not.toHaveBeenCalled();
    expect(f.compile).not.toHaveBeenCalled();
    expect(resumed).not.toHaveBeenCalled();
    const outcomes = await Promise.allSettled([
      f.runner.executeResume({ workflowRunId: job.workflowRunId, value: job.value }),
      f.runner.executeResume({ workflowRunId: second.workflowRunId, value: second.value }),
    ]);
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'WORKFLOW_RUN_NOT_WAITING' },
    });
    expect(resumed).toHaveBeenCalledExactlyOnceWith(false);
    expect(f.compile).toHaveBeenCalledTimes(1);
    expect(f.runs.create).toHaveBeenCalledTimes(1);
    expect(f.runs.markFailed).not.toHaveBeenCalled();
  });

  it('执行时版本读取失败保留已提交 Run，并记录 load_version failed', async () => {
    const f = workflowRunnerFixture();
    const run = await f.submission.start(f.input);
    f.getVersion.mockResolvedValue(null);
    await expect(f.runner.executeStart(run.id)).rejects.toThrow('工作流版本不存在');
    expect(f.runs.markFailed).toHaveBeenCalledWith(
      run.id,
      expect.objectContaining({ stage: 'load_version' }),
    );
    expect(f.compile).not.toHaveBeenCalled();
  });
});
