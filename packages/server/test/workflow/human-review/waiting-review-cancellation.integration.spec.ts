import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { INTERRUPT } from '@langchain/langgraph-checkpoint';
import type { NodeDefinition, WorkflowDefinition } from '@dramaflow/contracts';
import {
  createHumanReviewNodeType,
  DefaultDataStoragePolicyResolver,
  DefaultRuntimeValueCodec,
  DefaultWorkflowOutputResolver,
  NodeRegistry,
} from '@dramaflow/workflow';
import { DatabaseService } from '../../../src/database/database.service.js';
import { WorkflowRunRepositories } from '../../../src/workflow/run/repository/workflow-run-repository.js';
import { WorkflowVersionRepositories } from '../../../src/workflow/run/repository/workflow-version-repository.js';
import { NodeRunRepositories } from '../../../src/workflow/runtime/execution/node-run-repository.js';
import { WorkflowRuntimeFactory } from '../../../src/workflow/runtime/workflow-runtime.factory.js';
import { WorkflowExecutionService } from '../../../src/workflow/runtime/workflow-execution.service.js';
import { WorkflowHumanReviewService } from '../../../src/workflow/human-review/human-review.service.js';
import { WorkflowExecutionTreeService } from '../../../src/workflow/execution-tree/workflow-execution-tree.service.js';
import { WorkflowRunCancellationService } from '../../../src/workflow/run/cancellation/workflow-run-cancellation.service.js';
import { WorkflowRunQueryService } from '../../../src/workflow/run/query/workflow-run-query.service.js';
import type { WorkflowCheckpointerService } from '../../../src/checkpoint/workflow-checkpointer.service.js';
import type { ArtifactRuntimeFactory } from '../../../src/artifacts/artifact-runtime.factory.js';
import type { WorkflowCapabilitiesFactory } from '../../../src/models/workflow-capabilities.factory.js';

const enabled = process.env.DRAMAFLOW_INTEGRATION === '1';
if (enabled) {
  const url = new URL(process.env.DATABASE_URL ?? '');
  if (!['localhost', '127.0.0.1'].includes(url.hostname) || url.pathname !== '/dramaflow_test')
    throw new Error('等待审核取消集成测试仅允许本机 dramaflow_test');
}
const review = (id: string): NodeDefinition => ({
  id,
  type: 'flow.human_review',
  typeVersion: 1,
  name: id,
  inputs: { content: { type: 'constant', value: '待核对文本' } },
  config: {},
  ui: { position: { x: 0, y: 0 } },
});
const serial: WorkflowDefinition = {
  inputs: [],
  outputs: [],
  nodes: [review('first'), review('review'), review('after')],
  edges: [
    { id: 'one', kind: 'control', source: { nodeId: 'first' }, target: { nodeId: 'review' } },
    { id: 'two', kind: 'control', source: { nodeId: 'review' }, target: { nodeId: 'after' } },
  ],
};

