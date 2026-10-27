import 'reflect-metadata';
import { NumberType } from '@dramaflow/contracts';
import {
  DatabaseModule,
  DatabaseService,
  WorkflowCheckpointerModule,
  WorkflowCheckpointerService,
  WorkflowRunRepositories,
  WorkflowVersionRepositories,
} from '@dramaflow/server';
import {
  DefaultWorkflowOutputResolver,
  DefaultWorkflowRunner,
  DefaultWorkflowRunSubmissionService,
  workflowStateSchema,
} from '@dramaflow/workflow';
import { Module, HttpException, type INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { z } from 'zod';

import { persistentTestCompiler } from './persistent-workflow-compiler.js';

const identity = { ownerId: z.string(), projectId: z.uuid() };
const commandSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('start'),
      ...identity,
      workflowId: z.string(),
      workflowVersionId: z.string(),
      seed: z.number(),
    })
    .strict(),
  z
    .object({
      action: z.literal('resume'),
      ...identity,
      workflowRunId: z.string(),
      value: z.number(),
      barrier: z.boolean().optional(),
    })
    .strict(),
  z.object({ action: z.literal('probe') }).strict(),
]);

function receive(): Promise<unknown> {
  return new Promise((resolve) => process.once('message', resolve));
}
function send(message: object): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!process.send) return reject(new Error('测试子进程缺少 IPC'));
    process.send(message, (error) => (error ? reject(error) : resolve()));
  });
}

@Module({ imports: [DatabaseModule, WorkflowCheckpointerModule] })
class PersistentCheckpointTestModule {}

let app: INestApplicationContext | undefined;
let output: object;
try {
  const request = receive();
  await send({ event: 'ipc_ready', pid: process.pid });
  const command = commandSchema.parse(await request);
  app = await NestFactory.createApplicationContext(PersistentCheckpointTestModule, {
    logger: false,
    abortOnError: false,
  });
  const checkpointer = app.get(WorkflowCheckpointerService);
  await checkpointer.ping();
  if (command.action === 'probe') {
    output = { event: 'result', pid: process.pid, ready: true };
  } else {
    const db = app.get(DatabaseService);
    const runs = await new WorkflowRunRepositories(db).forProject(
      command.ownerId,
      command.projectId,
    );
    const versions = await new WorkflowVersionRepositories(db).forProject(
      command.ownerId,
      command.projectId,
    );
    if (command.action === 'resume' && command.barrier) {
      const read = runs.getById.bind(runs);
      let firstRead = true;
      runs.getById = async (id) => {
        const run = await read(id);
        if (firstRead) {
          firstRead = false;
          const continuation = receive();
          await send({ event: 'read', pid: process.pid, status: run?.status });
          z.object({ event: z.literal('continue') })
            .strict()
            .parse(await continuation);
        }
        return run;
      };
    }
    const compiler = persistentTestCompiler(checkpointer, (event) =>
      send({ event: 'invoke', pid: process.pid, ...event }),
    );
    const runner = new DefaultWorkflowRunner(
      versions,
      runs,
      compiler,
      new DefaultWorkflowOutputResolver(),
    );
    const submission = new DefaultWorkflowRunSubmissionService(versions, runs);
    const start = async (input: Parameters<typeof submission.start>[0]) =>
      runner.executeStart((await submission.start(input)).id);
    const result =
      command.action === 'start'
        ? await start({
            projectId: command.projectId,
            workflowId: command.workflowId,
            workflowVersionId: command.workflowVersionId,
            invocationKey: `test-${command.workflowVersionId}`,
            inputs: {
              seed: {
                storage: 'inline',
                type: NumberType,
                value: command.seed,
              },
            },
          })
        : await runner.executeResume({
            workflowRunId: command.workflowRunId,
            value: command.value,
          });
    const run = await runs.getById(result.workflowRunId);
    if (!run) throw new Error('测试运行不存在');
    const version = await versions.getVersion(run.workflowVersionId);
    if (!version) throw new Error('测试版本不存在');
    const graph = await compiler.compile(version.definition, run);
    const snapshot = await graph.getState({
      configurable: { thread_id: result.threadId },
    });
    output = {
      event: 'result',
      pid: process.pid,
      result,
      state: workflowStateSchema.parse(snapshot.values),
      next: snapshot.next,
    };
  }
} catch (error) {
  const response = error instanceof HttpException ? error.getResponse() : undefined;
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? error.code
      : typeof response === 'object' && response !== null && 'code' in response
        ? response.code
        : undefined;
  output = {
    event: 'error',
    pid: process.pid,
    code,
    message: error instanceof Error ? error.message : '测试子进程执行失败',
  };
} finally {
  await app?.close();
}
// 先关闭 Nest / Prisma / 官方 Saver 的连接，父进程随后还会等待此进程真实退出。
await send(output);
process.disconnect();
