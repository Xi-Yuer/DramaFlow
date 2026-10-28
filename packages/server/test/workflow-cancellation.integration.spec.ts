import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DefaultWorkflowRunner, DefaultWorkflowOutputResolver } from '@dramaflow/workflow';
import { DatabaseService } from '../src/database/database.service.js';
import { WorkflowRunRepositories } from '../src/workflow/run/repository/workflow-run-repository.js';
import { WorkflowRunQueryService } from '../src/workflow/run/query/workflow-run-query.service.js';
import { WorkflowExecutionService } from '../src/workflow/runtime/workflow-execution.service.js';
import type { WorkflowRuntimeFactory } from '../src/workflow/runtime/workflow-runtime.factory.js';
import { WorkflowOutboxDispatcher } from '../src/workflow/queue/workflow-outbox-dispatcher.js';
import {
  WorkflowExecutionQueue,
  workflowExecutionJobId,
} from '../src/workflow/queue/workflow-execution-queue.js';
import { WorkflowExecutionConsumer } from '../src/workflow/queue/workflow-execution-consumer.js';
import { WorkflowHumanReviewService } from '../src/workflow/human-review/human-review.service.js';
import type { WorkflowCheckpointerService } from '../src/checkpoint/workflow-checkpointer.service.js';

const enabled = process.env.DRAMAFLOW_INTEGRATION === '1';
if (enabled) {
  const url = new URL(process.env.DATABASE_URL ?? '');
  if (!['localhost', '127.0.0.1'].includes(url.hostname) || url.pathname !== '/dramaflow_test')
    throw new Error('Cancellation 集成测试仅允许本机 dramaflow_test');
}

