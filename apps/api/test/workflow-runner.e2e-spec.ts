import { randomUUID } from 'node:crypto';
import { NumberType, type WorkflowRun } from '@dramaflow/contracts';
import { DatabaseService } from '@dramaflow/server';
import {
  END,
  interrupt,
  MemorySaver,
  START,
  StateGraph,
} from '@langchain/langgraph';
import {
  createBindingResolver,
  DefaultDataStoragePolicyResolver,
  DefaultNodeExecutor,
  DefaultRuntimeValueCodec,
  DefaultWorkflowCompiler,
  DefaultWorkflowOutputResolver,
  DefaultWorkflowRunner,
  NodeRegistry,
  WorkflowStateAnnotation,
  type CompiledWorkflow,
  type WorkflowVersionRecord,
} from '@dramaflow/workflow';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { NodeRunRepositories } from '../src/workflow/node-runs/node-run-repository.js';
import { WorkflowRunRepositories } from '../src/workflow/workflow-runs/workflow-run-repository.js';

if (
  process.env.DRAMAFLOW_INTEGRATION !== '1' ||
  new URL(process.env.DATABASE_URL ?? 'http://invalid').pathname !==
    '/dramaflow_test'
)
  throw new Error(
    'WorkflowRunner 集成测试仅允许在 DramaFlow 的隔离测试数据库运行',
  );

const database = new DatabaseService();
const db = database.client;
const ownerId = randomUUID();
let projectId: string;

beforeAll(async () => {
  await db.user.create({
    data: {
      id: ownerId,
      name: '首次启动测试',
      email: `${ownerId}@example.test`,
    },
  });
  projectId = (
    await db.project.create({
      data: { ownerId, name: '首次启动测试', viewport: {} },
    })
  ).id;
});
afterAll(async () => {
  await db.user.deleteMany({ where: { id: ownerId } });
  await database.onModuleDestroy();
});

async function fixture() {
  const execute = vi.fn(async (input: { a: number; b: number }) => ({
    result: input.a + input.b,
    internal: -1,
  }));
  const registry = new NodeRegistry([
    {
      manifest: {
        type: 'math.add',
        version: 1,
        executionKind: 'action',
        metadata: { name: '加法', category: 'data' },
        inputs: [
          { key: 'a', name: 'A', dataType: NumberType },
          { key: 'b', name: 'B', dataType: NumberType },
        ],
        outputs: [
          { key: 'result', name: '结果', dataType: NumberType },
          { key: 'internal', name: '内部', dataType: NumberType },
        ],
        config: [],
      },
      inputSchema: z.object({ a: z.number(), b: z.number() }),
      outputSchema: z.object({ result: z.number(), internal: z.number() }),
      configSchema: z.object({}).strict(),
      execute,
    },
  ]);
  // 版本持久化尚未接入；这里明确注入已发布版本测试记录，不从 draft 读取，也不提供生产兜底。
  const version: WorkflowVersionRecord = {
    id: randomUUID(),
    projectId,
    workflowId: 'workflow-1',
    version: 3,
    publishedAt: '2026-10-20T00:00:00.000Z',
    definition: {
      inputs: [{ name: 'a', type: NumberType }],
      nodes: [
        {
          id: 'sum',
          type: 'math.add',
          typeVersion: 1,
          name: '加法',
          inputs: {
            a: { type: 'workflow_input', key: 'a' },
            b: { type: 'constant', value: 20 },
          },
          config: {},
          ui: { position: { x: 0, y: 0 } },
        },
      ],
      edges: [],
      outputs: [
        {
          name: 'answer',
          type: NumberType,
          source: { nodeId: 'sum', outputKey: 'result' },
        },
      ],
    },
  };
  const getVersion = vi.fn(async () => version);
  const runs = await new WorkflowRunRepositories(database).forProject(
    ownerId,
    projectId,
  );
  const nodeRuns = new NodeRunRepositories(database);
  const checkpointer = new MemorySaver(); // 只验证原生状态机制，生产 Saver 不在本轮建设。
  const codec = new DefaultRuntimeValueCodec(
    { resolve: vi.fn() },
    { write: vi.fn() },
    new DefaultDataStoragePolicyResolver(),
  );
  const compiler = new DefaultWorkflowCompiler(
    registry,
    async (run: WorkflowRun) =>
      new DefaultNodeExecutor(
        registry,
        createBindingResolver(),
        codec,
        await nodeRuns.forRun(ownerId, projectId, run.id),
      ),
    checkpointer,
  );
  const compileNative = compiler.compile.bind(compiler);
  const graphs: CompiledWorkflow[] = [];
  const compile = vi
    .spyOn(compiler, 'compile')
    .mockImplementation(async (definition, run) => {
      const graph = await compileNative(definition, run);
      graphs.push(graph);
      return graph;
    });
  const runner = new DefaultWorkflowRunner(
    { getVersion },
    runs,
    compiler,
    new DefaultWorkflowOutputResolver(),
  );
  const input = {
    projectId,
    workflowId: version.workflowId,
    workflowVersionId: version.id,
    inputs: { a: { storage: 'inline' as const, type: NumberType, value: 10 } },
  };
  return { runner, runs, execute, input, version, compile, graphs, getVersion };
}

