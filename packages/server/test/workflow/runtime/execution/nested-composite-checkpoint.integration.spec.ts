import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { MemorySaver } from '@langchain/langgraph-checkpoint';
import { NumberType, StringType } from '@dramaflow/contracts';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { DatabaseService } from '../../../../src/database/database.service.js';
import { WorkflowRunRepositories } from '../../../../src/workflow/run/repository/workflow-run-repository.js';
import { NodeRunRepositories } from '../../../../src/workflow/runtime/execution/node-run-repository.js';
import {
  DefaultWorkflowOutputResolver,
  DefaultWorkflowRunner,
  NodeExecutionError,
  deriveChildScope,
  graphExecutionIdentitySchema,
  workflowStateSchema,
  type WorkflowState,
  type WorkflowVersionRecord,
} from '../../../../../workflow/src/index.js';
import {
  iterationSubworkflowFixture,
  pauseSubworkflowInput,
  array,
  expected,
  texts,
} from '../../../../../workflow/test/fixtures/iteration-subworkflow-fixture.js';

const enabled = process.env.DRAMAFLOW_INTEGRATION === '1';
if (enabled) {
  const url = new URL(process.env.DATABASE_URL ?? '');
  if (!['localhost', '127.0.0.1'].includes(url.hostname) || url.pathname !== '/dramaflow_test')
    throw new Error('组合 checkpoint 集成测试仅允许本机 dramaflow_test');
}

