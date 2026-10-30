import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MemorySaver, type BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import pg from 'pg';
import { z } from 'zod';
import { StringType, type WorkflowDefinition } from '@dramaflow/contracts';
import { PluginRegistry, type CapabilityInvocationContext } from '@dramaflow/plugins';
import {
  DefaultWorkflowOutputResolver,
  NodeRegistry,
  WorkflowExecutionCancelled,
  WorkflowExecutionCancellation,
  type NodeExecutionContext,
} from '@dramaflow/workflow';
import { nestedCompositeFixture } from '../../../../../workflow/test/fixtures/nested-composite-fixture.js';
import { iterationSubworkflowFixture } from '../../../../../workflow/test/fixtures/iteration-subworkflow-fixture.js';
import { DatabaseService } from '../../../../src/database/database.service.js';
import { WorkflowRunRepositories } from '../../../../src/workflow/run/repository/workflow-run-repository.js';
import { WorkflowVersionRepositories } from '../../../../src/workflow/run/repository/workflow-version-repository.js';
import { NodeRunRepositories } from '../../../../src/workflow/runtime/execution/node-run-repository.js';
import { WorkflowRuntimeFactory } from '../../../../src/workflow/runtime/workflow-runtime.factory.js';
import { WorkflowExecutionService } from '../../../../src/workflow/runtime/workflow-execution.service.js';
import { WorkflowCancellationReconciler } from '../../../../src/workflow/queue/workflow-cancellation-reconciler.js';
import { WorkflowCapabilitiesFactory } from '../../../../src/models/workflow-capabilities.factory.js';
import type { ArtifactRuntimeFactory } from '../../../../src/artifacts/artifact-runtime.factory.js';
import type { WorkflowCheckpointerService } from '../../../../src/checkpoint/workflow-checkpointer.service.js';
import {
  WorkflowExecutionQueue,
  workflowExecutionJobId,
} from '../../../../src/workflow/queue/workflow-execution-queue.js';
import { WorkflowExecutionConsumer } from '../../../../src/workflow/queue/workflow-execution-consumer.js';

const enabled = process.env.DRAMAFLOW_INTEGRATION === '1';
if (enabled) {
  const url = new URL(process.env.DATABASE_URL ?? '');
  if (!['localhost', '127.0.0.1'].includes(url.hostname) || url.pathname !== '/dramaflow_test')
    throw Error('仅允许本机 dramaflow_test');
}
const json = (input: unknown) => z.record(z.string(), z.json()).parse(input);
const schema = z.object({ text: z.string(), index: z.number() });