async function resumeFixture(onResume: () => Promise<void> = async () => {}) {
  const f = await fixture();
  const saver = new MemorySaver();
  const values: unknown[] = [];
  const prepared = vi.fn(() => ({
    outputs: {
      prepared: {
        value: { storage: 'inline' as const, type: NumberType, value: 7 },
      },
    },
  }));
  const finish = vi.fn(() => ({
    outputs: {
      sum: {
        result: { storage: 'inline' as const, type: NumberType, value: 30 },
      },
    },
  }));
  const graphs: CompiledWorkflow[] = [];
  f.compile.mockImplementation(async () => {
    // 仅测试原生暂停 / 恢复，不实现生产 interaction 节点或 NodeRun 恢复关联。
    const graph: CompiledWorkflow = new StateGraph(WorkflowStateAnnotation)
      .addNode('prepare', prepared)
      .addNode('first_wait', async () => {
        const value = interrupt<unknown, unknown>('第一次输入');
        await onResume();
        values.push(value);
        return {};
      })
      .addNode('second_wait', () => {
        values.push(interrupt<unknown, unknown>('第二次输入'));
        return {};
      })
      .addNode('sum', finish)
      .addEdge(START, 'prepare')
      .addEdge('prepare', 'first_wait')
      .addEdge('first_wait', 'second_wait')
      .addEdge('second_wait', 'sum')
      .addEdge('sum', END)
      .compile({ checkpointer: saver });
    vi.spyOn(graph, 'invoke');
    graphs.push(graph);
    return graph;
  });
  return { ...f, graphs, values, prepared, finish };
}

