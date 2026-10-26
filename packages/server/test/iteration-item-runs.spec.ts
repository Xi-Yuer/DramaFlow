import { randomUUID } from 'node:crypto';
import { MemorySaver } from '@langchain/langgraph-checkpoint';
import { NumberType, StringType, type WorkflowDefinition } from '@dramaflow/contracts';
import {
  createBindingResolver,
  createIterationNodeType,
  DefaultNodeExecutor,
  DefaultWorkflowCompiler,
  DefaultRuntimeValueCodec,
  DefaultDataStoragePolicyResolver,
  NodeRegistry,
  deriveChildScope,
  type WorkflowState,
} from '@dramaflow/workflow';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { DatabaseService } from '../src/database/database.service.js';
import { NodeRunRepositories } from '../src/workflow/runtime/node-run-repository.js';
import { WorkflowRunRepositories } from '../src/workflow/workflow-run-repository.js';

const enabled = process.env.DRAMAFLOW_INTEGRATION === '1';
if (enabled) {
  const url = new URL(process.env.DATABASE_URL ?? '');
  if (!['localhost', '127.0.0.1'].includes(url.hostname) || url.pathname !== '/dramaflow_test')
    throw new Error('ItemRun 集成测试仅允许本机 dramaflow_test');
}

describe.skipIf(!enabled)('IterationItemRun PostgreSQL 持久化', () => {
  const database = enabled ? new DatabaseService() : undefined;
  const ownerId = randomUUID();
  const outsiderId = randomUUID();
  let projectId: string;
  const db = () => database!.client;
  const repositories = () => new NodeRunRepositories(database!);
  beforeAll(async () => {
    for (const id of [ownerId, outsiderId])
      await db().user.create({
        data: { id, name: 'ItemRun 测试', email: `${id}@example.test` },
      });
    projectId = (
      await db().project.create({ data: { ownerId, name: 'ItemRun 测试', viewport: {} } })
    ).id;
  });
  afterAll(async () => {
    if (database) {
      await db().user.deleteMany({ where: { id: { in: [ownerId, outsiderId] } } });
      await database.onModuleDestroy();
    }
  });

  async function fixture() {
    const strings = { kind: 'array' as const, itemType: StringType };
    const runRepository = await new WorkflowRunRepositories(database!).forProject(
      ownerId,
      projectId,
    );
    const run = await runRepository.create({
      projectId,
      workflowId: 'test-workflow',
      workflowVersionId: 'test-version',
      invocationKey: randomUUID(),
      inputs: { items: { storage: 'inline', type: strings, value: ['A', 'B', 'C'] } },
    });
    await runRepository.markRunning(run.id);
    const repository = await repositories().forRun(ownerId, projectId, run.id);
    const execute = vi.fn(async (input: { item: string; index: number }) => ({ text: input.item }));
    const registry = new NodeRegistry([
      createIterationNodeType(),
      {
        manifest: {
          type: 'test.episode',
          version: 1,
          executionKind: 'action',
          metadata: { name: '集', category: 'data' },
          inputs: [
            { key: 'item', name: '集', dataType: StringType, required: true },
            { key: 'index', name: '位置', dataType: NumberType, required: true },
          ],
          outputs: [{ key: 'text', name: '文本', dataType: StringType }],
          config: [],
        },
        inputSchema: z.object({ item: z.string(), index: z.number() }),
        outputSchema: z.object({ text: z.string() }),
        configSchema: z.object({}),
        execute,
      },
    ]);
    const definition: WorkflowDefinition = {
      inputs: [{ name: 'items', type: strings, required: true }],
      nodes: [
        {
          id: 'iteration',
          type: 'flow.iteration',
          typeVersion: 1,
          name: '逐集',
          inputs: { items: { type: 'workflow_input', key: 'items' } },
          config: {},
          ui: { position: { x: 0, y: 0 } },
          composite: {
            kind: 'iteration',
            itemType: StringType,
            invariantInputs: [],
            bodyInputMapping: [
              { target: 'item', source: { type: 'current_item' } },
              { target: 'index', source: { type: 'current_index' } },
            ],
            body: {
              inputs: [
                { name: 'item', type: StringType, required: true },
                { name: 'index', type: NumberType, required: true },
              ],
              nodes: [
                {
                  id: 'episode',
                  type: 'test.episode',
                  typeVersion: 1,
                  name: '处理',
                  inputs: {
                    item: { type: 'workflow_input', key: 'item' },
                    index: { type: 'workflow_input', key: 'index' },
                  },
                  config: {},
                  ui: { position: { x: 0, y: 0 } },
                },
              ],
              edges: [],
              outputs: [
                {
                  name: 'text',
                  type: StringType,
                  source: { nodeId: 'episode', outputKey: 'text' },
                },
              ],
            },
          },
        },
      ],
      edges: [],
      outputs: [],
    };
    const bindings = createBindingResolver();
    const codec = new DefaultRuntimeValueCodec(
      {
        resolve: async () => {
          throw new Error('不应读取对象');
        },
      },
      {
        write: async () => {
          throw new Error('不应写入对象');
        },
      },
      new DefaultDataStoragePolicyResolver(),
    );
    const compiler = new DefaultWorkflowCompiler(
      registry,
      async () => new DefaultNodeExecutor(registry, bindings, codec, repository),
      new MemorySaver(),
      async () => ({ bindings, codec }),
      async () => repository,
      async () => repository,
    );
    const initial: WorkflowState = {
      run: {
        projectId,
        workflowId: run.workflowId,
        workflowVersionId: run.workflowVersionId,
        workflowRunId: run.id,
      },
      inputs: run.inputs,
      outputs: {},
      variables: {},
      execution: {},
    };
    return {
      run,
      repository,
      execute,
      definition,
      compiler,
      initial,
      config: { configurable: { thread_id: run.threadId } },
    };
  }

  it('真实编译执行 [A,B,C]，查询三个 item 与其 Body NodeRun，父 attempt 正确', async () => {
    const f = await fixture();
    const graph = await f.compiler.compile(f.definition, f.run);
    await graph.invoke(f.initial, { ...f.config, maxConcurrency: 3 });
    const items = await db().iterationItemRun.findMany({
      where: { workflowRunId: f.run.id },
      orderBy: { index: 'asc' },
      include: { bodyNodeRuns: true, iterationNodeRun: true },
    });
    expect(items).toHaveLength(3);
    expect(items.map((item) => item.index)).toEqual([0, 1, 2]);
    expect(new Set(items.map((item) => item.iterationNodeRunId)).size).toBe(1);
    for (const item of items) {
      expect(item.status).toBe('completed');
      expect(item.completedAt).toBeInstanceOf(Date);
      expect(item.createdAt).toBeInstanceOf(Date);
      expect(item.startedAt).toBeInstanceOf(Date);
      expect(item.iterationNodeRun).toMatchObject({
        nodeId: 'iteration',
        attempt: 1,
        status: 'completed',
      });
      expect(item.bodyNodeRuns).toMatchObject([
        {
          iterationItemRunId: item.id,
          status: 'completed',
          inputs: { item: { value: ['A', 'B', 'C'][item.index] } },
        },
      ]);
    }
  });

  it('并行中一个 item 失败，其他 item 保留 completed 及各自外键', async () => {
    const f = await fixture();
    let fail: () => void = () => {
      throw new Error('未初始化');
    };
    const failing = new Promise<void>((resolve) => {
      fail = resolve;
    });
    f.execute.mockImplementation(async (input) => {
      if (input.index === 1) {
        await failing;
        throw new Error('供应商秘密');
      }
      return { text: input.item };
    });
    const graph = await f.compiler.compile(f.definition, f.run);
    const result = expect(
      graph.invoke(f.initial, { ...f.config, maxConcurrency: 3 }),
    ).rejects.toMatchObject({ code: 'NODE_EXECUTION_FAILED' });
    try {
      await vi.waitFor(
        async () => {
          const items = await db().iterationItemRun.findMany({
            where: { workflowRunId: f.run.id },
            orderBy: { index: 'asc' },
          });
          expect(items.map((item) => item.status)).toEqual(['completed', 'running', 'completed']);
        },
        { timeout: 5000 },
      );
    } finally {
      fail();
    }
    await result;
    const items = await db().iterationItemRun.findMany({
      where: { workflowRunId: f.run.id },
      orderBy: { index: 'asc' },
      include: { bodyNodeRuns: true },
    });
    expect(items.map((item) => item.status)).toEqual(['completed', 'failed', 'completed']);
    for (const item of items) {
      expect(item.bodyNodeRuns).toMatchObject([
        {
          iterationItemRunId: item.id,
          inputs: { index: { value: item.index } },
          status: item.status,
        },
      ]);
    }
    expect(JSON.stringify(items)).not.toContain('供应商秘密');
  });

  async function parent(
    f: Awaited<ReturnType<typeof fixture>>,
    nodeId = 'iteration',
    scopeKey = 'root',
    iterationItemRunId?: string,
  ) {
    const occurrence = await f.repository.getOrCreateOccurrence({
      workflowRunId: f.run.id,
      nodeId,
      scopeKey,
    });
    return f.repository.createRunning({
      workflowRunId: f.run.id,
      nodeId,
      occurrenceId: occurrence.id,
      ...(iterationItemRunId ? { iterationItemRunId } : {}),
    });
  }
  function itemInput(
    f: Awaited<ReturnType<typeof fixture>>,
    node: Awaited<ReturnType<typeof parent>>,
    index: number,
  ) {
    return {
      workflowRunId: f.run.id,
      iterationNodeRunId: node.id,
      iterationNodeId: node.nodeId,
      index,
      scopeKey: deriveChildScope(node.scopeKey, {
        kind: 'iteration_item',
        ownerOccurrenceId: node.occurrenceId,
        ownerNodeRunId: node.id,
        slot: 'body',
        index,
      }),
    };
  }

  it('同父/index 并发重入唯一；不同父 attempt 同 index 隔离；Body attempt 独立分配', async () => {
    const f = await fixture();
    const first = await parent(f);
    const input = itemInput(f, first, 0);
    const rows = await Promise.all(
      Array.from({ length: 4 }, () => f.repository.getOrCreateIterationItemRunning(input)),
    );
    expect(new Set(rows.map((row) => row.id)).size).toBe(1);
    const item = rows[0]!;
    const bodies = await Promise.all(
      Array.from({ length: 4 }, () => parent(f, 'episode', item.scopeKey, item.id)),
    );
    expect(bodies.map((row) => row.attempt).sort()).toEqual([1, 2, 3, 4]);
    expect(bodies.every((row) => row.iterationItemRunId === item.id)).toBe(true);
    const second = await parent(f);
    expect(second.attempt).toBe(2);
    const next = await f.repository.getOrCreateIterationItemRunning(itemInput(f, second, 0));
    expect(next.id).not.toBe(item.id);
    expect(next.scopeKey).not.toBe(item.scopeKey);
  });

  it('数据模型允许 A#2 → B#5 → NodeRun，逐层按外键回溯', async () => {
    const f = await fixture();
    const a = await parent(f, 'A');
    const aItem = await f.repository.getOrCreateIterationItemRunning(itemInput(f, a, 2));
    const b = await parent(f, 'B', aItem.scopeKey, aItem.id);
    const bItem = await f.repository.getOrCreateIterationItemRunning(itemInput(f, b, 5));
    const leaf = await parent(f, 'leaf', bItem.scopeKey, bItem.id);
    const row = await db().nodeRun.findUniqueOrThrow({
      where: { id: leaf.id },
      include: {
        iterationItemRun: {
          include: {
            iterationNodeRun: {
              include: { iterationItemRun: { include: { iterationNodeRun: true } } },
            },
          },
        },
      },
    });
    expect(row.iterationItemRun).toMatchObject({
      index: 5,
      iterationNodeRun: {
        id: b.id,
        iterationItemRun: { index: 2, iterationNodeRun: { id: a.id } },
      },
    });
  });

  it('权限、跨 Run / scope 错挂、身份改写和终态覆盖均拒绝', async () => {
    const f = await fixture();
    const other = await fixture();
    const p = await parent(f);
    const one = await f.repository.getOrCreateIterationItemRunning(itemInput(f, p, 0));
    const two = await f.repository.getOrCreateIterationItemRunning(itemInput(f, p, 1));
    const occurrence = await f.repository.getOrCreateOccurrence({
      workflowRunId: f.run.id,
      nodeId: 'episode',
      scopeKey: one.scopeKey,
    });
    const bodyData = {
      projectId,
      workflowRunId: f.run.id,
      nodeId: 'episode',
      occurrenceId: occurrence.id,
      attempt: 1,
    };
    await expect(repositories().forRun(outsiderId, projectId, f.run.id)).rejects.toThrow();
    await expect(
      other.repository.getOrCreateIterationItemRunning(itemInput(f, p, 2)),
    ).rejects.toThrow();
    await expect(other.repository.markIterationItemCompleted(one.id)).rejects.toThrow();
    await expect(
      f.repository.getOrCreateIterationItemRunning({ ...itemInput(f, p, 2), scopeKey: 'forged' }),
    ).rejects.toThrow();
    await expect(
      db().nodeRun.create({ data: { ...bodyData, iterationItemRunId: two.id } }),
    ).rejects.toThrow();
    await expect(db().nodeRun.create({ data: bodyData })).rejects.toThrow();
    const body = await parent(f, 'episode', one.scopeKey, one.id);
    await expect(
      db().nodeRun.update({ where: { id: body.id }, data: { iterationItemRunId: two.id } }),
    ).rejects.toThrow();
    await expect(
      db().iterationItemRun.update({ where: { id: one.id }, data: { index: 8 } }),
    ).rejects.toThrow();
    await expect(
      db().iterationItemRun.create({ data: { ...itemInput(f, p, 2), index: -1, projectId } }),
    ).rejects.toThrow();
    await expect(
      db().iterationItemRun.create({
        data: { ...itemInput(f, p, 2), projectId, workflowRunId: other.run.id },
      }),
    ).rejects.toThrow();
    await f.repository.markIterationItemCompleted(one.id);
    await expect(
      db().iterationItemRun.update({
        where: { id: one.id },
        data: { status: 'running', completedAt: null },
      }),
    ).rejects.toThrow();
    await expect(
      f.repository.getOrCreateIterationItemRunning(itemInput(f, p, 0)),
    ).rejects.toThrow();
    const error = { stage: 'execute', message: '失败' };
    await Promise.all([
      f.repository.markIterationItemFailed(two.id, error),
      f.repository.markIterationItemFailed(two.id, error),
    ]);
    expect(await db().iterationItemRun.findUnique({ where: { id: two.id } })).toMatchObject({
      status: 'failed',
    });
    await expect(
      db().iterationItemRun.update({
        where: { id: two.id },
        data: { error: { stage: 'execute', message: '改写' } },
      }),
    ).rejects.toThrow();
    await db().workflowRun.delete({ where: { id: f.run.id } });
    expect(await db().iterationItemRun.count({ where: { workflowRunId: f.run.id } })).toBe(0);
    expect(await db().nodeRun.count({ where: { workflowRunId: f.run.id } })).toBe(0);
  });
});
