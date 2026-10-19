import type {
  NodeDefinition,
  WorkflowRunMetadata,
  WorkflowVersionMetadata,
} from '@dramaflow/contracts';
import type { RunnableConfig } from '@langchain/core/runnables';
import {
  Annotation,
  Command,
  END,
  interrupt,
  MemorySaver,
  Send,
  START,
  StateGraph,
} from '@langchain/langgraph';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  applyNodePreset,
  createOperationNodeType,
  createWorkflowRunConfig,
  NodeRegistry,
  parseNodeDefinition,
  type CompileContext,
  type NodeType,
  type NodeOperation,
  type NodeContract,
} from '../src/index.js';

// 以下 State、编译器和操作只用于验证适配边界，不注册任何生产节点或能力。
const TestState = Annotation.Root({
  value: Annotation<unknown>(),
  results: Annotation<Record<string, z.JSONType>>({
    reducer: (left, right) => ({ ...left, ...right }),
    default: () => ({}),
  }),
});
type TestStateValue = typeof TestState.State;
type TestStateUpdate = typeof TestState.Update;

const contract = {
  type: 'test.operation',
  version: 1,
  inputSchema: z.object({ value: z.number().int() }),
  outputSchema: z.object({ value: z.number(), label: z.string() }),
  configSchema: z.object({
    multiplier: z.number().finite(),
    label: z.string(),
  }),
};
type TestOperation = NodeOperation<
  z.output<typeof contract.inputSchema>,
  z.output<typeof contract.configSchema>
>;

function definition() {
  return {
    id: 'operation',
    type: contract.type,
    typeVersion: contract.version,
    preset: 'test-preset',
    name: '测试值操作',
    inputs: {},
    ui: { position: { x: 0, y: 0 } },
    config: { multiplier: 2, label: '原始配置' },
  } satisfies NodeDefinition;
}

const context: CompileContext<TestStateValue, TestStateUpdate> = {
  readInputs: (state) => ({ value: state.value }),
  writeOutputs: (node, outputs) => ({ results: { [node.id]: outputs } }),
};

const operation: TestOperation = ({ inputs, config }) => ({
  value: inputs.value * config.multiplier,
  label: config.label,
});

// 这些显式测试端口使用测试领域类型；真实端口类型在专门的声明测试中验证。
function createTestNodeType<I extends z.ZodObject, O extends z.ZodObject, C extends z.ZodObject>(
  values: NodeContract<I, O, C>,
  operation: NodeOperation<z.output<I>, z.output<C>>,
) {
  const port = (key: string) => ({
    key,
    name: key,
    dataType: { kind: 'domain' as const, name: 'test.value' },
  });
  return createOperationNodeType(
    {
      type: values.type,
      version: values.version,
      metadata: { name: '测试操作', category: 'data' },
      inputs: Object.keys(values.inputSchema.shape).map(port),
      outputs: Object.keys(values.outputSchema.shape).map(port),
      config: Object.keys(values.configSchema.shape).map((key) => ({
        key,
        name: key,
        type:
          key === 'multiplier' || key === 'offset' || key === 'defaultOffset'
            ? ('number' as const)
            : ('string' as const),
      })),
    },
    values,
    operation,
  );
}

function operationGraph(nodeOperation: TestOperation, node = definition()) {
  const registry = new NodeRegistry<TestStateValue, TestStateUpdate>([
    createTestNodeType(contract, nodeOperation),
  ]);
  return new StateGraph(TestState)
    .addNode('operation', registry.compile(node, context))
    .addEdge(START, 'operation')
    .addEdge('operation', END)
    .compile();
}

