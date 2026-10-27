import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { runtimeValueMapSchema, workflowRunStatusSchema } from '@dramaflow/contracts';
import { DatabaseService, WorkflowCheckpointerService } from '@dramaflow/server';
import { NodeRegistry, workflowStateSchema } from '@dramaflow/workflow';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createWorkflowService, storeRuntimeTestVersion } from './fixtures/workflow-service.js';
import { persistentTestDefinition } from './fixtures/persistent-workflow-compiler.js';

if (
  process.env.DRAMAFLOW_INTEGRATION !== '1' ||
  new URL(process.env.DATABASE_URL ?? 'http://invalid').pathname !== '/dramaflow_test'
)
  throw new Error('Persistent Checkpoint 集成测试仅允许在 DramaFlow 的隔离测试数据库运行');

const eventSchema = z
  .object({
    event: z.enum(['ipc_ready', 'read', 'invoke', 'result', 'error']),
    pid: z.number().int().positive(),
    status: workflowRunStatusSchema.optional(),
    threadId: z.string().optional(),
    resume: z.boolean().optional(),
    ready: z.boolean().optional(),
    code: z.string().optional(),
    message: z.string().optional(),
    result: z
      .object({
        workflowRunId: z.string(),
        threadId: z.string(),
        status: z.enum(['waiting', 'completed']),
        outputs: runtimeValueMapSchema.optional(),
      })
      .strict()
      .optional(),
    state: workflowStateSchema.optional(),
    next: z.array(z.string()).optional(),
  })
  .strict();
type ProcessEvent = z.infer<typeof eventSchema>;
const database = new DatabaseService();
const db = database.client;
const cleanupCheckpointer = new WorkflowCheckpointerService();
const ownerId = randomUUID();
const children = new Set<ChildProcess>();

beforeAll(async () => {
  await cleanupCheckpointer.onModuleInit();
  await db.user.create({
    data: {
      id: ownerId,
      name: '持久恢复测试',
      email: `${ownerId}@example.test`,
    },
  });
});
afterAll(async () => {
  for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
  try {
    const runs = await db.workflowRun.findMany({
      where: { project: { ownerId } },
      select: { threadId: true },
    });
    for (const run of runs) await cleanupCheckpointer.saver.deleteThread(run.threadId);
    await db.user.deleteMany({ where: { id: ownerId } });
  } finally {
    await Promise.all([cleanupCheckpointer.onModuleDestroy(), database.onModuleDestroy()]);
  }
});

function launch(command: object, env: NodeJS.ProcessEnv = process.env) {
  const child = fork(
    fileURLToPath(new URL('./fixtures/persistent-checkpoint-process.ts', import.meta.url)),
    [],
    {
      execArgv: ['--import', import.meta.resolve('tsx')],
      env,
      silent: true,
    },
  );
  children.add(child);
  const events: ProcessEvent[] = [];
  let response: ProcessEvent | undefined;
  let diagnostics = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (data: string) => {
    diagnostics = (diagnostics + data).slice(-3000);
  });
  const done = new Promise<ProcessEvent>((resolve) => {
    child.on('message', (input) => {
      const parsed = eventSchema.safeParse(input);
      if (!parsed.success) {
        response = {
          event: 'error',
          pid: child.pid ?? process.pid,
          code: 'TEST_IPC_INVALID',
          message: '子进程输出不符合测试协议',
        };
        child.kill('SIGKILL');
        return;
      }
      const event = parsed.data;
      events.push(event);
      if (event.event === 'result' || event.event === 'error') response = event;
      if (event.event === 'ipc_ready') child.send(command);
    });
    child.once('error', (error) => {
      resolve({
        event: 'error',
        pid: child.pid ?? process.pid,
        code: 'TEST_PROCESS_FAILED',
        message: error.message,
      });
    });
    child.once('exit', (code) => {
      children.delete(child);
      resolve(
        code === 0 && response
          ? response
          : {
              event: 'error',
              pid: child.pid ?? process.pid,
              code: 'TEST_PROCESS_EXIT_FAILED',
              message: diagnostics || `子进程退出码 ${code}`,
            },
      );
    });
  });
  return { child, events, done };
}

async function fixture() {
  const project = await db.project.create({
    data: { ownerId, name: '持久恢复测试', viewport: {} },
  });
  const workflow = await db.workflow.create({
    data: {
      projectId: project.id,
      name: '原生中断测试',
      draft: z.record(z.string(), z.json()).parse(persistentTestDefinition()),
    },
  });
  const service = createWorkflowService(database, new NodeRegistry());
  const version = await storeRuntimeTestVersion(database, workflow, persistentTestDefinition());
  const identity = {
    ownerId,
    projectId: project.id,
    workflowId: workflow.id,
    workflowVersionId: version.id,
  };
  const a = launch({ action: 'start', ...identity, seed: 10 });
  const stopped = await a.done; // 确认 A 的进程、Nest、Prisma、Saver / pool 已退出。
  expect(stopped).toMatchObject({
    event: 'result',
    result: { status: 'waiting' },
    next: ['native_wait'],
  });
  if (!stopped.result) throw new Error('启动进程没有返回 Run');
  expect(a.child.exitCode).toBe(0);
  expect(
    await db.workflowRun.findUniqueOrThrow({
      where: { id: stopped.result.workflowRunId },
    }),
  ).toMatchObject({
    status: 'waiting',
    workflowVersionId: version.id,
    threadId: stopped.result.threadId,
  });
  return { project, workflow, version, service, stopped, run: stopped.result };
}

