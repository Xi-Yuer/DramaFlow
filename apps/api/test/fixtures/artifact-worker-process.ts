import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { Type } from '@nestjs/common';
import { z } from 'zod';
import { END, interrupt, START, StateGraph } from '@langchain/langgraph';
import {
  ArtifactRuntimeFactory,
  NodeRunRepositories,
  WorkflowCheckpointerService,
  WorkflowExecutionQueue,
  WorkflowRunRepositories,
  WorkflowVersionRepositories,
} from '@dramaflow/server';
import {
  ActionNodeCompilationStrategy,
  createBindingResolver,
  DefaultNodeExecutor,
  DefaultWorkflowOutputResolver,
  DefaultWorkflowRunner,
  NodeRegistry,
  WorkflowStateAnnotation,
  type WorkflowCompiler,
  type WorkflowState,
} from '@dramaflow/workflow';
import { registerArtifactNodes } from './artifact-workflow.js';

if (
  process.env.DRAMAFLOW_INTEGRATION !== '1' ||
  new URL(process.env.DATABASE_URL ?? 'http://invalid').pathname !==
    '/dramaflow_test'
)
  throw new Error('Artifact 子进程仅允许隔离测试库');
const request = new Promise<unknown>((resolve) =>
  process.once('message', resolve),
);
const send = (value: object) =>
  new Promise<void>((resolve, reject) => {
    if (!process.send) return reject(new Error('缺少测试 IPC'));
    process.send(value, (error) => (error ? reject(error) : resolve()));
  });
await send({ event: 'ready' });
const command = z
  .object({
    action: z.enum(['start', 'resume']),
    ownerId: z.string(),
    projectId: z.uuid(),
    runId: z.string(),
  })
  .strict()
  .parse(await request);
const source: unknown = await import(
  new URL('../../../worker/dist/app.module.js', import.meta.url).href
);
const workerModule = z
  .object({
    AppModule: z.custom<Type<unknown>>((value) => typeof value === 'function'),
  })
  .parse(source).AppModule;
const app = await NestFactory.createApplicationContext(workerModule, {
  logger: false,
  abortOnError: false,
});
let response: object;
try {
  const registry = app.get(NodeRegistry);
  registerArtifactNodes(registry);
  // 测试专用原生中断门；两侧复用生产 Action wrapper / Executor / Binding / Codec。
  // 不在 Action 中主动 interrupt，也不引入产品 Human Review。
  const compiler: WorkflowCompiler = {
    async compile(definition, run) {
      const executor = new DefaultNodeExecutor(
        registry,
        createBindingResolver(),
        await app
          .get(ArtifactRuntimeFactory)
          .forRun(command.ownerId, command.projectId, run.id),
        await app
          .get(NodeRunRepositories)
          .forRun(command.ownerId, command.projectId, run.id),
      );
      const graph = new StateGraph<
        typeof WorkflowStateAnnotation.spec,
        WorkflowState,
        Partial<WorkflowState>,
        string
      >(WorkflowStateAnnotation);
      for (const node of definition.nodes)
        new ActionNodeCompilationStrategy().compile({
          node,
          manifest: registry.getAction(node.type, node.typeVersion).manifest,
          executor,
          executionContext: (config) => ({
            workflow: definition,
            runnableConfig: config,
          }),
          addNode: (id, action) => {
            graph.addNode(id, action);
          },
        });
      graph.addNode('native_wait', () => {
        interrupt('测试进程边界');
        return {};
      });
      graph
        .addEdge(START, 'A')
        .addEdge('A', 'native_wait')
        .addEdge('native_wait', 'B')
        .addEdge('B', END);
      return graph.compile({
        checkpointer: app.get(WorkflowCheckpointerService).saver,
      });
    },
  };
  const runner = new DefaultWorkflowRunner(
    await app
      .get(WorkflowVersionRepositories)
      .forProject(command.ownerId, command.projectId),
    await app
      .get(WorkflowRunRepositories)
      .forProject(command.ownerId, command.projectId),
    compiler,
    new DefaultWorkflowOutputResolver(),
  );
  const result =
    command.action === 'start'
      ? await runner.executeStart(command.runId)
      : await runner.executeResume({
          workflowRunId: command.runId,
          value: true,
        });
  response = { event: 'result', pid: process.pid, result };
} catch (error) {
  response = {
    event: 'error',
    message: error instanceof Error ? error.message : '子进程失败',
  };
} finally {
  // 仅此用例的独立队列；本用例直接驱动 Runner，运行记录不创建 Outbox。
  await app.get(WorkflowExecutionQueue).queue.obliterate({ force: true });
  await app.close();
}
await send(response);
process.disconnect();