describe('NodeCompiler 与原生 LangGraph 的适配', () => {
  it('编译不执行，产物直接加入 StateGraph，原定义的后续修改不影响已编译配置', async () => {
    const node = definition();
    const invoke = vi.fn(operation);
    const graph = operationGraph(invoke, node);
    expect(invoke).not.toHaveBeenCalled();

    node.id = 'changed';
    node.config.multiplier = 100;
    node.config.label = '修改后的配置';

    const result = await graph.invoke({ value: 3 });
    expect(result.results).toEqual({ operation: { value: 6, label: '原始配置' } });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(Object.keys(invoke.mock.calls[0]![0])).toEqual(['inputs', 'config']);
  });

  it('未知类型和未知版本拒绝编译，Preset 不成为额外运行身份', () => {
    const registry = new NodeRegistry<TestStateValue, TestStateUpdate>([
      createTestNodeType(contract, operation),
    ]);
    for (const node of [
      { ...definition(), type: 'test.unavailable' },
      { ...definition(), typeVersion: 2 },
    ]) {
      expect(() => registry.compile(node, context)).toThrow(
        expect.objectContaining({ code: 'unavailable_type' }),
      );
    }
    expect(() =>
      registry.compile({ ...definition(), preset: 'another-config-template' }, context),
    ).not.toThrow();
  });

  it('同一类型版本的重复实现不能覆盖已有注册', () => {
    const compiler = createTestNodeType(contract, operation);
    expect(() => new NodeRegistry<TestStateValue, TestStateUpdate>([compiler, compiler])).toThrow(
      expect.objectContaining({ code: 'duplicate_type' }),
    );
  });

  it('编译时拒绝非法配置，调用时拒绝非法输入，均不调用值操作', async () => {
    const invoke = vi.fn(operation);
    const registry = new NodeRegistry<TestStateValue, TestStateUpdate>([
      createTestNodeType(contract, invoke),
    ]);
    expect(() =>
      registry.compile({ ...definition(), config: { multiplier: '2' } }, context),
    ).toThrow(z.ZodError);

    const graph = operationGraph(invoke);
    await expect(graph.invoke({ value: '错误类型' })).rejects.toBeInstanceOf(z.ZodError);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('输出契约错误使原生图调用失败，不产生成功结果', async () => {
    const invoke = vi.fn(() => ({ value: '错误类型', label: '测试' }));
    await expect(operationGraph(invoke).invoke({ value: 1 })).rejects.toBeInstanceOf(z.ZodError);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('操作异常交给 LangGraph 传播，适配器不隐藏错误或自行重试', async () => {
    const failure = new Error('测试受理结果不明');
    const invoke = vi.fn(() => {
      throw failure;
    });
    await expect(operationGraph(invoke).invoke({ value: 1 })).rejects.toBe(failure);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('保留 LangGraph 传入的配置对象，并向 Binding、操作和写出边界透传', async () => {
    const config = {
      configurable: { thread_id: 'test-direct-thread' },
      maxConcurrency: 3,
      signal: new AbortController().signal,
    };
    const readInputs = vi.fn(context.readInputs);
    const writeOutputs = vi.fn(context.writeOutputs);
    const invoke = vi.fn(operation);
    const registry = new NodeRegistry<TestStateValue, TestStateUpdate>([
      createTestNodeType(contract, invoke),
    ]);
    const node = registry.compile(definition(), { readInputs, writeOutputs });

    await node({ value: 4, results: {} }, config);

    expect(readInputs.mock.calls[0]?.[2]).toBe(config);
    expect(invoke.mock.calls[0]?.[1]).toBe(config);
    expect(writeOutputs.mock.calls[0]?.[2]).toBe(config);
    expect(invoke.mock.calls[0]?.[1]?.signal).toBe(config.signal);
  });

  it('真实图执行保留 thread_id、图并发上限和取消信号', async () => {
    let received: RunnableConfig | undefined;
    const graph = operationGraph((parameters, config) => {
      received = config;
      return operation(parameters, config);
    });
    await graph.invoke(
      { value: 2 },
      {
        configurable: { thread_id: 'test-graph-thread' },
        maxConcurrency: 2,
        signal: new AbortController().signal,
      },
    );
    expect(received?.configurable?.thread_id).toBe('test-graph-thread');
    expect(received?.maxConcurrency).toBe(2);
    expect(received?.signal).toBeInstanceOf(AbortSignal);
    expect(received?.signal?.aborted).toBe(false);
  });
});

describe('序列化配置与操作有效值的转换边界', () => {
  const transformedContract = {
    type: 'test.transform',
    version: 1,
    inputSchema: z.object({ value: z.number() }),
    outputSchema: z.object({
      value: z.number(),
      factor: z.number(),
      offset: z.number(),
      defaultOffset: z.number(),
    }),
    configSchema: z.object({
      factor: z.string().regex(/^\d+$/).transform(Number),
      offset: z.number().transform((value) => value + 1),
      defaultOffset: z
        .number()
        .default(1)
        .transform((value) => value + 1),
    }),
  };
  const transformOperation: NodeOperation<
    z.output<typeof transformedContract.inputSchema>,
    z.output<typeof transformedContract.configSchema>
  > = ({ inputs, config }) => ({
    value: inputs.value * config.factor + config.offset + config.defaultOffset,
    ...config,
  });

  it('定义校验和编译保留原始配置，重复调用及重新编译不累积转换或默认值', async () => {
    const node = {
      id: 'transform',
      type: transformedContract.type,
      typeVersion: transformedContract.version,
      preset: 'test-transform-preset',
      name: '测试配置转换',
      inputs: {},
      ui: { position: { x: 0, y: 0 } },
      config: { factor: '2', offset: 3 },
    };
    const parsed = parseNodeDefinition(transformedContract, node);
    expect(parsed.config).toEqual({ factor: '2', offset: 3 });
    expect(parsed.config).not.toBe(node.config);
    const invoke = vi.fn(transformOperation);
    const registry = new NodeRegistry<TestStateValue, TestStateUpdate>([
      createTestNodeType(transformedContract, invoke),
    ]);
    const graph = new StateGraph(TestState)
      .addNode('transform', registry.compile(parsed, context))
      .addEdge(START, 'transform')
      .addEdge('transform', END)
      .compile();
    expect(invoke).not.toHaveBeenCalled();

    for (const value of [2, 3]) {
      const result = await graph.invoke({ value });
      expect(result.results).toEqual({
        transform: { value: value * 2 + 6, factor: 2, offset: 4, defaultOffset: 2 },
      });
    }
    await registry.compile(parsed, context)({ value: 2, results: {} }, {});

    expect(invoke).toHaveBeenCalledTimes(3);
    for (const [parameters] of invoke.mock.calls) {
      expect(parameters.config).toEqual({ factor: 2, offset: 4, defaultOffset: 2 });
    }
    expect(node.config).toEqual({ factor: '2', offset: 3 });
    expect(parsed.config).toEqual({ factor: '2', offset: 3 });
  });

  it('Preset 合并只保存原始配置覆盖，后续编译和调用仍只应用一次有效转换', async () => {
    const source = {
      id: 'preset-transform',
      type: transformedContract.type,
      typeVersion: transformedContract.version,
      name: '测试 Preset 配置转换',
      inputs: {},
      ui: { position: { x: 0, y: 0 } },
      config: { offset: 20 },
    };
    const preset = {
      id: 'test-transform-preset',
      type: transformedContract.type,
      typeVersion: transformedContract.version,
      name: '测试转换预设',
      config: { factor: '3', offset: 10 },
    };
    const applied = applyNodePreset(transformedContract, source, preset);
    expect(applied.config).toEqual({ factor: '3', offset: 20 });
    const invoke = vi.fn(transformOperation);
    const registry = new NodeRegistry<TestStateValue, TestStateUpdate>([
      createTestNodeType(transformedContract, invoke),
    ]);
    const graph = new StateGraph(TestState)
      .addNode('transform', registry.compile(applied, context))
      .addEdge(START, 'transform')
      .addEdge('transform', END)
      .compile();

    for (let invocation = 0; invocation < 2; invocation += 1) {
      const result = await graph.invoke({ value: 1 });
      expect(result.results).toEqual({
        'preset-transform': { value: 26, factor: 3, offset: 21, defaultOffset: 2 },
      });
    }
    for (const [parameters] of invoke.mock.calls) {
      expect(parameters.config).toEqual({ factor: 3, offset: 21, defaultOffset: 2 });
    }
    expect(applied.config).toEqual({ factor: '3', offset: 20 });
    expect(source.config).toEqual({ offset: 20 });
    expect(preset.config).toEqual({ factor: '3', offset: 10 });
  });
});

describe('原生 Interrupt、Command 和 Checkpoint', () => {
  it('显式测试编译器直接中断并用同一 thread 恢复，其他 thread 保持隔离', async () => {
    const entered = vi.fn();
    const reviewCompiler: NodeType<TestStateValue, TestStateUpdate> = {
      manifest: {
        type: 'test.review',
        version: 1,
        metadata: { name: '测试审核', category: 'flow' },
        inputs: [{ key: 'value', name: '测试值', dataType: { kind: 'number' } }],
        outputs: [
          { key: 'approved', name: '审核结果', dataType: { kind: 'boolean' } },
          { key: 'value', name: '测试值', dataType: { kind: 'number' } },
        ],
        config: [],
      },
      inputSchema: z.object({ value: z.number() }),
      outputSchema: z.object({ approved: z.boolean(), value: z.number() }),
      configSchema: z.object({}),
      compile: (node) => (state) => {
        entered();
        const feedback = z
          .object({ approved: z.boolean() })
          .strict()
          .parse(
            interrupt<{ nodeId: string; value: unknown }, unknown>({
              nodeId: node.id,
              value: state.value,
            }),
          );
        return new Command({
          update: {
            results: {
              [node.id]: { approved: feedback.approved, value: z.number().parse(state.value) },
            },
          },
          goto: END,
        });
      },
    };
    const registry = new NodeRegistry<TestStateValue, TestStateUpdate>([reviewCompiler]);
    const review = registry.compile(
      {
        id: 'review',
        type: 'test.review',
        typeVersion: 1,
        name: '测试审核',
        inputs: {},
        ui: { position: { x: 0, y: 0 } },
        config: {},
      },
      context,
    );
    const graph = new StateGraph(TestState)
      .addNode('review', review, { ends: [END] })
      .addEdge(START, 'review')
      // MemorySaver 明确只用于本测试；不宣称进程重启或生产持久化已实现。
      .compile({ checkpointer: new MemorySaver() });
    const firstConfig = { configurable: { thread_id: 'test-review-first' } };
    const secondConfig = { configurable: { thread_id: 'test-review-second' } };

    const paused = await graph.invoke({ value: 10 }, firstConfig);
    expect(paused).toMatchObject({
      results: {},
      __interrupt__: [{ value: { nodeId: 'review', value: 10 } }],
    });
    await graph.invoke({ value: 20 }, secondConfig);
    expect(entered).toHaveBeenCalledTimes(2);

    const resumed = await graph.invoke(new Command({ resume: { approved: true } }), firstConfig);
    expect(resumed.results).toEqual({ review: { approved: true, value: 10 } });
    // 恢复从节点开头重跑，适配器没有吞掉 Interrupt 或构造自己的恢复状态机。
    expect(entered).toHaveBeenCalledTimes(3);
    expect((await graph.getState(firstConfig)).tasks).toHaveLength(0);
    const secondSnapshot = await graph.getState(secondConfig);
    expect(secondSnapshot.tasks).toHaveLength(1);
    expect(secondSnapshot.tasks[0]?.interrupts).toHaveLength(1);

    const secondResumed = await graph.invoke(
      new Command({ resume: { approved: false } }),
      secondConfig,
    );
    expect(secondResumed.results).toEqual({ review: { approved: false, value: 20 } });
  });
});

describe('原生 Send 和 State reducer', () => {
  it('动态分派使用同一个编译产物，由 LangGraph 调度并通过 reducer 汇总结果', async () => {
    const BatchTestState = Annotation.Root({
      items: Annotation<number[]>(),
      value: Annotation<unknown>(),
      results: Annotation<z.JSONType[]>({
        reducer: (left, right) => left.concat(right),
        default: () => [],
      }),
    });
    const batchContext: CompileContext<typeof BatchTestState.State, typeof BatchTestState.Update> =
      {
        readInputs: (state) => ({ value: state.value }),
        writeOutputs: (_node, outputs) => ({ results: [outputs] }),
      };
    let active = 0;
    let peak = 0;
    const invoke = vi.fn<TestOperation>(async (parameters, config) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const output = await operation(parameters, config);
      active -= 1;
      return output;
    });
    const registry = new NodeRegistry<typeof BatchTestState.State, typeof BatchTestState.Update>([
      createTestNodeType(contract, invoke),
    ]);
    const graph = new StateGraph(BatchTestState)
      .addNode('dispatch', () => ({}))
      .addNode('process', registry.compile(definition(), batchContext))
      .addEdge(START, 'dispatch')
      .addConditionalEdges(
        'dispatch',
        (state) => state.items.map((value) => new Send('process', { value })),
        ['process'],
      )
      .addEdge('process', END)
      .compile();

    const result = await graph.invoke({ items: [1, 2, 3, 4] }, { maxConcurrency: 2 });
    expect(
      z
        .array(contract.outputSchema)
        .parse(result.results)
        .sort((left, right) => left.value - right.value),
    ).toEqual([
      { value: 2, label: '原始配置' },
      { value: 4, label: '原始配置' },
      { value: 6, label: '原始配置' },
      { value: 8, label: '原始配置' },
    ]);
    expect(invoke).toHaveBeenCalledTimes(4);
    expect(peak).toBe(2);
    expect(active).toBe(0);
  });
});

describe('WorkflowRun 与 LangGraph thread 配置', () => {
  const run: WorkflowRunMetadata = {
    id: 'run-1',
    workflowId: 'workflow-1',
    workflowVersionId: 'version-1',
    status: 'pending',
  };
  const version: WorkflowVersionMetadata = {
    id: 'version-1',
    workflowId: 'workflow-1',
    version: 1,
    publishedAt: '2026-10-19T00:00:00.000Z',
  };

  it('校验版本后绑定 Run.id，保留顶层并发、取消和其他配置，不修改调用方', () => {
    const signal = new AbortController().signal;
    const original = { maxConcurrency: 3, signal, configurable: { requestId: 'request-1' } };
    const result = createWorkflowRunConfig(run, version, original);
    expect(result).toEqual({
      maxConcurrency: 3,
      signal,
      configurable: { requestId: 'request-1', thread_id: run.id },
    });
    expect(result.signal).toBe(signal);
    expect(original.configurable).toEqual({ requestId: 'request-1' });
    expect(createWorkflowRunConfig(run, version).configurable?.thread_id).toBe(run.id);
  });

  it('明确传入相同 thread 时接受，拒绝把 Run 绑定到其他 thread', () => {
    expect(
      createWorkflowRunConfig(run, version, { configurable: { thread_id: run.id } }).configurable
        ?.thread_id,
    ).toBe(run.id);
    for (const threadId of ['foreign-thread', '', 123]) {
      expect(() =>
        createWorkflowRunConfig(run, version, { configurable: { thread_id: threadId } }),
      ).toThrow('thread_id 必须与 WorkflowRun.id 一致');
    }
  });

  it('工作流身份或版本不匹配时拒绝生成配置', () => {
    for (const invalidRun of [
      { ...run, workflowId: 'workflow-2' },
      { ...run, workflowVersionId: 'version-2' },
    ]) {
      expect(() => createWorkflowRunConfig(invalidRun, version)).toThrow(
        expect.objectContaining({ code: 'version_mismatch' }),
      );
    }
  });

  it('绑定前校验运行与版本元数据，不接受空标识或非法版本号', () => {
    expect(() => createWorkflowRunConfig({ ...run, id: '' }, version)).toThrow(z.ZodError);
    expect(() => createWorkflowRunConfig(run, { ...version, version: 0 })).toThrow(z.ZodError);
  });
});