describe('PostgreSQL Checkpoint 跨进程恢复', () => {
  it('销毁 A 后用全新 B 恢复原 thread / 版本，保留输入和已完成节点，不读取新草稿版本', async () => {
    const f = await fixture();
    const future = persistentTestDefinition();
    const output = future.outputs[0];
    if (!output) throw new Error('测试定义没有输出');
    output.name = 'futureAnswer';
    await f.service.updateDraft(ownerId, {
      workflowId: f.workflow.id,
      expectedRevision: 1,
      definition: future,
    });
    await storeRuntimeTestVersion(database, { ...f.workflow, revision: 2 }, future);
    const b = launch({
      action: 'resume',
      ownerId,
      projectId: f.project.id,
      workflowRunId: f.run.workflowRunId,
      value: 20,
    });
    const completed = await b.done;
    expect(completed).toMatchObject({
      event: 'result',
      result: {
        ...f.run,
        status: 'completed',
        outputs: { answer: { value: 31 } },
      },
      state: {
        inputs: { seed: { value: 10 } },
        outputs: { prepare: { value: { value: 11 } } },
        run: { workflowVersionId: f.version.id },
      },
      next: [],
    });
    expect(completed.pid).not.toBe(f.stopped.pid);
    expect(b.events.filter((event) => event.event === 'invoke')).toEqual([
      expect.objectContaining({ threadId: f.run.threadId, resume: true }),
    ]);
    expect(
      await db.workflowRun.findUniqueOrThrow({
        where: { id: f.run.workflowRunId },
      }),
    ).toMatchObject({
      status: 'completed',
      workflowVersionId: f.version.id,
      threadId: f.run.threadId,
      outputs: { answer: { value: 31 } },
    });
    expect(await db.workflowRun.count({ where: { projectId: f.project.id } })).toBe(1);
    expect(await db.nodeRun.count({ where: { workflowRunId: f.run.workflowRunId } })).toBe(0);
  });

  it('两个全新进程各自创建 Saver 并读取 waiting，只有一个 claim 成功且进入 graph.invoke', async () => {
    const f = await fixture();
    const command = {
      action: 'resume',
      ownerId,
      projectId: f.project.id,
      workflowRunId: f.run.workflowRunId,
      value: 5,
      barrier: true,
    };
    const a = launch(command);
    const b = launch({ ...command, value: 7 });
    const outcomes = Promise.all([a.done, b.done]);
    try {
      await vi.waitFor(
        () => {
          for (const instance of [a, b]) {
            expect(instance.child.exitCode).toBeNull();
            expect(instance.events.filter((event) => event.event === 'read')).toEqual([
              expect.objectContaining({ status: 'waiting' }),
            ]);
          }
        },
        { timeout: 10000 },
      );
      a.child.send({ event: 'continue' });
      b.child.send({ event: 'continue' });
      const results = await outcomes;
      const winners = results.filter((event) => event.event === 'result');
      expect(winners).toHaveLength(1);
      expect(winners[0]).toMatchObject({
        result: {
          status: 'completed',
          workflowRunId: f.run.workflowRunId,
          threadId: f.run.threadId,
        },
      });
      expect(results.filter((event) => event.event === 'error')).toEqual([
        expect.objectContaining({ code: 'WORKFLOW_RUN_NOT_WAITING' }),
      ]);
      expect([...a.events, ...b.events].filter((event) => event.event === 'invoke')).toEqual([
        expect.objectContaining({ threadId: f.run.threadId, resume: true }),
      ]);
      expect(a.child.pid).not.toBe(b.child.pid);
      expect(
        await db.workflowRun.findUniqueOrThrow({
          where: { id: f.run.workflowRunId },
        }),
      ).toMatchObject({ status: 'completed' });
    } finally {
      for (const instance of [a, b])
        if (instance.child.exitCode === null) instance.child.kill('SIGKILL');
      await outcomes;
    }
  });

  it('Checkpoint 数据库不可用时应用初始化明确失败，不进入 ready 或 Graph', async () => {
    const listener = createServer();
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('未取得测试端口');
    await new Promise<void>((resolve, reject) =>
      listener.close((error) => (error ? reject(error) : resolve())),
    );
    const instance = launch(
      { action: 'probe' },
      {
        ...process.env,
        DATABASE_URL: `postgresql://unavailable:unavailable@127.0.0.1:${address.port}/dramaflow_test`,
      },
    );
    expect(await instance.done).toMatchObject({
      event: 'error',
      code: 'WORKFLOW_CHECKPOINT_UNAVAILABLE',
    });
    expect(
      instance.events.some((event) => event.event === 'invoke' || event.event === 'result'),
    ).toBe(false);
  });
});