describe('真实 PostgreSQL + LangGraph WorkflowRunner 首次启动', () => {
  it('启动 Action 图后保存独立线程、最终输出和 NodeRun 历史，checkpoint 保留内部端口', async () => {
    const f = await fixture();
    const result = await f.runner.start(f.input);
    expect(result.status).toBe('completed');
    const run = await db.workflowRun.findUniqueOrThrow({
      where: { id: result.workflowRunId },
      include: { nodeRuns: true },
    });
    expect(run).toMatchObject({
      projectId,
      workflowVersionId: f.version.id,
      status: 'completed',
      inputs: f.input.inputs,
      outputs: { answer: { storage: 'inline', type: NumberType, value: 30 } },
      error: null,
    });
    expect(run.threadId).not.toBe(run.id);
    expect(run.startedAt).toBeInstanceOf(Date);
    expect(run.completedAt).toBeInstanceOf(Date);
    expect(run.nodeRuns).toHaveLength(1);
    expect(run.nodeRuns[0]).toMatchObject({
      status: 'completed',
      workflowRunId: run.id,
      nodeId: 'sum',
      attempt: 1,
    });
    const snapshot = await f.graphs[0]!.getState({
      configurable: { thread_id: run.threadId },
    });
    expect(snapshot.next).toEqual([]);
    expect(snapshot.config.configurable?.thread_id).toBe(run.threadId);
    expect(snapshot.values.outputs.sum.internal.value).toBe(-1);
    expect(run.outputs).not.toHaveProperty('sum');
    expect(run.outputs).not.toHaveProperty('internal');
  });

  it('节点业务失败分别留下 NodeRun 与 WorkflowRun failed，并向上抛回准确节点阶段', async () => {
    const f = await fixture();
    const cause = new Error('provider-secret-marker');
    f.execute.mockRejectedValue(cause);
    await expect(f.runner.start(f.input)).rejects.toMatchObject({
      stage: 'execute',
      cause,
    });
    const run = await db.workflowRun.findFirstOrThrow({
      where: { workflowVersionId: f.version.id },
      include: { nodeRuns: true },
    });
    expect(run).toMatchObject({
      status: 'failed',
      outputs: null,
      error: { stage: 'invoke' },
    });
    expect(run.nodeRuns[0]).toMatchObject({
      status: 'failed',
      error: { stage: 'execute' },
    });
    expect(run.completedAt).toBeInstanceOf(Date);
    expect(JSON.stringify(run)).not.toContain('provider-secret-marker');
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it('原生 interrupt 正常暂停后记录 waiting，不生成最终输出，不写 failed', async () => {
    const f = await fixture();
    // 原生暂停测试图；不将 interrupt 混入普通 Action，也不实现 Human Review。
    const graph = new StateGraph(WorkflowStateAnnotation)
      .addNode('native_wait', () => {
        interrupt({ question: '外部输入' });
        return {};
      })
      .addEdge(START, 'native_wait')
      .addEdge('native_wait', END)
      .compile({ checkpointer: new MemorySaver() });
    f.compile.mockResolvedValue(graph);
    const result = await f.runner.start(f.input);
    const run = await db.workflowRun.findUniqueOrThrow({
      where: { id: result.workflowRunId },
    });
    expect(result.status).toBe('waiting');
    expect(run).toMatchObject({
      status: 'waiting',
      completedAt: null,
      outputs: null,
      error: null,
    });
    expect(run.startedAt).toBeInstanceOf(Date);
    const snapshot = await graph.getState({
      configurable: { thread_id: run.threadId },
    });
    expect(snapshot.next).toEqual(['native_wait']);
    expect(snapshot.tasks.flatMap((task) => task.interrupts)).toHaveLength(1);
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('最终输出来源缺失时 NodeRun completed 与 WorkflowRun failed 保持独立', async () => {
    const f = await fixture();
    f.version.definition.outputs[0]!.source.outputKey = 'missing';
    await expect(f.runner.start(f.input)).rejects.toMatchObject({
      code: 'WORKFLOW_OUTPUT_MISSING',
    });
    const run = await db.workflowRun.findFirstOrThrow({
      where: { workflowVersionId: f.version.id },
      include: { nodeRuns: true },
    });
    expect(run).toMatchObject({
      status: 'failed',
      outputs: null,
      error: { stage: 'resolve_output' },
    });
    expect(run.nodeRuns[0]!.status).toBe('completed');
  });

  it('编译失败按既定状态约束留下 failed 运行，不产生节点执行', async () => {
    const f = await fixture();
    f.version.definition.nodes[0]!.typeVersion = 999;
    await expect(f.runner.start(f.input)).rejects.toMatchObject({
      code: 'unavailable_type',
    });
    const run = await db.workflowRun.findFirstOrThrow({
      where: { workflowVersionId: f.version.id },
      include: { nodeRuns: true },
    });
    expect(run).toMatchObject({
      status: 'failed',
      error: { stage: 'compile' },
    });
    expect(run.nodeRuns).toEqual([]);
    expect(run.startedAt).toBeInstanceOf(Date);
  });

  it('完成记录不可用时向上抛基础设施异常，不反向 failed 或重试已完成节点', async () => {
    const f = await fixture();
    const cause = new Error('完成记录服务不可用');
    vi.spyOn(f.runs, 'markCompleted').mockRejectedValue(cause);
    const markFailed = vi.spyOn(f.runs, 'markFailed');
    await expect(f.runner.start(f.input)).rejects.toBe(cause);
    const run = await db.workflowRun.findFirstOrThrow({
      where: { workflowVersionId: f.version.id },
      include: { nodeRuns: true },
    });
    expect(run).toMatchObject({
      status: 'running',
      completedAt: null,
      outputs: null,
      error: null,
    });
    expect(run.nodeRuns[0]!.status).toBe('completed');
    expect(markFailed).not.toHaveBeenCalled();
    expect(f.execute).toHaveBeenCalledTimes(1);
  });
});

describe('真实 PostgreSQL + LangGraph WorkflowRunner 恢复', () => {
  it('waiting → running → waiting → running → completed，原 thread / 版本 / State 不变', async () => {
    const f = await resumeFixture();
    const create = vi.spyOn(f.runs, 'create');
    const first = await f.runner.start(f.input);
    const waiting = await f.runs.getById(first.workflowRunId);
    const firstValue = { approved: true, note: '继续' };
    expect(
      await f.runner.resume({
        workflowRunId: first.workflowRunId,
        value: firstValue,
      }),
    ).toEqual(first);
    const waitingAgain = await f.runs.getById(first.workflowRunId);
    expect(waitingAgain).toEqual(waiting);
    const result = await f.runner.resume({
      workflowRunId: first.workflowRunId,
      value: false,
    });
    expect(result).toMatchObject({
      workflowRunId: first.workflowRunId,
      threadId: first.threadId,
      status: 'completed',
      outputs: { answer: { value: 30 } },
    });
    const saved = await f.runs.getById(first.workflowRunId);
    expect(saved).toMatchObject({
      workflowVersionId: f.input.workflowVersionId,
      threadId: first.threadId,
      startedAt: waiting?.startedAt,
      inputs: f.input.inputs,
      status: 'completed',
    });
    expect(saved?.completedAt).toEqual(expect.any(String));
    expect(f.getVersion.mock.calls).toHaveLength(3);
    expect(f.values).toEqual([firstValue, false]);
    expect(f.prepared).toHaveBeenCalledTimes(1);
    expect(f.finish).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    const snapshot = await f.graphs[2]!.getState({
      configurable: { thread_id: first.threadId },
    });
    expect(snapshot.values.outputs.prepared.value.value).toBe(7);
    expect(snapshot.next).toEqual([]);
    expect(
      await db.nodeRun.count({ where: { workflowRunId: first.workflowRunId } }),
    ).toBe(0);
    expect(
      await db.workflowRun.count({
        where: { workflowVersionId: f.version.id },
      }),
    ).toBe(1);
  });

  it('两个请求都先读到 waiting，只有一个原子 claim 成功并 invoke 原线程', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = await resumeFixture(() => gate);
    const started = await f.runner.start(f.input);
    const other = await new WorkflowRunRepositories(database).forProject(
      ownerId,
      projectId,
    );
    const secondRunner = new DefaultWorkflowRunner(
      { getVersion: f.getVersion },
      other,
      { compile: f.compile },
      new DefaultWorkflowOutputResolver(),
    );
    let readCount = 0;
    let releaseReads!: () => void;
    const bothRead = new Promise<void>((resolve) => {
      releaseReads = resolve;
    });
    for (const repository of [f.runs, other]) {
      const read = repository.getById.bind(repository);
      vi.spyOn(repository, 'getById').mockImplementation(async (id) => {
        const run = await read(id);
        expect(run?.status).toBe('waiting');
        if (++readCount === 2) releaseReads();
        await bothRead;
        return run;
      });
    }
    const errors: unknown[] = [];
    const requests = [
      f.runner.resume({ workflowRunId: started.workflowRunId, value: 'A' }),
      secondRunner.resume({ workflowRunId: started.workflowRunId, value: 'B' }),
    ];
    const outcomes = Promise.allSettled(
      requests.map((request) =>
        request.catch((error: unknown) => {
          errors.push(error);
          throw error;
        }),
      ),
    );
    try {
      await vi.waitFor(() => expect(errors).toHaveLength(1));
      expect(errors[0]).toMatchObject({ code: 'WORKFLOW_RUN_NOT_WAITING' });
      expect(
        f.graphs
          .slice(1)
          .filter((graph) => vi.mocked(graph.invoke).mock.calls.length > 0),
      ).toHaveLength(1);
      expect(
        (
          await db.workflowRun.findUniqueOrThrow({
            where: { id: started.workflowRunId },
          })
        ).status,
      ).toBe('running');
    } finally {
      release();
      releaseReads();
      await outcomes;
    }
    const results = await outcomes;
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    expect(f.values).toHaveLength(1);
    expect(f.prepared).toHaveBeenCalledTimes(1);
    expect(
      (
        await db.workflowRun.findUniqueOrThrow({
          where: { id: started.workflowRunId },
        })
      ).status,
    ).toBe('waiting');
  });

  it('恢复后执行异常只结束同一 WorkflowRun，不创建新运行或 NodeRun 关联', async () => {
    const f = await resumeFixture();
    const first = await f.runner.start(f.input);
    await f.runner.resume({ workflowRunId: first.workflowRunId, value: true });
    const cause = new Error('provider-secret-marker');
    f.finish.mockImplementation(() => {
      throw cause;
    });
    await expect(
      f.runner.resume({ workflowRunId: first.workflowRunId, value: true }),
    ).rejects.toBe(cause);
    const run = await f.runs.getById(first.workflowRunId);
    expect(run).toMatchObject({
      status: 'failed',
      threadId: first.threadId,
      workflowVersionId: f.input.workflowVersionId,
      error: { stage: 'invoke' },
    });
    expect(JSON.stringify(run)).not.toContain('provider-secret-marker');
    expect(
      await db.workflowRun.count({
        where: { workflowVersionId: f.version.id },
      }),
    ).toBe(1);
    expect(
      await db.nodeRun.count({ where: { workflowRunId: first.workflowRunId } }),
    ).toBe(0);
  });
});