describe.skipIf(!enabled)(
  'Worker → 原生 LangGraph → Node → Capability → Plugin cooperative cancellation',
  () => {
    const database = enabled ? new DatabaseService() : undefined;
    const db = () => database!.client;
    const owner = randomUUID(),
      project = randomUUID();
    beforeAll(async () => {
      await db().user.create({
        data: { id: owner, name: '协作取消测试', email: `${owner}@example.test` },
      });
      await db().project.create({
        data: { id: project, ownerId: owner, name: '取消测试' },
      });
    });
    afterAll(async () => {
      if (database) {
        await db().user.deleteMany({ where: { id: owner } });
        await database.onModuleDestroy();
      }
    });

    async function fixture(
      form: 'root' | 'sub' | 'iteration',
      mode: 'cooperative' | 'late' | 'beforeCapability' | 'failure' | 'timeout' = 'cooperative',
      saver: BaseCheckpointSaver = new MemorySaver(),
    ) {
      const project = randomUUID();
      await db().project.create({
        data: { id: project, ownerId: owner, name: '协作取消 fixture' },
      });
      const f =
        form === 'iteration' ? iterationSubworkflowFixture() : nestedCompositeFixture(false);
      const definition: WorkflowDefinition = structuredClone(
        form === 'root' ? f.child : f.definition,
      );
      if (form === 'root') {
        const after = structuredClone(definition.nodes[0]!);
        after.id = 'after';
        definition.nodes.push(after);
        definition.edges.push({
          id: 'control-after',
          kind: 'control',
          source: { nodeId: definition.nodes[0]!.id },
          target: { nodeId: 'after' },
        });
      }
      const actionSignals: AbortSignal[] = [],
        pluginSignals: AbortSignal[] = [];
      const late: (() => void)[] = [];
      const invoke = vi.fn(async (raw: unknown, context: CapabilityInvocationContext) => {
        const input = schema.parse(raw);
        expect(context.signal).toBeDefined();
        pluginSignals.push(context.signal!);
        if (input.text === 'alpha') return { text: `alpha-${input.index}` };
        if (mode === 'failure') throw Error('ordinary network failure');
        if (mode === 'timeout') throw new DOMException('provider deadline', 'TimeoutError');
        if (mode === 'late')
          return new Promise<{ text: string }>((resolve) => {
            late.push(() => resolve({ text: 'late-output' }));
          });
        return new Promise<never>((_resolve, reject) => {
          context.signal!.throwIfAborted();
          context.signal!.addEventListener('abort', () => reject(context.signal!.reason), {
            once: true,
          });
        });
      });
      const plugins = new PluginRegistry([
        {
          id: 'test.cancellation',
          version: 1,
          configSchema: z.object({}),
          credentialsSchema: z.object({}),
          capabilities: [
            {
              type: 'text.generate',
              inputSchema: schema,
              outputSchema: z.object({ text: z.string() }),
              modelSettingsSchema: z.object({}),
              invoke,
            },
          ],
        },
      ]);
      const invoker = {
        invoke: async (_type: string, input: unknown, options?: { signal?: AbortSignal }) =>
          plugins.invoke({
            pluginId: 'test.cancellation',
            pluginVersion: 1,
            capability: 'text.generate',
            model: 'deterministic',
            configuration: {},
            credentials: {},
            settings: {},
            input,
            signal: options?.signal,
          }),
      };
      f.execute.mockImplementation(async (input, _config, context: NodeExecutionContext) => {
        expect(context.signal).toBe(context.runnableConfig?.signal);
        actionSignals.push(context.signal!);
        if (mode === 'beforeCapability')
          await new Promise<void>((resolve) => {
            late.push(resolve);
          });
        // 不手动传 signal：验证 DefaultNodeExecutor 为 Capability 绑定同一 execution signal。
        return context.capabilities!.invoke('text.generate', input);
      });
      const workflow = await db().workflow.create({
        data: { projectId: project, name: '取消 fixture', draft: json(definition) },
      });
      const version = await db().workflowVersion.create({
        data: {
          workflowId: workflow.id,
          version: 1,
          sourceRevision: 1,
          definition: json(definition),
        },
      });
      const runs = await new WorkflowRunRepositories(database!).forProject(owner, project);
      const { run } = await runs.createWithExecution({
        projectId: project,
        workflowId: workflow.id,
        workflowVersionId: version.id,
        invocationKey: randomUUID(),
        inputs:
          form === 'iteration'
            ? f.run.inputs
            : { text: { storage: 'inline', type: StringType, value: 'beta' } },
      });
      const runtime = new WorkflowRuntimeFactory(
        new WorkflowVersionRepositories(database!),
        new WorkflowRunRepositories(database!),
        new NodeRunRepositories(database!),
        new NodeRegistry(f.registry.listManifests().map((m) => f.registry.get(m.type, m.version))),
        { forRun: async () => f.codec } as unknown as ArtifactRuntimeFactory,
        { forRun: () => invoker } as unknown as WorkflowCapabilitiesFactory,
        new DefaultWorkflowOutputResolver(),
        { saver } as unknown as WorkflowCheckpointerService,
      );
      const service = new WorkflowExecutionService(database!, runtime);
      const job = { kind: 'start' as const, workflowRunId: run.id };
      const facts = async () => ({
        run: await db().workflowRun.findUniqueOrThrow({ where: { id: run.id } }),
        nodes: await db().nodeRun.findMany({
          where: { workflowRunId: run.id },
          include: { occurrence: true },
        }),
        children: await db().childExecution.findMany({ where: { workflowRunId: run.id } }),
        intent: await db().workflowExecutionOutbox.findFirstOrThrow({
          where: { workflowRunId: run.id },
        }),
      });
      return {
        runs,
        run,
        runtime,
        service,
        job,
        facts,
        actionSignals,
        pluginSignals,
        late,
        invoke,
        saver,
      };
    }

    it.each(['root', 'sub', 'iteration'] as const)(
      '%s 长运行被 DB 意图取消，直属 owner 全部结束，completed sibling 保留',
      async (form) => {
        const f = await fixture(form);
        const execution = f.service.execute(f.job);
        await vi.waitFor(async () => {
          expect(f.pluginSignals.length).toBe(form === 'iteration' ? 3 : 1);
          if (form === 'iteration')
            expect((await f.facts()).children.filter((c) => c.status === 'completed')).toHaveLength(
              2,
            );
        });
        const before = await f.facts();
        expect((await f.runs.requestCancellation(f.run.id)).outcome).toBe('in_flight');
        expect(await execution).toMatchObject({ status: 'execution_cancelled' });
        const after = await f.facts();
        expect(after.run.status).toBe('cancelled');
        expect(after.run.error).toBeNull();
        expect(after.intent.status).toBe('cancelled');
        expect(after.nodes.every((n) => n.status === 'cancelled' || n.status === 'completed')).toBe(
          true,
        );
        expect(
          after.children.every((c) => c.status === 'cancelled' || c.status === 'completed'),
        ).toBe(true);
        for (const old of before.nodes.filter((n) => n.status === 'completed'))
          expect(after.nodes.find((n) => n.id === old.id)).toEqual(old);
        for (const old of before.children.filter((c) => c.status === 'completed'))
          expect(after.children.find((c) => c.id === old.id)).toEqual(old);
        expect(after.nodes.some((n) => n.nodeId === 'after')).toBe(false);
        expect(
          await f.saver.getTuple({ configurable: { thread_id: f.run.threadId } }),
        ).toBeDefined();
        for (const child of after.children)
          expect(after.nodes.some((n) => n.id === child.parentNodeRunId)).toBe(true);
        for (const node of after.nodes.filter((n) => n.childExecutionId))
          expect(after.children.some((c) => c.id === node.childExecutionId)).toBe(true);
        expect(f.actionSignals.every((s, i) => s === f.pluginSignals[i])).toBe(true);
        expect(
          f.pluginSignals
            .filter((_s, i) => schema.parse(f.invoke.mock.calls[i]![0]).text !== 'alpha')
            .every((s) => s.aborted),
        ).toBe(true);
        expect(f.pluginSignals.find((s) => s.aborted)!.reason).toBeInstanceOf(
          WorkflowExecutionCancelled,
        );
        // 重建 Worker Service / 丢失内存 signal 不能越过持久化 gate，也不重新创建 attempt。
        await new WorkflowExecutionService(database!, f.runtime).execute(f.job);
        expect((await f.facts()).nodes).toEqual(after.nodes);
        expect(f.invoke).toHaveBeenCalledTimes(form === 'iteration' ? 3 : 1);
      },
    );

    it('graph.invoke 先退出后不协作 Promise 迟到完成，不能覆盖 cancelled 或写出 after 节点', async () => {
      const f = await fixture('sub', 'late');
      const execution = f.service.execute(f.job);
      await vi.waitFor(() => expect(f.late).toHaveLength(1));
      await f.runs.requestCancellation(f.run.id);
      expect(await execution).toMatchObject({ status: 'execution_cancelled' });
      const before = await f.facts();
      f.late[0]!();
      await new Promise((resolve) => setTimeout(resolve, 30));
      const after = await f.facts();
      expect(after).toEqual(before);
      for (const node of after.nodes) {
        if (node.status === 'cancelled')
          await expect(
            db().nodeRun.update({
              where: { id: node.id },
              data: { status: 'completed', outputs: {} },
            }),
          ).rejects.toThrow();
      }
      for (const child of after.children)
        await expect(
          db().childExecution.update({ where: { id: child.id }, data: { status: 'completed' } }),
        ).rejects.toThrow();
    });

    it.each(['failure', 'timeout'] as const)(
      '%s 不是 Run cancellation，仍为真实 failed',
      async (mode) => {
        const f = await fixture('root', mode);
        await expect(f.service.execute(f.job)).rejects.toMatchObject({
          code: 'WORKFLOW_EXECUTION_FAILED',
        });
        const after = await f.facts();
        expect(after.run).toMatchObject({ status: 'failed', cancellationRequestedAt: null });
        expect(after.nodes[0]!.status).toBe('failed');
        expect(after.intent.status).toBe('failed');
        expect(f.pluginSignals[0]!.reason).not.toBeInstanceOf(WorkflowExecutionCancelled);
      },
    );

    it('不协作 Action 迟到发起 Capability 调用时，在 dispatch 前被阻止', async () => {
      const f = await fixture('root', 'beforeCapability');
      const execution = f.service.execute(f.job);
      await vi.waitFor(() => expect(f.late).toHaveLength(1));
      expect(f.invoke).not.toHaveBeenCalled();
      await f.runs.requestCancellation(f.run.id);
      expect(await execution).toMatchObject({ status: 'execution_cancelled' });
      const before = await f.facts();
      f.late[0]!();
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(f.invoke).not.toHaveBeenCalled();
      expect(await f.facts()).toEqual(before);
    });

    it('核查先进入 recovery_required 后，原 owner 的 cooperative 确认仍可正常收敛', async () => {
      const f = await fixture('sub');
      const execution = f.service.execute(f.job);
      await vi.waitFor(() => expect(f.pluginSignals).toHaveLength(1));
      let ready!: () => void, release!: () => void;
      const cancelling = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const original = WorkflowExecutionCancellation.prototype.settle;
      const recording = vi
        .spyOn(WorkflowExecutionCancellation.prototype, 'settle')
        .mockImplementation(async function (this: WorkflowExecutionCancellation) {
          ready();
          await released;
          return original.call(this);
        });
      try {
        await f.runs.requestCancellation(f.run.id);
        await cancelling;
        const probe = {
          hasActiveExecutionEvidence: async () => false,
        } as unknown as WorkflowExecutionQueue;
        await new WorkflowCancellationReconciler(
          database!,
          probe,
          new WorkflowRunRepositories(database!),
        ).reconcile(f.run.id);
        expect((await f.facts()).intent.status).toBe('recovery_required');
        expect((await f.facts()).run.status).toBe('running');
        release();
        expect(await execution).toMatchObject({ status: 'execution_cancelled' });
        const facts = await f.facts();
        expect(facts.run.status).toBe('cancelled');
        expect(facts.intent.status).toBe('cancelled');
        expect(facts.nodes.every((node) => node.status === 'cancelled')).toBe(true);
        expect(facts.children.every((child) => child.status === 'cancelled')).toBe(true);
      } finally {
        release();
        recording.mockRestore();
        await execution;
      }
    });

    it('取消审计写入失败保留 infrastructure / recovery 边界，不伪造 Run cancelled 或 business failed', async () => {
      const f = await fixture('sub');
      const execution = f.service.execute(f.job);
      await vi.waitFor(() => expect(f.pluginSignals).toHaveLength(1));
      const recording = vi
        .spyOn(db().nodeRun, 'updateMany')
        .mockRejectedValue(Error('recording unavailable'));
      try {
        await f.runs.requestCancellation(f.run.id);
        await expect(execution).rejects.toMatchObject({
          code: 'WORKFLOW_EXECUTION_RECOVERY_REQUIRED',
        });
        const facts = await f.facts();
        expect(facts.run.status).toBe('running');
        expect(facts.run.cancellationRequestedAt).not.toBeNull();
        expect(facts.run.error).toBeNull();
        expect(facts.intent.status).toBe('recovery_required');
      } finally {
        recording.mockRestore();
      }
    });

    it('真实 PostgresSaver 接收 signal 的 nested graph 取消后保留 checkpoint', async () => {
      const saver = new PostgresSaver(
        new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 }),
        undefined,
        { schema: 'langgraph' },
      );
      let threadId: string | undefined;
      try {
        const f = await fixture('iteration', 'cooperative', saver);
        threadId = f.run.threadId;
        const execution = f.service.execute(f.job);
        await vi.waitFor(() => expect(f.pluginSignals).toHaveLength(3));
        await f.runs.requestCancellation(f.run.id);
        expect(await execution).toMatchObject({ status: 'execution_cancelled' });
        const checkpoint = await saver.getTuple({ configurable: { thread_id: threadId } });
        expect(checkpoint?.config.configurable?.thread_id).toBe(threadId);
        expect((await f.facts()).run.status).toBe('cancelled');
      } finally {
        // 只清理本用例 thread；取消路径本身不删除 checkpoint。
        if (threadId) await saver.deleteThread(threadId);
        await saver.end();
      }
    });

    it('真实 BullMQ active Job 的 Worker 轮询持久化取消，不依赖 remove/cancelJob', async () => {
      const redis = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379');
      if (!['localhost', '127.0.0.1'].includes(redis.hostname)) throw Error('仅允许本机 Redis');
      const prefix = process.env.WORKFLOW_QUEUE_PREFIX;
      process.env.WORKFLOW_QUEUE_PREFIX = `dramaflow-test-cooperative-${randomUUID()}`;
      const f = await fixture('sub');
      const queue = new WorkflowExecutionQueue();
      const consumer = new WorkflowExecutionConsumer(f.service, database!);
      try {
        await queue.publish(f.job);
        consumer.onApplicationBootstrap();
        await vi.waitFor(() => expect(f.pluginSignals).toHaveLength(1));
        const job = await queue.queue.getJob(workflowExecutionJobId(f.job));
        expect(await job!.getState()).toBe('active');
        await f.runs.requestCancellation(f.run.id);
        await vi.waitFor(async () => expect(await job!.getState()).toBe('completed'));
        expect((await f.facts()).intent.status).toBe('cancelled');
      } finally {
        await consumer.onModuleDestroy();
        await queue.queue.obliterate({ force: true });
        await queue.onModuleDestroy();
        if (prefix === undefined) delete process.env.WORKFLOW_QUEUE_PREFIX;
        else process.env.WORKFLOW_QUEUE_PREFIX = prefix;
      }
    });
  },
);