describe.skipIf(!enabled)('Iteration → SubWorkflow 真实 PostgreSQL / PostgresSaver', () => {
  const database = enabled ? new DatabaseService() : undefined;
  const db = () => database!.client;
  const ownerId = randomUUID();
  let projectId: string;
  const threads: string[] = [];
  const stores: { saver: PostgresSaver; closed: boolean }[] = [];
  const store = () => {
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
    const entry = {
      saver: new PostgresSaver(pool, undefined, { schema: 'langgraph' }),
      closed: false,
    };
    stores.push(entry);
    return entry;
  };
  const close = async (entry: (typeof stores)[number]) => {
    if (!entry.closed) {
      await entry.saver.end();
      entry.closed = true;
    }
  };
  beforeAll(async () => {
    // 只读取已有 schema；明确不调用 PostgresSaver.setup 或迁移。
    const existing = await db().$queryRaw<
      { ready: string | null }[]
    >`SELECT to_regclass('langgraph.checkpoints')::text AS ready`;
    if (!existing[0]?.ready)
      throw new Error('缺少既有 LangGraph checkpoint 表；本测试不创建 schema');
    await db().user.create({
      data: { id: ownerId, name: '组合 checkpoint 测试', email: `${ownerId}@example.test` },
    });
    projectId = (await db().project.create({ data: { ownerId, name: '组合 checkpoint 测试' } })).id;
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    if (!database) return;
    const cleanup = store();
    try {
      for (const thread of threads) await cleanup.saver.deleteThread(thread);
      await db().user.deleteMany({ where: { id: ownerId } });
    } finally {
      for (const entry of stores) await close(entry);
      await database.onModuleDestroy();
    }
  });
  async function fixture() {
    const f = iterationSubworkflowFixture();
    const runs = await new WorkflowRunRepositories(database!).forProject(ownerId, projectId);
    const run = await runs.create({
      projectId,
      workflowId: 'nested-checkpoint-test',
      workflowVersionId: 'test-version',
      invocationKey: randomUUID(),
      inputs: { items: { storage: 'inline', type: array, value: texts } },
    });
    threads.push(run.threadId);
    const version: WorkflowVersionRecord = {
      id: run.workflowVersionId,
      workflowId: run.workflowId,
      projectId,
      version: 1,
      publishedAt: '2026-10-28T00:00:00.000Z',
      definition: f.definition,
    };
    const runner = (saver: PostgresSaver) =>
      new DefaultWorkflowRunner(
        { getVersion: async () => structuredClone(version) },
        runs,
        {
          compile: async (definition, current) =>
            f.compile(definition, current, {
              checkpointer: saver,
              runs: await new NodeRunRepositories(database!).forRun(ownerId, projectId, current.id),
            }),
        },
        new DefaultWorkflowOutputResolver(),
      );
    const facts = async () => ({
      nodes: await db().nodeRun.findMany({
        where: { workflowRunId: run.id },
        include: { occurrence: true },
        orderBy: { id: 'asc' },
      }),
      children: await db().childExecution.findMany({
        where: { workflowRunId: run.id },
        orderBy: { id: 'asc' },
      }),
    });
    return { ...f, runs, run, runner, facts };
  }
  function hierarchy(facts: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['facts']>>) {
    const { nodes, children } = facts;
    const roots = nodes.filter((row) => row.childExecutionId === null);
    expect(roots).toHaveLength(1);
    const owner = roots[0]!;
    expect(owner).toMatchObject({ nodeId: 'iterate', attempt: 1 });
    const items = children
      .filter((row) => row.parentNodeRunId === owner.id)
      .sort(
        (a, b) =>
          z.object({ index: z.number() }).parse(a.metadata).index -
          z.object({ index: z.number() }).parse(b.metadata).index,
      );
    expect(items).toHaveLength(3);
    const rows = items.map((item, index) => {
      expect(item.metadata).toEqual({ index });
      const parents = nodes.filter((row) => row.childExecutionId === item.id);
      expect(parents).toHaveLength(1);
      const sub = parents[0]!;
      expect(sub).toMatchObject({
        nodeId: 'sub',
        attempt: 1,
        occurrence: { scopeKey: item.scopeKey },
      });
      const calls = children.filter((row) => row.parentNodeRunId === sub.id);
      expect(calls).toHaveLength(1);
      const call = calls[0]!;
      expect(call.kind).toBe('subworkflow');
      const actions = nodes.filter((row) => row.childExecutionId === call.id);
      expect(actions).toHaveLength(1);
      const action = actions[0]!;
      expect(action).toMatchObject({
        nodeId: 'action',
        attempt: 1,
        occurrence: { scopeKey: call.scopeKey },
      });
      expect(action.inputs).toMatchObject({
        text: { value: texts[index] },
        index: { value: index },
      });
      expect(action.outputs).toMatchObject({ text: { value: expected[index] } });
      expect(sub.outputs).toEqual(action.outputs);
      return {
        index,
        itemId: item.id,
        subId: sub.id,
        subOccurrence: sub.occurrenceId,
        callId: call.id,
        actionId: action.id,
        actionOccurrence: action.occurrenceId,
      };
    });
    for (const key of [
      'itemId',
      'subId',
      'subOccurrence',
      'callId',
      'actionId',
      'actionOccurrence',
    ] as const)
      expect(new Set(rows.map((row) => row[key])).size).toBe(3);
    expect(new Set(nodes.map((row) => row.occurrenceId)).size).toBe(7);
    expect(nodes).toHaveLength(7);
    expect(children).toHaveLength(6);
    return rows;
  }

  it('真实 waiting → 新 PostgresSaver / runtime → resume，完成 sibling 不重放且 beta 只新增一个 Action', async () => {
    const f = await fixture();
    pauseSubworkflowInput('beta');
    const first = store();
    expect(await f.runner(first.saver).executeStart(f.run.id)).toMatchObject({ status: 'waiting' });
    const before = await f.facts();
    expect(before.nodes).toHaveLength(6);
    expect(before.children).toHaveLength(6);
    const owner = before.nodes.find((row) => row.childExecutionId === null)!;
    const items = before.children
      .filter((row) => row.parentNodeRunId === owner.id)
      .sort(
        (a, b) =>
          z.object({ index: z.number() }).parse(a.metadata).index -
          z.object({ index: z.number() }).parse(b.metadata).index,
      );
    expect(items.map((row) => row.status)).toEqual(['completed', 'running', 'completed']);
    expect(f.execute).toHaveBeenCalledTimes(2);
    const namespaces = await db().$queryRaw<
      { count: bigint }[]
    >`SELECT count(DISTINCT checkpoint_ns) FROM langgraph.checkpoints WHERE thread_id = ${f.run.threadId}`;
    expect(Number(namespaces[0]!.count)).toBeGreaterThan(3);
    await close(first); // 关闭原连接池；恢复只能读取真实持久化 checkpoint。
    const second = store();
    expect(
      await f.runner(second.saver).executeResume({ workflowRunId: f.run.id, value: 'ok' }),
    ).toMatchObject({
      status: 'completed',
      outputs: { result: { storage: 'inline', type: array, value: expected } },
    });
    const after = await f.facts();
    hierarchy(after);
    expect(after.children.map((row) => row.id)).toEqual(before.children.map((row) => row.id));
    expect(
      after.nodes
        .filter((row) => row.nodeId !== 'action')
        .map((row) => [row.id, row.occurrenceId, row.attempt]),
    ).toEqual(
      before.nodes
        .filter((row) => row.nodeId !== 'action')
        .map((row) => [row.id, row.occurrenceId, row.attempt]),
    );
    const added = after.nodes.filter((row) => !before.nodes.some((old) => old.id === row.id));
    expect(added).toHaveLength(1);
    const betaSub = before.nodes.find((row) => row.childExecutionId === items[1]!.id)!;
    const betaCall = before.children.find((row) => row.parentNodeRunId === betaSub.id)!;
    expect(added[0]).toMatchObject({ nodeId: 'action', childExecutionId: betaCall.id, attempt: 1 });
    expect(after.nodes.every((row) => row.status === 'completed')).toBe(true);
    expect(after.children.every((row) => row.status === 'completed')).toBe(true);
    expect(f.execute).toHaveBeenCalledTimes(3);
    expect((await f.runs.getById(f.run.id))?.status).toBe('completed');
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.write).not.toHaveBeenCalled();
  });

  it('真实 PostgreSQL failure boundary：beta 的 Action / 两层 child / 两层 Parent / Run 全部 failed', async () => {
    const f = await fixture();
    const execute = f.execute.getMockImplementation()!;
    f.execute.mockImplementation(async (raw, config, context) => {
      if (z.object({ text: z.string() }).parse(raw).text === 'beta') {
        await new Promise((resolve) => setTimeout(resolve, 80));
        throw new Error('beta failed');
      }
      return execute(raw, config, context);
    });
    await expect(f.runner(store().saver).executeStart(f.run.id)).rejects.toBeInstanceOf(
      NodeExecutionError,
    );
    const { nodes, children } = await f.facts();
    const item = children.find(
      (row) =>
        row.kind === 'iteration_item' &&
        z.object({ index: z.number() }).parse(row.metadata).index === 1,
    )!;
    const sub = nodes.find((row) => row.childExecutionId === item.id)!;
    const call = children.find((row) => row.parentNodeRunId === sub.id)!;
    const action = nodes.find((row) => row.childExecutionId === call.id)!;
    const owner = nodes.find((row) => row.id === item.parentNodeRunId)!;
    expect([
      action.status,
      call.status,
      sub.status,
      item.status,
      owner.status,
      (await f.runs.getById(f.run.id))?.status,
    ]).toEqual(Array(6).fill('failed'));
    expect(owner.outputs).toBeNull();
    expect(nodes.every((row) => row.attempt === 1)).toBe(true);
    expect(children.filter((row) => row.parentNodeRunId === sub.id)).toHaveLength(1);
  });

  it('真实 repository 的 prepare 重入：同一 Item 下新 Parent attempt / 新 child，不复用旧终态', async () => {
    const f = await fixture();
    await f.runs.markRunning(f.run.id);
    const repository = await new NodeRunRepositories(database!).forRun(
      ownerId,
      projectId,
      f.run.id,
    );
    const occurrence = await repository.getOrCreateOccurrence({
      workflowRunId: f.run.id,
      nodeId: 'iterate',
      scopeKey: 'root',
    });
    const owner = await repository.createRunning({
      workflowRunId: f.run.id,
      nodeId: 'iterate',
      occurrenceId: occurrence.id,
    });
    await repository.updateInputs(owner.id, f.run.inputs);
    const item = await repository.getOrCreateIterationItemRunning({
      workflowRunId: f.run.id,
      parentNodeRunId: owner.id,
      parentNodeId: 'iterate',
      index: 0,
      scopeKey: deriveChildScope('root', {
        kind: 'iteration_item',
        ownerOccurrenceId: owner.occurrenceId,
        ownerNodeRunId: owner.id,
        slot: 'body',
        index: 0,
      }),
    });
    const loop = f.definition.nodes[0]!;
    if (loop.composite?.kind !== 'iteration') throw new Error('测试必须使用 Iteration');
    const input: WorkflowState = {
      run: {
        workflowRunId: f.run.id,
        workflowVersionId: f.run.workflowVersionId,
        workflowId: f.run.workflowId,
        projectId,
      },
      inputs: {
        text: { storage: 'inline', type: StringType, value: 'alpha' },
        index: { storage: 'inline', type: NumberType, value: 0 },
      },
      outputs: {},
      variables: {},
      execution: {},
    };
    const config = {
      configurable: {
        thread_id: f.run.threadId,
        graphExecution: { scopeKey: item.scopeKey, childExecutionId: item.id },
      },
    };
    // 受控独立调用以空 checkpoint 开始，明确不是恢复、自动 Retry 或旧 child replay。
    for (let attempt = 1; attempt <= 2; attempt++) {
      const graph = f.compile(loop.composite.body, f.run, {
        runs: repository,
        checkpointer: new MemorySaver(),
        path: [{ nodeId: 'iterate', graphKey: 'body' }],
        execution: {
          resolve: (_state, current) =>
            graphExecutionIdentitySchema.parse(current.configurable?.graphExecution),
        },
      });
      expect(
        workflowStateSchema.parse(await graph.invoke(input, config)).outputs.sub?.text,
      ).toMatchObject({ value: 'result-0' });
    }
    const facts = await f.facts();
    const parents = facts.nodes
      .filter((row) => row.childExecutionId === item.id)
      .sort((a, b) => a.attempt - b.attempt);
    expect(parents.map((row) => row.attempt)).toEqual([1, 2]);
    expect(new Set(parents.map((row) => row.occurrenceId)).size).toBe(1);
    expect(
      parents.every(
        (row) => row.occurrence.scopeKey === item.scopeKey && row.status === 'completed',
      ),
    ).toBe(true);
    const calls = parents.map((parent) =>
      facts.children.find((row) => row.parentNodeRunId === parent.id)!,
    );
    expect(new Set(calls.map((row) => row.id)).size).toBe(2);
    expect(new Set(calls.map((row) => row.scopeKey)).size).toBe(2);
    for (const call of calls) {
      expect(call).toMatchObject({ kind: 'subworkflow', status: 'completed' });
      const actions = facts.nodes.filter((row) => row.childExecutionId === call.id);
      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({
        nodeId: 'action',
        attempt: 1,
        status: 'completed',
        occurrence: { scopeKey: call.scopeKey },
      });
    }
    expect(facts.nodes).toHaveLength(5);
    expect(facts.children).toHaveLength(3);
    expect(facts.children.find((row) => row.id === item.id)?.status).toBe('running');
  });
});