describe.skipIf(!enabled)('Cancellation 持久化闸门 PostgreSQL', () => {
  const db = enabled ? new DatabaseService() : undefined;
  const owner = randomUUID(),
    outsider = randomUUID(),
    project = randomUUID();
  const client = () => db!.client;
  const repositories = () => new WorkflowRunRepositories(db!);
  beforeAll(async () => {
    for (const id of [owner, outsider])
      await client().user.create({ data: { id, name: '取消测试', email: `${id}@example.test` } });
    await client().project.create({
      data: { id: project, ownerId: owner, name: '取消测试', viewport: {} },
    });
  });
  afterAll(async () => {
    if (db) {
      await client().user.deleteMany({ where: { id: { in: [owner, outsider] } } });
      await db.onModuleDestroy();
    }
  });
  async function fixture(waiting = false) {
    const repository = await repositories().forProject(owner, project);
    const { run } = await repository.createWithExecution({
      projectId: project,
      workflowId: 'cancellation-test',
      workflowVersionId: 'version',
      invocationKey: randomUUID(),
      inputs: {},
    });
    let job:
      | { kind: 'start'; workflowRunId: string }
      | Awaited<ReturnType<typeof repository.createResumeExecution>> = {
      kind: 'start',
      workflowRunId: run.id,
    };
    if (waiting) {
      await repository.claimPendingForStart(run.id);
      await repository.markWaiting(run.id);
      await client().workflowExecutionOutbox.updateMany({
        where: { workflowRunId: run.id },
        data: { status: 'completed', completedAt: new Date() },
      });
      job = await repository.createResumeExecution({ workflowRunId: run.id, value: 'resume' });
    }
    const intent = await client().workflowExecutionOutbox.findFirstOrThrow({
      where: { workflowRunId: run.id, kind: job.kind },
    });
    const workerRepository = await repositories().forProject(owner, project, intent.id);
    return { repository, workerRepository, run, job, intent };
  }
  const read = (id: string) => client().workflowRun.findUniqueOrThrow({ where: { id } });
  const intentStatus = async (id: string) =>
    (await client().workflowExecutionOutbox.findUniqueOrThrow({ where: { id } })).status;

  it('pending 取消原子结算未执行命令，幂等保留首次时间和空 startedAt，公开查询显示请求事实', async () => {
    const f = await fixture();
    const first = await f.repository.requestCancellation(f.run.id);
    const again = await f.repository.requestCancellation(f.run.id);
    expect(first.outcome).toBe('cancelled');
    expect(again).toEqual(first);
    expect(first.run).toMatchObject({
      status: 'cancelled',
      cancellationRequestedAt: expect.any(String),
    });
    expect(first.run).not.toHaveProperty('startedAt');
    expect((await read(f.run.id)).startedAt).toBeNull();
    expect(await intentStatus(f.intent.id)).toBe('cancelled');
    expect(await f.workerRepository.claimPendingForStart(f.run.id)).toBeNull();
    await expect(f.repository.markRunning(f.run.id)).rejects.toThrow();
    expect(await new WorkflowRunQueryService(db!).getRun(owner, f.run.id)).toMatchObject({
      cancellationRequestedAt: first.run.cancellationRequestedAt,
      status: 'cancelled',
    });
  });

  it.each(['completed', 'failed'] as const)(
    '%s 不被取消覆盖，终态请求不新增时间',
    async (status) => {
      const f = await fixture();
      await f.workerRepository.claimPendingForStart(f.run.id);
      if (status === 'completed') await f.repository.markCompleted(f.run.id, {});
      else await f.repository.markFailed(f.run.id, { stage: 'execute', message: '业务失败' });
      const before = await read(f.run.id);
      expect((await f.repository.requestCancellation(f.run.id)).outcome).toBe('terminal');
      expect(await read(f.run.id)).toEqual(before);
    },
  );

  it.each([false, true])(
    'start/resume %s claim 先成功则只记录请求；在途可完成',
    async (waiting) => {
      const f = await fixture(waiting);
      const claimed = waiting
        ? await f.workerRepository.claimWaitingForResume(f.run.id)
        : await f.workerRepository.claimPendingForStart(f.run.id);
      const result = await f.repository.requestCancellation(f.run.id);
      expect(result).toMatchObject({
        outcome: 'in_flight',
        run: { status: 'running', startedAt: claimed!.startedAt },
      });
      expect(await f.repository.requestCancellation(f.run.id)).toEqual(result);
      expect(await intentStatus(f.intent.id)).toBe('executing');
      await f.repository.markCompleted(f.run.id, {});
      expect(await read(f.run.id)).toMatchObject({
        status: 'completed',
        cancellationRequestedAt: new Date(result.run.cancellationRequestedAt!),
      });
    },
  );

  it('在途请求后仍可失败或进入 waiting，但不能再恢复执行', async () => {
    for (const status of ['failed', 'waiting'] as const) {
      const f = await fixture();
      await f.workerRepository.claimPendingForStart(f.run.id);
      const request = await f.repository.requestCancellation(f.run.id);
      if (status === 'failed')
        await f.repository.markFailed(f.run.id, { stage: 'execute', message: '真实业务失败' });
      else await f.repository.markWaiting(f.run.id);
      expect(await read(f.run.id)).toMatchObject({
        status,
        cancellationRequestedAt: new Date(request.run.cancellationRequestedAt!),
      });
      if (status === 'waiting') {
        expect(await f.repository.claimWaitingForResume(f.run.id)).toBeNull();
        await expect(
          f.repository.createResumeExecution({ workflowRunId: f.run.id, value: 'late' }),
        ).rejects.toThrow();
      }
    }
  });

  it.each([false, true])(
    '取消与真实 %s claim 并发只有一个胜者，取消获胜后不能再次 claim',
    async (waiting) => {
      for (let i = 0; i < 8; i++) {
        const f = await fixture(waiting);
        const claim = () =>
          waiting
            ? f.workerRepository.claimWaitingForResume(f.run.id)
            : f.workerRepository.claimPendingForStart(f.run.id);
        const [cancel, claimed] = await Promise.all([
          f.repository.requestCancellation(f.run.id),
          claim(),
        ]);
        expect(cancel.outcome).toBe(claimed ? 'in_flight' : 'cancelled');
        expect((await read(f.run.id)).status).toBe(claimed ? 'running' : 'cancelled');
        expect(await intentStatus(f.intent.id)).toBe(claimed ? 'executing' : 'cancelled');
        expect(await claim()).toBeNull();
      }
    },
  );

  it.each([false, true])(
    '已排队的 %s 命令不能越过取消闸门；Dispatcher 不再投递，Worker 正常结算',
    async (waiting) => {
      const f = await fixture(waiting);
      const publish = vi.fn(async () => undefined);
      const dispatcher = new WorkflowOutboxDispatcher(db!, {
        publish,
      } as unknown as WorkflowExecutionQueue);
      await dispatcher.publishExecution(f.intent.id);
      expect(publish).toHaveBeenCalledExactlyOnceWith(f.job);
      await f.repository.requestCancellation(f.run.id);
      await dispatcher.publishExecution(f.intent.id);
      expect(publish).toHaveBeenCalledTimes(1);
      const forProject = vi.fn();
      const service = new WorkflowExecutionService(db!, {
        forProject,
      } as unknown as WorkflowRuntimeFactory);
      // 模拟 BullMQ 已保存且稍后送达的真实命令，Job 是否存在不参与判定。
      expect(await service.execute(f.job)).toMatchObject({ status: 'execution_cancelled' });
      expect(forProject).not.toHaveBeenCalled();
      expect(await intentStatus(f.intent.id)).toBe('cancelled');
      expect((await read(f.run.id)).status).toBe('cancelled');
      if (waiting)
        await expect(
          f.repository.createResumeExecution({ workflowRunId: f.run.id, value: 'late' }),
        ).rejects.toThrow();
    },
  );

  it.each([false, true])(
    'Worker 已读取意图、Runner %s claim 前取消获胜，不 invoke / failed / recovery_required',
    async (waiting) => {
      const f = await fixture(waiting);
      const method = waiting ? 'claimWaitingForResume' : 'claimPendingForStart';
      const claim = f.workerRepository[method].bind(f.workerRepository);
      vi.spyOn(f.workerRepository, method).mockImplementation(async (id) => {
        await f.repository.requestCancellation(id);
        return claim(id);
      });
      const compile = vi.fn(),
        getVersion = vi.fn();
      const runner = new DefaultWorkflowRunner(
        { getVersion },
        f.workerRepository,
        { compile },
        new DefaultWorkflowOutputResolver(),
      );
      const service = new WorkflowExecutionService(db!, {
        forProject: async () => runner,
      } as unknown as WorkflowRuntimeFactory);
      expect(await service.execute(f.job)).toMatchObject({ status: 'execution_cancelled' });
      expect(compile).not.toHaveBeenCalled();
      expect(getVersion).not.toHaveBeenCalled();
      expect(await intentStatus(f.intent.id)).toBe('cancelled');
      expect((await read(f.run.id)).error).toBeNull();
    },
  );

  it('真实 BullMQ Job 已存在，Worker 消费时仍被数据库取消事实阻止且 Job 正常完成', async () => {
    const redis = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379');
    if (!['localhost', '127.0.0.1'].includes(redis.hostname)) throw new Error('仅允许本机 Redis');
    const previousPrefix = process.env.WORKFLOW_QUEUE_PREFIX;
    process.env.WORKFLOW_QUEUE_PREFIX = `dramaflow-test-cancellation-${randomUUID()}`;
    const queue = new WorkflowExecutionQueue();
    let consumer: WorkflowExecutionConsumer | undefined;
    try {
      const f = await fixture();
      await new WorkflowOutboxDispatcher(db!, queue).publishExecution(f.intent.id);
      const job = await queue.queue.getJob(workflowExecutionJobId(f.job));
      expect(job).toBeDefined();
      await f.repository.requestCancellation(f.run.id);
      // 不删除排队 Job；让正式 Consumer 真正取得它。
      const forProject = vi.fn();
      const service = new WorkflowExecutionService(db!, {
        forProject,
      } as unknown as WorkflowRuntimeFactory);
      const execute = vi.spyOn(service, 'execute');
      consumer = new WorkflowExecutionConsumer(service, db!);
      consumer.onApplicationBootstrap();
      await vi.waitFor(async () => expect(await job!.getState()).toBe('completed'), {
        timeout: 5000,
      });
      expect(execute).toHaveBeenCalledExactlyOnceWith(f.job);
      expect(forProject).not.toHaveBeenCalled();
      expect(await intentStatus(f.intent.id)).toBe('cancelled');
      expect((await read(f.run.id)).startedAt).toBeNull();
    } finally {
      await consumer?.onModuleDestroy();
      await queue.queue.obliterate({ force: true });
      await queue.onModuleDestroy();
      if (previousPrefix === undefined) delete process.env.WORKFLOW_QUEUE_PREFIX;
      else process.env.WORKFLOW_QUEUE_PREFIX = previousPrefix;
    }
  });

  it('数据库自身拒绝取消请求后 claim、抹掉请求时间和终态更新；Dispatcher 补结算未投递命令', async () => {
    const f = await fixture();
    // 请求字段本身即可关闭闸门，不依赖 repository 是否已结算 Outbox。
    await client().workflowRun.update({
      where: { id: f.run.id },
      data: { cancellationRequestedAt: new Date() },
    });
    expect(await f.workerRepository.claimPendingForStart(f.run.id)).toBeNull();
    await expect(
      client().workflowRun.update({
        where: { id: f.run.id },
        data: { status: 'running', startedAt: new Date() },
      }),
    ).rejects.toThrow();
    await expect(
      client().workflowRun.update({
        where: { id: f.run.id },
        data: { cancellationRequestedAt: null },
      }),
    ).rejects.toThrow();
    const publish = vi.fn();
    await new WorkflowOutboxDispatcher(db!, {
      publish,
    } as unknown as WorkflowExecutionQueue).publishExecution(f.intent.id);
    expect(publish).not.toHaveBeenCalled();
    expect(await intentStatus(f.intent.id)).toBe('cancelled');
    await f.repository.requestCancellation(f.run.id);
    await expect(
      client().workflowRun.update({
        where: { id: f.run.id },
        data: { status: 'running', startedAt: new Date() },
      }),
    ).rejects.toThrow();
  });

  it('waiting 带请求拒绝 Human Review 提交与 pending 查询，不读取 checkpoint', async () => {
    const f = await fixture(true);
    await client().workflowRun.update({
      where: { id: f.run.id },
      data: { cancellationRequestedAt: new Date() },
    });
    const checkpoints = {} as WorkflowCheckpointerService;
    const reviews = new WorkflowHumanReviewService(db!, checkpoints);
    expect(await reviews.pending(owner, f.run.id)).toEqual({ items: [] });
    await expect(
      reviews.submit(owner, f.run.id, {
        interruptId: 'opaque',
        expectedWaitingRevision: 1,
        value: { action: 'approve' },
      }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_RUN_NOT_WAITING' });
  });

  it('请求仍校验 owner/project，已有 Repository 不得绕过后来变化的权限', async () => {
    const f = await fixture();
    await expect(repositories().forProject(outsider, project)).rejects.toMatchObject({
      status: 404,
    });
    await client().project.update({ where: { id: project }, data: { ownerId: outsider } });
    try {
      await expect(f.repository.requestCancellation(f.run.id)).rejects.toMatchObject({
        status: 404,
      });
    } finally {
      await client().project.update({ where: { id: project }, data: { ownerId: owner } });
    }
    expect((await read(f.run.id)).cancellationRequestedAt).toBeNull();
  });
});
