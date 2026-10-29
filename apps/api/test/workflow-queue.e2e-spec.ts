import 'reflect-metadata';
import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { NumberType, type WorkflowDefinition } from '@dramaflow/contracts';
import {
  DatabaseService,
  WorkflowCheckpointerService,
  WorkflowExecutionQueue,
  WorkflowOutboxDispatcher,
  WorkflowRunRepositories,
  WorkflowRunSubmissionFactory,
  WorkflowVersionRepositories,
  workflowExecutionJobId,
  WorkflowCancellationReconciler,
  WorkflowRunQueryService,
} from '@dramaflow/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { storeRuntimeTestVersion } from './fixtures/workflow-service.js';

if (
  process.env.DRAMAFLOW_INTEGRATION !== '1' ||
  new URL(process.env.DATABASE_URL ?? 'http://invalid').pathname !== '/dramaflow_test' ||
  !process.env.WORKFLOW_QUEUE_PREFIX?.startsWith('dramaflow-test-')
)
  throw new Error('Queue 集成测试仅允许独立测试数据库与队列');
const database = new DatabaseService();
const db = database.client;
const queue = new WorkflowExecutionQueue();
const dispatcher = new WorkflowOutboxDispatcher(database, queue);
const runs = new WorkflowRunRepositories(database);
const versions = new WorkflowVersionRepositories(database);
const submissions = new WorkflowRunSubmissionFactory(versions, runs);
const checkpointer = new WorkflowCheckpointerService();
const ownerId = randomUUID();
const children = new Set<ChildProcess>();
const eventSchema = z.object({
  event: z.string(),
  runId: z.string().optional(),
});
function launch(command: object) {
  const child = fork(
    fileURLToPath(new URL('./fixtures/queue-worker-process.ts', import.meta.url)),
    [],
    {
      execArgv: ['--import', import.meta.resolve('tsx')],
      env: {
        ...process.env,
        WORKFLOW_QUEUE_LOCK_DURATION_MS: '1000',
        WORKFLOW_QUEUE_STALLED_INTERVAL_MS: '1000',
      },
      silent: true,
    },
  );
  children.add(child);
  const events: z.infer<typeof eventSchema>[] = [];
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.on('message', (value) => {
    events.push(eventSchema.parse(value));
  });
  child.send(command);
  return {
    child,
    events,
    async wait(event: string) {
      await vi.waitFor(
        () => {
          if (child.exitCode !== null) throw new Error(`队列子进程已退出：${stderr}`);
          expect(events.some((value) => value.event === event)).toBe(true);
        },
        { timeout: 15000 },
      );
      return events.find((value) => value.event === event)!;
    },
    async stop(kill = false) {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      if (kill) child.kill('SIGKILL');
      else child.send({ event: 'close' });
      await exited;
    },
  };
}
async function fixture(native = false, businessFailure = false) {
  const project = await db.project.create({
    data: { ownerId, name: 'Queue 故障验证', viewport: {} },
  });
  const definition: WorkflowDefinition = {
    inputs: [],
    edges: [],
    nodes: businessFailure
      ? [
          {
            id: 'fail',
            type: 'test.queue_failure',
            typeVersion: 1,
            name: '故障测试',
            inputs: {},
            config: {},
            ui: { position: { x: 0, y: 0 } },
          },
        ]
      : native
        ? ['first', 'second'].map((id) => ({
            id,
            type: 'test.queue_wait',
            typeVersion: 1,
            name: '原生测试等待',
            inputs: {},
            config: {},
            ui: { position: { x: 0, y: 0 } },
          }))
        : [],
    outputs: native
      ? [
          {
            name: 'first',
            type: NumberType,
            source: { nodeId: 'first', outputKey: 'value' },
          },
          {
            name: 'second',
            type: NumberType,
            source: { nodeId: 'second', outputKey: 'value' },
          },
        ]
      : [],
  };
  const workflow = await db.workflow.create({
    data: {
      projectId: project.id,
      name: 'Queue',
      draft: z.record(z.string(), z.json()).parse(definition),
    },
  });
  const version = await storeRuntimeTestVersion(database, workflow, definition);
  const input = {
    projectId: project.id,
    workflowId: workflow.id,
    workflowVersionId: version.id,
    invocationKey: randomUUID(),
    inputs: {},
  };
  const submission = await submissions.forProject(ownerId, project.id);
  return { input, submission };
}
async function waitRun(id: string, status: string) {
  await vi.waitFor(
    async () =>
      expect((await db.workflowRun.findUniqueOrThrow({ where: { id } })).status).toBe(status),
    { timeout: 15000 },
  );
}

