import 'reflect-metadata';
import { z } from 'zod';
import { NestFactory } from '@nestjs/core';
import type { Type } from '@nestjs/common';
import {
  DatabaseService,
  WorkflowSubmissionModule,
  WorkflowQueueModule,
  WorkflowOutboxDispatcher,
  WorkflowExecutionQueue,
  WorkflowExecutionService,
  WorkflowRuntimeFactory,
  WorkflowRunRepositories,
  WorkflowVersionRepositories,
  WorkflowRunSubmissionFactory,
  WorkflowCheckpointerService,
} from '@dramaflow/server';
import {
  DefaultWorkflowRunner,
  DefaultWorkflowOutputResolver,
  WorkflowStateAnnotation,
  NodeRegistry,
} from '@dramaflow/workflow';
import { NumberType } from '@dramaflow/contracts';
import { END, interrupt, START, StateGraph } from '@langchain/langgraph';
import { Module } from '@nestjs/common';

const send = (message: object) =>
  new Promise<void>((resolve, reject) =>
    process.send?.(message, (error) => (error ? reject(error) : resolve())),
  );
const forever = () => new Promise<never>(() => {});
const input: unknown = await new Promise((resolve) =>
  process.once('message', resolve),
);
const request = z
  .object({
    mode: z.enum(['worker', 'dispatcher', 'submitter']),
    crash: z.enum(['received', 'claimed', 'enqueued', 'executed']).optional(),
    temporaryFailure: z.boolean().optional(),
    ownerId: z.string().optional(),
    projectId: z.string().optional(),
    workflowId: z.string().optional(),
    workflowVersionId: z.string().optional(),
  })
  .strict()
  .parse(input);
if (
  process.env.DRAMAFLOW_INTEGRATION !== '1' ||
  new URL(process.env.DATABASE_URL ?? 'http://invalid').pathname !==
    '/dramaflow_test' ||
  !process.env.WORKFLOW_QUEUE_PREFIX?.startsWith('dramaflow-test-')
)
  throw new Error('仅允许隔离测试库 / 队列');
@Module({ imports: [WorkflowSubmissionModule, WorkflowQueueModule] })
class SubmissionProcessModule {}
const source: unknown =
  request.mode === 'worker'
    ? await import(
        new URL('../../../worker/dist/app.module.js', import.meta.url).href
      )
    : { AppModule: SubmissionProcessModule };
// fixture 位于 api/test/fixtures；Worker dist 相对 api 根的同级 worker。
const token = z
  .object({
    AppModule: z.custom<Type<unknown>>((value) => typeof value === 'function'),
  })
  .parse(source).AppModule;
const app = await NestFactory.createApplicationContext(token, {
  logger: false,
  abortOnError: false,
});
try {
  if (request.mode === 'submitter') {
    const command = z
      .object({
        ownerId: z.string(),
        projectId: z.string(),
        workflowId: z.string(),
        workflowVersionId: z.string(),
      })
      .parse(request);
    const submission = await app
      .get(WorkflowRunSubmissionFactory)
      .forProject(command.ownerId, command.projectId);
    const run = await submission.start({
      projectId: command.projectId,
      workflowId: command.workflowId,
      workflowVersionId: command.workflowVersionId,
      inputs: {},
    });
    await send({ event: 'submitted', runId: run.id });
  } else if (request.mode === 'dispatcher') {
    if (request.crash === 'enqueued') {
      const queue = app.get(WorkflowExecutionQueue);
      const publish = queue.publish.bind(queue);
      queue.publish = async (job) => {
        await publish(job);
        await send({ event: 'enqueued', runId: job.workflowRunId });
        await forever();
      };
    }
    await app.get(WorkflowOutboxDispatcher).dispatchNext();
    await send({ event: 'dispatched' });
  } else {
    // 仅该测试子进程注册故障节点；正式源码 Registry 仍为空。
    app.get(NodeRegistry).register({
      manifest: {
        type: 'test.queue_failure',
        version: 1,
        executionKind: 'action',
        metadata: { name: '故障测试', category: 'data' },
        inputs: [],
        outputs: [],
        config: [],
      },
      inputSchema: z.object({}).strict(),
      configSchema: z.object({}).strict(),
      outputSchema: z.object({}).strict(),
      async execute() {
        await send({ event: 'node_execute' });
        if (request.crash === 'executed') return forever();
        throw new Error('provider-secret-marker');
      },
    });
    if (request.temporaryFailure) {
      const execution = app.get(WorkflowExecutionService);
      const execute = execution.execute.bind(execution);
      let first = true;
      execution.execute = async (job) => {
        if (first) {
          first = false;
          await send({ event: 'infra_retry' });
          throw Object.assign(new Error('database-secret-marker'), {
            code: 'P1001',
          });
        }
        return execute(job);
      };
    }
    const db = app.get(DatabaseService);
    const factory = app.get(WorkflowRuntimeFactory);
    const assemble = factory.forProject.bind(factory);
    factory.forProject = async (owner, project, executionId) => {
      const executions = await app
        .get(WorkflowRunRepositories)
        .forProject(owner, project, executionId);
      if (request.crash === 'claimed') {
        const claim = executions.claimPendingForStart.bind(executions);
        executions.claimPendingForStart = async (id) => {
          const run = await claim(id);
          if (run) {
            await send({ event: 'claimed', runId: id });
            await forever();
          }
          return run;
        };
      }
      const version = await db.client.workflowVersion.findFirst({
        where: { workflow: { projectId: project } },
      });
      const native =
        version &&
        z
          .object({ nodes: z.array(z.object({ type: z.string() })) })
          .parse(version.definition)
          .nodes.some((node) => node.type === 'test.queue_wait');
      if (!native && request.crash !== 'claimed')
        return assemble(owner, project, executionId);
      const compiler = {
        async compile() {
          const graph = new StateGraph(WorkflowStateAnnotation)
            .addNode('first', () => {
              const value = z
                .number()
                .parse(interrupt<unknown, unknown>('第一次等待'));
              return {
                outputs: {
                  first: {
                    value: {
                      storage: 'inline' as const,
                      type: NumberType,
                      value,
                    },
                  },
                },
              };
            })
            .addNode('second', () => {
              const value = z
                .number()
                .parse(interrupt<unknown, unknown>('第二次等待'));
              return {
                outputs: {
                  second: {
                    value: {
                      storage: 'inline' as const,
                      type: NumberType,
                      value,
                    },
                  },
                },
              };
            })
            .addEdge(START, 'first')
            .addEdge('first', 'second')
            .addEdge('second', END)
            .compile({
              checkpointer: app.get(WorkflowCheckpointerService).saver,
            });
          return {
            async invoke(...args: Parameters<typeof graph.invoke>) {
              await send({
                event: 'invoke',
                runId: args[1]?.configurable?.thread_id,
              });
              return graph.invoke(...args);
            },
            getState: graph.getState.bind(graph),
          };
        },
      };
      return new DefaultWorkflowRunner(
        await app.get(WorkflowVersionRepositories).forProject(owner, project),
        executions,
        compiler,
        new DefaultWorkflowOutputResolver(),
      );
    };
    if (request.crash === 'received') {
      const execution = app.get(WorkflowExecutionService);
      execution.execute = async (job) => {
        await send({ event: 'received', runId: job.workflowRunId });
        return forever();
      };
    }
    await send({ event: 'ready' });
  }
  await new Promise<void>((resolve) => process.once('message', resolve));
} finally {
  await app.close();
}
