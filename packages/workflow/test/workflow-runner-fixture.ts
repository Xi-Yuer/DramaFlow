import {
  NumberType,
  StringType,
  type NodeDefinition,
  type WorkflowRun,
} from '@dramaflow/contracts';
import { MemorySaver } from '@langchain/langgraph';
import { vi } from 'vitest';
import { z } from 'zod';
import {
  createBindingResolver,
  DefaultDataStoragePolicyResolver,
  DefaultNodeExecutor,
  DefaultRuntimeValueCodec,
  DefaultWorkflowCompiler,
  DefaultWorkflowOutputResolver,
  DefaultWorkflowRunner,
  DefaultWorkflowRunSubmissionService,
  NodeRegistry,
  type CompiledWorkflow,
  type WorkflowCompiler,
  type WorkflowRunRepository,
  type WorkflowVersionRecord,
  type WorkflowVersionRepository,
  type StartWorkflowRunInput,
} from '../src/index.js';
import { auditedNodeRunRepositoryFixture } from './node-run-fixture.js';

export function workflowRunnerFixture() {
  const order: string[] = [];
  let stored: WorkflowRun | null = null;
  const node: NodeDefinition = {
    id: 'sum',
    type: 'math.add',
    typeVersion: 1,
    name: '加法',
    inputs: { a: { type: 'workflow_input', key: 'a' }, b: { type: 'constant', value: 20 } },
    config: {},
    ui: { position: { x: 0, y: 0 } },
  };
  const version: WorkflowVersionRecord = {
    id: 'version-3',
    projectId: 'project-1',
    workflowId: 'workflow-1',
    version: 3,
    publishedAt: '2026-10-20T00:00:00.000Z',
    definition: {
      inputs: [{ name: 'a', type: NumberType, required: true }],
      nodes: [node],
      edges: [],
      outputs: [
        { name: 'answer', type: NumberType, source: { nodeId: 'sum', outputKey: 'result' } },
      ],
    },
  };
  const input = {
    projectId: version.projectId,
    workflowId: version.workflowId,
    workflowVersionId: version.id,
    invocationKey: 'invocation-1',
    inputs: { a: { storage: 'inline' as const, type: NumberType, value: 10 } },
  };
  const getVersion = vi
    .fn<WorkflowVersionRepository['getVersion']>()
    .mockImplementation(async () => {
      order.push('load_version');
      return version;
    });
  const runs = {
    create: vi.fn<WorkflowRunRepository['create']>().mockImplementation(async (request) => {
      order.push('create');
      stored = {
        ...structuredClone(request),
        id: 'run-1',
        threadId: 'thread-7',
        status: 'pending',
        createdAt: '2026-10-20T00:00:00.000Z',
      };
      return structuredClone(stored);
    }),
    getById: vi.fn<WorkflowRunRepository['getById']>().mockImplementation(async (id) => {
      order.push('get_run');
      return stored?.id === id ? structuredClone(stored) : null;
    }),
    claimPendingForStart: vi
      .fn<WorkflowRunRepository['claimPendingForStart']>()
      .mockImplementation(async (id) => {
        order.push('claim_start');
        if (!stored || stored.id !== id || stored.status !== 'pending') return null;
        stored.status = 'running';
        stored.startedAt = '2026-10-20T00:00:01.000Z';
        return structuredClone(stored);
      }),
    claimWaitingForResume: vi
      .fn<WorkflowRunRepository['claimWaitingForResume']>()
      .mockImplementation(async (id) => {
        order.push('claim');
        if (!stored || stored.id !== id || stored.status !== 'waiting') return null;
        stored.status = 'running';
        return structuredClone(stored);
      }),
    markRunning: vi.fn<WorkflowRunRepository['markRunning']>().mockImplementation(async () => {
      order.push('running');
      if (stored) {
        stored.status = 'running';
        stored.startedAt ??= '2026-10-20T00:00:01.000Z';
      }
    }),
    markWaiting: vi.fn<WorkflowRunRepository['markWaiting']>().mockImplementation(async () => {
      order.push('waiting');
      if (stored) stored.status = 'waiting';
    }),
    markCompleted: vi
      .fn<WorkflowRunRepository['markCompleted']>()
      .mockImplementation(async (_id, outputs) => {
        order.push('completed');
        if (stored) {
          stored.status = 'completed';
          stored.outputs = structuredClone(outputs);
          stored.completedAt = '2026-10-20T00:00:02.000Z';
        }
      }),
    markFailed: vi
      .fn<WorkflowRunRepository['markFailed']>()
      .mockImplementation(async (_id, error) => {
        order.push('failed');
        if (stored) {
          stored.status = 'failed';
          stored.error = error;
          stored.completedAt = '2026-10-20T00:00:02.000Z';
        }
      }),
    markCancelled: vi.fn<WorkflowRunRepository['markCancelled']>(),
  } satisfies WorkflowRunRepository;
  const nodeRuns = auditedNodeRunRepositoryFixture();
  const execute = vi.fn(async (values: { a: number; b: number }) => {
    order.push('execute');
    return { result: values.a + values.b, internal: '内部数据' };
  });
  const registry = new NodeRegistry([
    {
      manifest: {
        type: node.type,
        version: 1,
        executionKind: 'action',
        metadata: { name: node.name, category: 'data' },
        inputs: [
          { key: 'a', name: 'A', dataType: NumberType },
          { key: 'b', name: 'B', dataType: NumberType },
        ],
        outputs: [
          { key: 'result', name: '结果', dataType: NumberType },
          { key: 'internal', name: '内部', dataType: StringType },
        ],
        config: [],
      },
      inputSchema: z.object({ a: z.number(), b: z.number() }),
      outputSchema: z.object({ result: z.number(), internal: z.string() }),
      configSchema: z.object({}).strict(),
      execute,
    },
  ]);
  const codec = new DefaultRuntimeValueCodec(
    { resolve: vi.fn() },
    { write: vi.fn() },
    new DefaultDataStoragePolicyResolver(),
  );
  const bindings = createBindingResolver();
  const executor = new DefaultNodeExecutor(registry, bindings, codec, nodeRuns);
  const checkpointer = new MemorySaver(); // 仅测试，生产调用必须明确注入持久 Checkpointer。
  const executorFactory = vi.fn(async (_run: WorkflowRun) => executor);
  const compiler = new DefaultWorkflowCompiler(
    registry,
    executorFactory,
    checkpointer,
    async () => ({ bindings, codec }),
    async () => nodeRuns,
  );
  const graphs: CompiledWorkflow[] = [];
  const compile = vi
    .fn<WorkflowCompiler['compile']>()
    .mockImplementation(async (definition, run) => {
      order.push('compile');
      const graph = await compiler.compile(definition, run);
      const invoke = graph.invoke.bind(graph);
      vi.spyOn(graph, 'invoke').mockImplementation(async (state, config) => {
        order.push('invoke');
        return invoke(state, config);
      });
      graphs.push(graph);
      return graph;
    });
  const resolver = new DefaultWorkflowOutputResolver();
  const resolveOutputs = resolver.resolve.bind(resolver);
  const resolve = vi.spyOn(resolver, 'resolve').mockImplementation((definition, state) => {
    order.push('resolve_output');
    return resolveOutputs(definition, state);
  });
  const runner = new DefaultWorkflowRunner({ getVersion }, runs, { compile }, resolver);
  let intent = 0;
  const submissionRepository = {
    createWithExecution: vi.fn(async (request: Parameters<typeof runs.create>[0]) => {
      if (
        stored &&
        stored.workflowId === request.workflowId &&
        stored.invocationKey === request.invocationKey
      )
        return { run: structuredClone(stored), created: false };
      return { run: await runs.create(request), created: true };
    }),
    async createResumeExecution(request: { workflowRunId: string; value: unknown }) {
      const run = await runs.getById(request.workflowRunId);
      if (!run || run.status !== 'waiting') throw new Error('运行不在 waiting');
      return {
        kind: 'resume' as const,
        workflowRunId: run.id,
        executionId: `execution-${++intent}`,
        value: request.value,
      };
    },
  };
  const submission = new DefaultWorkflowRunSubmissionService({ getVersion }, submissionRepository);
  const start = async (request: StartWorkflowRunInput) => {
    const pending = await submission.start(request);
    return runner.executeStart(pending.id);
  };
  return {
    start,
    submission,
    submissionRepository,
    runner,
    input,
    version,
    runs,
    nodeRuns,
    getVersion,
    compile,
    execute,
    executor,
    bindings,
    codec,
    executorFactory,
    graphs,
    checkpointer,
    resolve,
    order,
    node,
    registry,
  };
}