describe.skipIf(!enabled)('waiting Human Review 取消事务 / 真实 checkpoint', () => {
  const database = enabled ? new DatabaseService() : undefined;
  const db = () => database!.client;
  const owner = randomUUID();
  const threads: string[] = [];
  const saver = enabled
    ? new PostgresSaver(
        new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 }),
        undefined,
        { schema: 'langgraph' },
      )
    : undefined;
  const checkpoints = { saver } as unknown as WorkflowCheckpointerService;
  const versions = enabled ? new WorkflowVersionRepositories(database!) : undefined;
  const repositories = () => new WorkflowRunRepositories(database!);
  const reviews = () => new WorkflowHumanReviewService(database!, checkpoints);
  const codec = new DefaultRuntimeValueCodec(
    { resolve: vi.fn().mockRejectedValue(Error('不应读取引用')) },
    { write: vi.fn().mockRejectedValue(Error('不应写入 Artifact')) },
    new DefaultDataStoragePolicyResolver(),
  );
  const runtime = () =>
    new WorkflowRuntimeFactory(
      versions!,
      repositories(),
      new NodeRunRepositories(database!),
      new NodeRegistry([createHumanReviewNodeType()]),
      { forRun: async () => codec } as unknown as ArtifactRuntimeFactory,
      { forRun: () => ({ invoke: vi.fn() }) } as unknown as WorkflowCapabilitiesFactory,
      new DefaultWorkflowOutputResolver(),
      checkpoints,
    );
  beforeAll(async () => {
    const existing = await db().$queryRaw<
      { ready: string | null }[]
    >`SELECT to_regclass('langgraph.checkpoints')::text AS ready`;
    if (!existing[0]?.ready) throw new Error('需要既有 checkpoint 表；本测试不 setup / 迁移');
    await db().user.create({
      data: { id: owner, name: '审核取消测试', email: `${owner}@example.test` },
    });
  });
  afterAll(async () => {
    if (!database) return;
    try {
      for (const thread of threads) await saver!.deleteThread(thread);
      await db().user.deleteMany({ where: { id: owner } });
    } finally {
      await saver!.end();
      await database.onModuleDestroy();
    }
  });
  async function fixture(definition = serial) {
    const project = randomUUID();
    await db().project.create({
      data: { id: project, ownerId: owner, name: '审核取消测试', viewport: {} },
    });

    const workflow = await db().workflow.create({
      data: {
        projectId: project,
        name: '等待审核取消',
        draft: JSON.parse(JSON.stringify(definition)),
      },
    });
    const version = await db().workflowVersion.create({
      data: {
        workflowId: workflow.id,
        version: 1,
        sourceRevision: 1,
        definition: JSON.parse(JSON.stringify(definition)),
      },
    });
    const runs = await repositories().forProject(owner, project);
    const { run } = await runs.createWithExecution({
      projectId: project,
      workflowId: workflow.id,
      workflowVersionId: version.id,
      invocationKey: randomUUID(),
      inputs: {},
    });
    threads.push(run.threadId);
    const factory = runtime(),
      service = new WorkflowExecutionService(database!, factory);
    const facts = async () => ({
      run: await db().workflowRun.findUniqueOrThrow({ where: { id: run.id } }),
      nodes: await db().nodeRun.findMany({ where: { workflowRunId: run.id } }),
      children: await db().childExecution.findMany({ where: { workflowRunId: run.id } }),
      intents: await db().workflowExecutionOutbox.findMany({ where: { workflowRunId: run.id } }),
    });
    return {
      run,
      runs,
      factory,
      service,
      facts,
      config: { configurable: { thread_id: run.threadId, checkpoint_ns: '' } },
    };
  }
  async function waiting() {
    const f = await fixture();
    expect(await f.service.execute({ kind: 'start', workflowRunId: f.run.id })).toMatchObject({
      status: 'waiting',
    });
    const first = (await reviews().pending(owner, f.run.id)).items[0]!;
    const job = await reviews().submit(owner, f.run.id, {
      interruptId: first.interruptId,
      expectedWaitingRevision: first.waitingRevision,
      value: { action: 'approve', feedback: '真实已完成决策' },
    });
    expect(await f.service.execute(job)).toMatchObject({ status: 'waiting' });
    const pending = (await reviews().pending(owner, f.run.id)).items[0]!;
    expect(pending.node.id).toBe('review');
    return {
      ...f,
      pending,
      request: {
        interruptId: pending.interruptId,
        expectedWaitingRevision: pending.waitingRevision,
        value: { action: 'approve' },
      },
    };
  }

  it('取消 Review，保留已完成决策与原生 interrupt 证据，旧 token 不可恢复，Tree 返回 cancelled', async () => {
    const f = await waiting();
    const before = await f.facts();
    const checkpoint = await saver!.getTuple(f.config);
    expect(checkpoint!.pendingWrites!.some(([, channel]) => channel === INTERRUPT)).toBe(true);
    const product = new WorkflowRunCancellationService(
      database!,
      repositories(),
      new WorkflowRunQueryService(database!),
    );
    const cancel = () => product.cancel(owner, f.run.projectId, f.run.workflowId, f.run.id, {});
    const result = await cancel();
    expect(result).toMatchObject({ outcome: 'cancelled', run: { status: 'cancelled' } });
    expect(await cancel()).toEqual(result);
    const after = await f.facts();
    const node = after.nodes.find((node) => node.nodeId === 'review')!;
    expect(node).toMatchObject({
      status: 'cancelled',
      completedAt: expect.any(Date),
      outputs: null,
      error: null,
    });
    expect(node.inputs).toEqual(before.nodes.find((row) => row.id === node.id)!.inputs);
    expect(after.nodes.find((node) => node.nodeId === 'first')).toEqual(
      before.nodes.find((node) => node.nodeId === 'first'),
    );
    expect(after.nodes).toHaveLength(2); // after 从未启动。
    expect(after.run.outputs).toBeNull();
    expect(after.run.error).toBeNull();
    expect(await reviews().pending(owner, f.run.id)).toEqual({ items: [] });
    await expect(reviews().submit(owner, f.run.id, f.request)).rejects.toMatchObject({
      code: 'WORKFLOW_RUN_NOT_WAITING',
    });
    await expect(
      f.runs.createResumeExecution({ workflowRunId: f.run.id, value: f.request.value }),
    ).rejects.toThrow();
    expect(await f.runs.claimWaitingForResume(f.run.id)).toBeNull();
    const fresh = await runtime().forProject(owner, f.run.projectId);
    await expect(
      fresh.executeResume({
        workflowRunId: f.run.id,
        interruptId: f.pending.interruptId,
        value: f.request.value,
      }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_RUN_NOT_WAITING' });
    expect(await saver!.getTuple(f.config)).toEqual(checkpoint);
    const tree = await new WorkflowExecutionTreeService(database!).query(owner, f.run.id);
    expect(tree.run.status).toBe('cancelled');
    expect(tree.items).toContainEqual(
      expect.objectContaining({ type: 'node_run', id: node.id, status: 'cancelled' }),
    );
    expect((await f.facts()).nodes).toEqual(after.nodes);
  });

  it('已提交但未 claim 的 resume 遇到取消，不执行、不产生 reject 或新 attempt', async () => {
    const f = await waiting();
    const job = await reviews().submit(owner, f.run.id, f.request);
    await f.runs.requestCancellation(f.run.id);
    expect(await f.service.execute(job)).toMatchObject({ status: 'execution_cancelled' });
    const facts = await f.facts();
    expect(facts.intents.find((intent) => intent.id === job.executionId)!.status).toBe('cancelled');
    expect(facts.nodes.find((node) => node.nodeId === 'review')).toMatchObject({
      status: 'cancelled',
      outputs: null,
      attempt: 1,
    });
    expect(facts.nodes).toHaveLength(2);
  });

  it('resume claim 先胜：请求保持 in-flight，不伪造 waiting 收尾；确认 abort 后补齐未重登记的 Review', async () => {
    const f = await waiting();
    const job = await reviews().submit(owner, f.run.id, f.request);
    // 用真实 Runner claim，在版本读取处阻塞，覆盖 Review 尚未重登记到本次 scope 的窗口。
    let claimed!: () => void, proceed!: () => void;
    const barrier = new Promise<void>((resolve) => {
      claimed = resolve;
    });
    const released = new Promise<void>((resolve) => {
      proceed = resolve;
    });
    const original = versions!.forProject.bind(versions);
    const hook = vi.spyOn(versions!, 'forProject').mockImplementation(async (...args) => {
      const repository = await original(...args);
      const getVersion = repository.getVersion.bind(repository);
      return {
        getVersion: async (...input) => {
          claimed();
          await released;
          return getVersion(...input);
        },
      };
    });
    const execution = f.service.execute(job);
    try {
      await barrier;
      expect((await f.runs.requestCancellation(f.run.id)).outcome).toBe('in_flight');
      expect((await f.facts()).nodes.find((node) => node.nodeId === 'review')!.status).toBe(
        'running',
      );
      proceed();
      expect(await execution).toMatchObject({ status: 'execution_cancelled' });
      const facts = await f.facts();
      expect(facts.run.status).toBe('cancelled');
      expect(facts.nodes.find((node) => node.nodeId === 'review')!.status).toBe('cancelled');
      expect(facts.intents.find((intent) => intent.id === job.executionId)!.status).toBe(
        'cancelled',
      );
      expect(facts.nodes).toHaveLength(2);
    } finally {
      proceed();
      hook.mockRestore();
      await execution;
    }
  });

  it('cancel / resume claim 真正并发，持久化决定胜者；cancel 胜者不会创建新的执行', async () => {
    for (let i = 0; i < 4; i++) {
      const f = await waiting();
      const job = await reviews().submit(owner, f.run.id, f.request);
      const worker = await repositories().forProject(owner, f.run.projectId, job.executionId);
      const [cancel, claimed] = await Promise.all([
        f.runs.requestCancellation(f.run.id),
        worker.claimWaitingForResume(f.run.id),
      ]);
      expect(cancel.outcome).toBe(claimed ? 'in_flight' : 'cancelled');
      expect((await f.facts()).nodes.find((node) => node.nodeId === 'review')!.status).toBe(
        claimed ? 'running' : 'cancelled',
      );
      if (claimed) await worker.markCancelled(f.run.id); // 测试只 claim，未启动图；显式确认没有在途调用。
      expect(await worker.claimWaitingForResume(f.run.id)).toBeNull();
      expect((await f.facts()).nodes).toHaveLength(2);
    }
  });

  it.each(['failed', 'cancelled'] as const)('已 %s 的 Review 不被收尾覆盖', async (status) => {
    const f = await waiting();
    const repository = await new NodeRunRepositories(database!).forRun(
      owner,
      f.run.projectId,
      f.run.id,
    );
    const node = (await f.facts()).nodes.find((node) => node.nodeId === 'review')!;
    if (status === 'failed')
      await repository.markFailed(node.id, { stage: 'execute', message: '真实失败' });
    else
      await db().nodeRun.update({
        where: { id: node.id },
        data: { status, completedAt: new Date() },
      });
    const before = (await f.facts()).nodes;
    await f.runs.requestCancellation(f.run.id);
    expect((await f.facts()).nodes).toEqual(before);
  });

  it('审计写入失败则整个取消事务回滚，不报告已经 cancelled', async () => {
    const f = await waiting();
    const audit = (await f.facts()).nodes.find((node) => node.nodeId === 'review')!;
    const trigger = `test_wait_cancel_${randomUUID().replaceAll('-', '')}`;
    await db().$executeRawUnsafe(
      `CREATE FUNCTION ${trigger}() RETURNS trigger AS $$ BEGIN IF OLD.id = '${audit.id}'::uuid THEN RAISE EXCEPTION 'test cancellation write unavailable'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql`,
    );
    await db().$executeRawUnsafe(
      `CREATE TRIGGER ${trigger} BEFORE UPDATE ON node_run FOR EACH ROW EXECUTE FUNCTION ${trigger}()`,
    );
    try {
      await expect(f.runs.requestCancellation(f.run.id)).rejects.toThrow();
      const facts = await f.facts();
      expect(facts.run).toMatchObject({
        status: 'waiting',
        cancellationRequestedAt: null,
        completedAt: null,
      });
      expect(facts.nodes.find((node) => node.id === audit.id)!.status).toBe('running');
      expect((await reviews().pending(owner, f.run.id)).items).toHaveLength(1);
    } finally {
      await db().$executeRawUnsafe(`DROP TRIGGER ${trigger} ON node_run`);
      await db().$executeRawUnsafe(`DROP FUNCTION ${trigger}()`);
    }
  });

  it('显式父链收尾 nested Review 的 running owner，保留同 nodeId 的普通 Action 和 sibling', async () => {
    const nested: NodeDefinition = {
      ...review('sub'),
      type: 'flow.subworkflow',
      inputs: {},
      composite: {
        kind: 'subworkflow',
        graph: { inputs: [], nodes: [review('review')], edges: [], outputs: [] },
      },
    };
    const f = await fixture({
      inputs: [],
      outputs: [],
      edges: [],
      nodes: [nested, { ...review('review'), type: 'test.action' }, { ...nested, id: 'sibling' }],
    });
    // 仅仓储生命周期 fixture，不编译/发布 nested Review，不改变正式 capability gate。
    await f.runs.claimPendingForStart(f.run.id);
    const repo = await new NodeRunRepositories(database!).forRun(owner, f.run.projectId, f.run.id);
    async function node(nodeId: string, scopeKey = 'root', childExecutionId?: string) {
      const occurrence = await repo.getOrCreateOccurrence({
        workflowRunId: f.run.id,
        nodeId,
        scopeKey,
      });
      return repo.createRunning({
        workflowRunId: f.run.id,
        nodeId,
        occurrenceId: occurrence.id,
        ...(childExecutionId ? { childExecutionId } : {}),
      });
    }
    const parent = await node('sub'),
      sibling = await node('sibling'),
      action = await node('review');
    const child = await repo.getOrCreateChildExecutionRunning({
      workflowRunId: f.run.id,
      parentNodeRunId: parent.id,
      parentNodeId: parent.nodeId,
      scopeKey: randomUUID(),
      kind: 'subworkflow',
      invocationKey: 'subworkflow:graph',
      metadata: {},
    });
    const pending = await node('review', child.scopeKey, child.id);
    await f.runs.markWaiting(f.run.id);
    await f.runs.requestCancellation(f.run.id);
    const facts = await f.facts();
    expect(facts.nodes.find((node) => node.id === pending.id)!.status).toBe('cancelled');
    expect(facts.nodes.find((node) => node.id === parent.id)!.status).toBe('cancelled');
    expect(facts.children.find((row) => row.id === child.id)!.status).toBe('cancelled');
    expect(facts.nodes.find((node) => node.id === sibling.id)!.status).toBe('running');
    expect(facts.nodes.find((node) => node.id === action.id)!.status).toBe('running');
  });
});