beforeAll(async () => {
  await checkpointer.onModuleInit();
  await queue.queue.waitUntilReady();
  await queue.queue.pause();
  await db.user.create({
    data: { id: ownerId, name: 'Queue Test', email: `${ownerId}@example.test` },
  });
});
afterAll(async () => {
  for (const child of children)
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  const records = await db.workflowRun.findMany({
    where: { project: { ownerId } },
    select: { threadId: true },
  });
  for (const run of records) await checkpointer.saver.deleteThread(run.threadId);
  await db.user.deleteMany({ where: { id: ownerId } });
  await queue.queue.obliterate({ force: true });
  await queue.onModuleDestroy();
  await checkpointer.onModuleDestroy();
  await database.onModuleDestroy();
});

describe('PostgreSQL Outbox + Redis BullMQ + 独立 Worker 进程', () => {
  it.each(['claimed', 'executed'] as const)(
    '取消 + %s 后 SIGKILL + recovered Job：不 invoke，核查与查询保留 uncertain',
    async (crash) => {
      const f = await fixture(false, crash === 'executed');
      const run = await f.submission.start(f.input);
      await dispatcher.publishStart(run.id);
      const dying = launch({ mode: 'worker', crash });
      await dying.wait('ready');
      await queue.queue.resume();
      await dying.wait(crash === 'executed' ? 'node_execute' : crash);
      await dying.stop(true);
      const repository = await runs.forProject(ownerId, f.input.projectId);
      expect((await repository.requestCancellation(run.id)).outcome).toBe('in_flight');
      const before = await db.nodeRun.findMany({ where: { workflowRunId: run.id } });
      const reconciliation = new WorkflowCancellationReconciler(database, queue, runs);
      const read = new WorkflowRunQueryService(database);
      expect((await read.getRun(ownerId, run.id)).cancellation).toBe('requested');
      await vi.waitFor(
        async () =>
          expect(
            await queue.hasActiveExecutionEvidence({ kind: 'start', workflowRunId: run.id }),
          ).toBe(false),
        { timeout: 5000 },
      );
      await reconciliation.reconcile(run.id);
      expect((await read.getRun(ownerId, run.id)).cancellation).toBe('uncertain');
      const worker = launch({ mode: 'worker' });
      await worker.wait('ready');
      try {
        await vi.waitFor(
          async () =>
            expect(
              await db.workflowExecutionOutbox.findFirstOrThrow({
                where: { workflowRunId: run.id },
              }),
            ).toMatchObject({ status: 'recovery_required' }),
          { timeout: 15000 },
        );
        await reconciliation.reconcile(run.id);
        expect(await read.getRun(ownerId, run.id)).toMatchObject({
          status: 'running',
          cancellation: 'uncertain',
        });
        expect(
          (await read.listRuns(ownerId, f.input.projectId, f.input.workflowId, {})).items[0]!
            .cancellation,
        ).toBe('uncertain');
        expect(await db.nodeRun.findMany({ where: { workflowRunId: run.id } })).toEqual(before);
        expect(
          worker.events.filter((event) => ['node_execute', 'invoke'].includes(event.event)),
        ).toHaveLength(0);
      } finally {
        await worker.stop();
        await queue.queue.pause();
      }
    },
  );
  it('提交事务后、enqueue 前进程死亡：新 Dispatcher / Worker 从 Outbox 完成原 Run', async () => {
    const f = await fixture();
    const submitter = launch({
      mode: 'submitter',
      ownerId,
      projectId: f.input.projectId,
      workflowId: f.input.workflowId,
      workflowVersionId: f.input.workflowVersionId,
    });
    // IPC 严格请求不携带 inputs；执行身份仍由生产 SubmissionFactory 接收。
    const event = await submitter.wait('submitted');
    const id = event.runId!;
    await submitter.stop(true);
    expect(await db.workflowRun.findUniqueOrThrow({ where: { id } })).toMatchObject({
      status: 'pending',
    });
    expect(
      await db.workflowExecutionOutbox.findFirstOrThrow({
        where: { workflowRunId: id },
      }),
    ).toMatchObject({ status: 'pending' });
    expect(
      await queue.queue.getJob(workflowExecutionJobId({ kind: 'start', workflowRunId: id })),
    ).toBeUndefined();
    const worker = launch({ mode: 'worker' });
    await worker.wait('ready');
    await queue.queue.resume();
    try {
      await waitRun(id, 'completed');
    } finally {
      await worker.stop();
      await queue.queue.pause();
    }
    expect(await db.workflowRun.count({ where: { id } })).toBe(1);
  });

  it('enqueue 已成功、published 未提交即 SIGKILL：重投相同 Job ID，只执行一个命令', async () => {
    const f = await fixture();
    const run = await f.submission.start(f.input);
    const publishing = launch({ mode: 'dispatcher', crash: 'enqueued' });
    await publishing.wait('enqueued');
    await publishing.stop(true);
    expect(
      await db.workflowExecutionOutbox.findFirstOrThrow({
        where: { workflowRunId: run.id },
      }),
    ).toMatchObject({ status: 'pending' });
    const jobId = workflowExecutionJobId({
      kind: 'start',
      workflowRunId: run.id,
    });
    const before = await queue.queue.getJob(jobId);
    expect(before).toBeDefined();
    await dispatcher.publishStart(run.id);
    const worker = launch({ mode: 'worker' });
    await worker.wait('ready');
    await queue.queue.resume();
    try {
      await waitRun(run.id, 'completed');
    } finally {
      await worker.stop();
      await queue.queue.pause();
    }
    const after = await queue.queue.getJob(jobId);
    expect(after?.id).toBe(before?.id);
    expect(after?.attemptsMade).toBe(1);
    expect(
      await db.workflowExecutionOutbox.count({
        where: { workflowRunId: run.id },
      }),
    ).toBe(1);
  });

  it.each(['received', 'claimed', 'executed'] as const)(
    'Worker 在 %s 后 SIGKILL，由 BullMQ 重投；不会错误执行第二次',
    async (crash) => {
      const f = await fixture(false, crash === 'executed');
      const run = await f.submission.start(f.input);
      await dispatcher.publishStart(run.id);
      const dying = launch({ mode: 'worker', crash });
      await dying.wait('ready');
      await queue.queue.resume();
      await dying.wait(crash === 'executed' ? 'node_execute' : crash);
      await dying.stop(true);
      const worker = launch({ mode: 'worker' });
      await worker.wait('ready');
      try {
        if (crash === 'received') await waitRun(run.id, 'completed');
        else {
          await vi.waitFor(
            async () =>
              expect(
                await db.workflowExecutionOutbox.findFirstOrThrow({
                  where: { workflowRunId: run.id },
                }),
              ).toMatchObject({ status: 'recovery_required' }),
            { timeout: 15000 },
          );
          expect(await db.workflowRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
            status: 'running',
          });
          const checkpoint = await checkpointer.saver.getTuple({
            configurable: { thread_id: run.threadId },
          });
          if (crash === 'claimed') expect(checkpoint).toBeUndefined();
          else expect(checkpoint).toBeDefined();
        }
        expect(await db.nodeRun.count({ where: { workflowRunId: run.id } })).toBe(
          crash === 'executed' ? 1 : 0,
        );
        if (crash === 'executed') {
          expect(await db.nodeRun.findMany({ where: { workflowRunId: run.id } })).toMatchObject([
            { status: 'running', attempt: 1 },
          ]);
          expect(dying.events.filter((event) => event.event === 'node_execute')).toHaveLength(1);
          expect(worker.events.filter((event) => event.event === 'node_execute')).toHaveLength(0);
        }
        expect(await db.workflowRun.count({ where: { id: run.id } })).toBe(1);
      } finally {
        await worker.stop();
        await queue.queue.pause();
      }
    },
  );

  it('两轮 resume 获得不同 executionId；移除 Redis 旧 Job 后重投旧意图也不能恢复下一轮', async () => {
    const f = await fixture(true);
    const run = await f.submission.start(f.input);
    await dispatcher.publishStart(run.id);
    const worker = launch({ mode: 'worker' });
    await worker.wait('ready');
    await queue.queue.resume();
    try {
      await waitRun(run.id, 'waiting');
      const first = await f.submission.resume({
        workflowRunId: run.id,
        value: 10,
      });
      await expect(f.submission.resume({ workflowRunId: run.id, value: 99 })).rejects.toMatchObject(
        { code: 'WORKFLOW_RESUME_ALREADY_SUBMITTED' },
      );
      await dispatcher.publishExecution(first.executionId);
      await vi.waitFor(
        async () =>
          expect(
            (await db.workflowRun.findUniqueOrThrow({ where: { id: run.id } })).waitingRevision,
          ).toBe(2),
        { timeout: 15000 },
      );
      await vi.waitFor(async () =>
        expect(await (await queue.queue.getJob(workflowExecutionJobId(first)))?.getState()).toBe(
          'completed',
        ),
      );
      await (await queue.queue.getJob(workflowExecutionJobId(first)))?.remove();
      await queue.publish(first);
      await vi.waitFor(async () =>
        expect(await (await queue.queue.getJob(workflowExecutionJobId(first)))?.getState()).toBe(
          'completed',
        ),
      );
      expect((await db.workflowRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe(
        'waiting',
      );
      const second = await f.submission.resume({
        workflowRunId: run.id,
        value: 20,
      });
      expect(second.executionId).not.toBe(first.executionId);
      await dispatcher.publishExecution(second.executionId);
      await waitRun(run.id, 'completed');
      expect(await db.workflowRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
        outputs: { first: { value: 10 }, second: { value: 20 } },
        threadId: run.threadId,
        workflowVersionId: run.workflowVersionId,
      });
      expect(worker.events.filter((event) => event.event === 'invoke')).toHaveLength(3);
    } finally {
      await worker.stop();
      await queue.queue.pause();
    }
  });

  it('claim 前的临时基础设施故障由 Queue 重试，恢复后仅执行原 Run', async () => {
    const f = await fixture();
    const run = await f.submission.start(f.input);
    await dispatcher.publishStart(run.id);
    const worker = launch({ mode: 'worker', temporaryFailure: true });
    await worker.wait('ready');
    await queue.queue.resume();
    try {
      await worker.wait('infra_retry');
      await waitRun(run.id, 'completed');
      await vi.waitFor(async () =>
        expect(
          await (
            await queue.queue.getJob(
              workflowExecutionJobId({ kind: 'start', workflowRunId: run.id }),
            )
          )?.getState(),
        ).toBe('completed'),
      );
      expect(
        (await queue.queue.getJob(workflowExecutionJobId({ kind: 'start', workflowRunId: run.id })))
          ?.attemptsMade,
      ).toBe(2);
      expect(await db.workflowRun.count({ where: { id: run.id } })).toBe(1);
    } finally {
      await worker.stop();
      await queue.queue.pause();
    }
  });

  it('业务节点失败只执行一次：NodeRun / WorkflowRun failed，Queue 不消耗五次业务重试', async () => {
    const f = await fixture(false, true);
    const run = await f.submission.start(f.input);
    await dispatcher.publishStart(run.id);
    const worker = launch({ mode: 'worker' });
    await worker.wait('ready');
    await queue.queue.resume();
    try {
      await waitRun(run.id, 'failed');
      const jobId = workflowExecutionJobId({
        kind: 'start',
        workflowRunId: run.id,
      });
      await vi.waitFor(async () =>
        expect(await (await queue.queue.getJob(jobId))?.getState()).toBe('failed'),
      );
      const queued = await queue.queue.getJob(jobId);
      expect(queued?.opts.attempts).toBe(5);
      expect(queued?.attemptsMade).toBe(1);
      expect(queued?.failedReason).toBe('WORKFLOW_EXECUTION_FAILED');
      expect(JSON.stringify(queued?.stacktrace)).not.toContain('provider-secret-marker');
      expect(await db.nodeRun.findMany({ where: { workflowRunId: run.id } })).toMatchObject([
        { attempt: 1, status: 'failed', error: { stage: 'execute' } },
      ]);
      expect(await db.nodeRun.count({ where: { workflowRunId: run.id } })).toBe(1);
      expect(worker.events.filter((event) => event.event === 'node_execute')).toHaveLength(1);
      expect(
        await db.workflowExecutionOutbox.findFirstOrThrow({
          where: { workflowRunId: run.id },
        }),
      ).toMatchObject({ status: 'failed' });
    } finally {
      await worker.stop();
      await queue.queue.pause();
    }
  });

  it('显式发布缺失的意图不能伪装成已经入队', async () => {
    await expect(dispatcher.publishExecution(randomUUID())).rejects.toMatchObject({ status: 404 });
  });

  it('Redis 无法建立连接时入队有界失败，Outbox 保留且不 claim Run', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('测试端口未就绪');
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    const previous = process.env.REDIS_URL;
    let unavailable: WorkflowExecutionQueue;
    try {
      process.env.REDIS_URL = `redis://127.0.0.1:${address.port}`;
      unavailable = new WorkflowExecutionQueue();
    } finally {
      if (previous === undefined) delete process.env.REDIS_URL;
      else process.env.REDIS_URL = previous;
    }
    const f = await fixture();
    const run = await f.submission.start(f.input);
    try {
      await expect(
        new WorkflowOutboxDispatcher(database, unavailable).publishStart(run.id),
      ).rejects.toMatchObject({ status: 503 });
    } finally {
      await unavailable.onModuleDestroy();
    }
    expect(
      await db.workflowExecutionOutbox.findFirstOrThrow({
        where: { workflowRunId: run.id },
      }),
    ).toMatchObject({ status: 'pending', attempts: 1 });
    expect(await db.workflowRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      status: 'pending',
      startedAt: null,
    });
  });

  it('Outbox 写入失败回滚 Run 且不占用 key；投递故障保留 pending 意图', async () => {
    const f = await fixture();
    const submit = await runs.forProject(ownerId, f.input.projectId);
    // 真正让 Outbox INSERT 失败，证明已插入 Run 也随同一事务回滚。
    const triggerName = `test_outbox_${randomUUID().replaceAll('-', '')}`;
    const projectId = z.uuid().parse(f.input.projectId);
    await db.$executeRawUnsafe(
      `CREATE FUNCTION "${triggerName}"() RETURNS TRIGGER AS $$ BEGIN IF EXISTS (SELECT 1 FROM workflow_run WHERE id = NEW."workflowRunId" AND "projectId" = '${projectId}'::uuid) THEN RAISE EXCEPTION 'outbox insert failure'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql`,
    );
    await db.$executeRawUnsafe(
      `CREATE TRIGGER "${triggerName}" BEFORE INSERT ON workflow_execution_outbox FOR EACH ROW EXECUTE FUNCTION "${triggerName}"()`,
    );
    try {
      await expect(submit.createWithExecution(f.input)).rejects.toThrow();
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER "${triggerName}" ON workflow_execution_outbox`);
      await db.$executeRawUnsafe(`DROP FUNCTION "${triggerName}"()`);
    }
    expect(await db.workflowRun.count({ where: { projectId: f.input.projectId } })).toBe(0);
    const run = await f.submission.start(f.input);
    expect(run.invocationKey).toBe(f.input.invocationKey);
    expect(await db.workflowRun.count({ where: { workflowId: f.input.workflowId } })).toBe(1);
    const failing = vi.spyOn(queue, 'publish').mockRejectedValue(new Error('redis-secret-marker'));
    try {
      await expect(dispatcher.publishStart(run.id)).rejects.toMatchObject({
        status: 503,
      });
    } finally {
      failing.mockRestore();
    }
    expect(
      await db.workflowExecutionOutbox.findFirstOrThrow({
        where: { workflowRunId: run.id },
      }),
    ).toMatchObject({ status: 'pending', attempts: 1 });
    expect(await db.workflowRun.findUniqueOrThrow({ where: { id: run.id } })).toMatchObject({
      status: 'pending',
      startedAt: null,
    });
  });
});
