import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Annotation,
  Command,
  END,
  GraphInterrupt,
  interrupt,
  MemorySaver,
  ParentCommand,
  START,
  StateGraph,
} from '@langchain/langgraph';
import {
  NumberType,
  StringType,
  type NodeDefinition,
  type NodeTypeManifest,
} from '@dramaflow/contracts';
import {
  BindingResolutionError,
  createBindingResolver,
  DefaultNodeExecutor,
  DefaultRuntimeValueCodec,
  NodeExecutionError,
  NodeRegistry,
  ReferenceResolutionError,
  type DataReferenceResolver,
  type NodeExecutionContext,
  type NodeExecutionStage,
} from '../src/index.js';

function fixture() {
  const node: NodeDefinition = {
    id: 'sum',
    type: 'math.add',
    typeVersion: 1,
    name: '加法',
    inputs: { a: { type: 'workflow_input', key: 'a' }, b: { type: 'constant', value: 20 } },
    config: {},
    ui: { position: { x: 0, y: 0 } },
  };
  const manifest: NodeTypeManifest = {
    type: node.type,
    version: 1,
    executionKind: 'action',
    metadata: { name: '加法', category: 'data' },
    inputs: [
      { key: 'a', name: 'A', dataType: NumberType },
      { key: 'b', name: 'B', dataType: NumberType },
    ],
    outputs: [{ key: 'result', name: '结果', dataType: NumberType }],
    config: [],
  };
  const schemas = {
    inputSchema: z.object({ a: z.number(), b: z.number() }).strict(),
    configSchema: z.object({}).strict(),
    outputSchema: z.object({ result: z.number() }).strict(),
  };
  const execute = vi.fn(
    async (
      input: { a: number; b: number },
      _config: unknown,
      _context: NodeExecutionContext,
    ): Promise<unknown> => ({ result: input.a + input.b }),
  );
  const registry = new NodeRegistry([{ manifest, ...schemas, execute }]);
  const get = vi.spyOn(registry, 'get');
  const bindings = createBindingResolver();
  const resolveInputs = vi.spyOn(bindings, 'resolveInputs');
  const referenceResolver = {
    resolve: vi.fn<DataReferenceResolver['resolve']>().mockRejectedValue(new Error('不应解析引用')),
  };
  const codec = new DefaultRuntimeValueCodec(referenceResolver);
  const decodeRecord = vi.spyOn(codec, 'decodeRecord');
  const inputParse = vi.spyOn(schemas.inputSchema, 'parse');
  const configParse = vi.spyOn(schemas.configSchema, 'parse');
  const outputParse = vi.spyOn(schemas.outputSchema, 'parse');
  const executor = new DefaultNodeExecutor(registry, bindings, codec);
  const context: NodeExecutionContext = {
    projectId: 'p',
    workflowRunId: 'r',
    workflow: {
      inputs: [{ name: 'a', type: NumberType }],
      nodes: [node],
      edges: [],
      outputs: [],
    },
    state: {
      run: { projectId: 'p', workflowId: 'w', workflowVersionId: 'v', workflowRunId: 'r' },
      inputs: { a: { storage: 'inline', type: NumberType, value: 10 } },
      outputs: {},
      variables: {},
      execution: {},
    },
  };
  return {
    node,
    manifest,
    schemas,
    registry,
    get,
    bindings,
    resolveInputs,
    referenceResolver,
    codec,
    decodeRecord,
    inputParse,
    configParse,
    execute,
    outputParse,
    executor,
    context,
  };
}

describe('普通 Action Node 执行主链', () => {
  it('math.add 严格依次经过 Registry、Binding、Decode、三组 Schema 和业务调用，只返回业务输出', async () => {
    const f = fixture();
    const snapshot = structuredClone({ node: f.node, context: f.context });
    expect(await f.executor.execute(f.node, f.context)).toEqual({ output: { result: 30 } });
    const pipeline = [
      f.get,
      f.resolveInputs,
      f.decodeRecord,
      f.inputParse,
      f.configParse,
      f.execute,
      f.outputParse,
    ];
    for (const step of pipeline) expect(step).toHaveBeenCalledTimes(1);
    const order = pipeline.flatMap((step) => step.mock.invocationCallOrder);
    expect(order).toEqual(order.toSorted((a, b) => a - b));
    expect(f.get).toHaveBeenCalledWith('math.add', 1);
    expect(f.resolveInputs).toHaveBeenCalledWith({
      node: f.node,
      nodeType: f.manifest,
      edges: f.context.workflow.edges,
      state: f.context.state,
    });
    expect(f.decodeRecord).toHaveBeenCalledWith(
      {
        a: { storage: 'inline', type: NumberType, value: 10 },
        b: { storage: 'inline', type: NumberType, value: 20 },
      },
      { projectId: 'p', workflowRunId: 'r' },
    );
    expect(f.execute).toHaveBeenCalledWith({ a: 10, b: 20 }, {}, f.context);
    expect(f.referenceResolver.resolve).not.toHaveBeenCalled();
    expect({ node: f.node, context: f.context }).toEqual(snapshot);
    expect(f.context.state.outputs).toEqual({});
  });

  it('精确选择 typeVersion，不静默回退版本或业务类型', async () => {
    const f = fixture();
    const second = vi.fn(async () => ({ result: 200 }));
    f.registry.register({ ...f.schemas, manifest: { ...f.manifest, version: 2 }, execute: second });
    expect(await f.executor.execute({ ...f.node, typeVersion: 2 }, f.context)).toEqual({
      output: { result: 200 },
    });
    expect(f.execute).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('使用 Schema 的转换和默认值，不修改 NodeDefinition 或 State', async () => {
    const f = fixture();
    const schemas = {
      inputSchema: z.object({ a: z.coerce.number(), b: z.number() }),
      configSchema: z.object({ factor: z.number().default(2) }),
      outputSchema: z.object({ result: z.number().transform((value) => value + 1) }),
    };
    const execute = vi.fn(async (input: { a: number; b: number }, config: { factor: number }) => ({
      result: (input.a + input.b) * config.factor,
    }));
    const registry = new NodeRegistry([
      {
        ...schemas,
        manifest: { ...f.manifest, config: [{ key: 'factor', name: '倍数', type: 'number' }] },
        execute,
      },
    ]);
    const context: NodeExecutionContext = {
      ...f.context,
      state: {
        ...f.context.state,
        inputs: { a: { storage: 'inline', type: StringType, value: '10' } },
      },
    };
    const snapshot = structuredClone({ node: f.node, context });
    const executor = new DefaultNodeExecutor(registry, f.bindings, f.codec);
    expect(await executor.execute(f.node, context)).toEqual({ output: { result: 61 } });
    expect(execute).toHaveBeenCalledWith({ a: 10, b: 20 }, { factor: 2 }, context);
    expect({ node: f.node, context }).toEqual(snapshot);
  });
});

describe('NodeExecutor 错误阶段', () => {
  it.each<NodeExecutionStage>([
    'resolve_input',
    'decode_input',
    'validate_input',
    'validate_config',
    'execute',
    'validate_output',
  ])('失败准确标记 %s，保留 cause，并停止后续步骤', async (stage) => {
    const f = fixture();
    let context = f.context;
    let cause: unknown;
    switch (stage) {
      case 'resolve_input':
        cause = new BindingResolutionError('WORKFLOW_INPUT_MISSING', '缺失输入', {
          nodeId: 'sum',
          inputKey: 'a',
          workflowInputKey: 'a',
        });
        f.resolveInputs.mockRejectedValue(cause);
        break;
      case 'decode_input':
        cause = new ReferenceResolutionError({ kind: 'asset', id: 'asset', versionId: 'v3' });
        f.decodeRecord.mockRejectedValue(cause);
        break;
      case 'validate_input':
        context = {
          ...context,
          state: {
            ...context.state,
            inputs: { a: { storage: 'inline', type: StringType, value: '不是数字' } },
          },
        };
        break;
      case 'validate_config':
        f.node.config = { unexpected: true };
        break;
      case 'execute':
        cause = new Error('业务执行失败');
        f.execute.mockRejectedValue(cause);
        break;
      case 'validate_output':
        f.execute.mockResolvedValue({ result: '不是数字' });
        break;
    }
    const invocation = f.executor.execute(f.node, context);
    await expect(invocation).rejects.toBeInstanceOf(NodeExecutionError);
    await expect(invocation).rejects.toMatchObject({ nodeId: 'sum', nodeType: 'math.add', stage });
    if (stage.startsWith('validate_')) {
      await expect(invocation).rejects.toHaveProperty('cause', expect.any(z.ZodError));
    } else {
      await expect(invocation).rejects.toHaveProperty('cause', cause);
    }
    if (stage === 'validate_input')
      await expect(invocation).rejects.toHaveProperty('code', 'NODE_INPUT_VALIDATION_FAILED');
    const steps = [
      f.resolveInputs,
      f.decodeRecord,
      f.inputParse,
      f.configParse,
      f.execute,
      f.outputParse,
    ];
    const stages: NodeExecutionStage[] = [
      'resolve_input',
      'decode_input',
      'validate_input',
      'validate_config',
      'execute',
      'validate_output',
    ];
    for (const step of steps.slice(stages.indexOf(stage) + 1)) expect(step).not.toHaveBeenCalled();
    expect(f.context.state.outputs).toEqual({});
  });

  it('Registry 缺少精确版本时在 resolve_input 阶段失败，不进入绑定', async () => {
    const f = fixture();
    await expect(
      f.executor.execute({ ...f.node, typeVersion: 99 }, f.context),
    ).rejects.toMatchObject({ stage: 'resolve_input', cause: { code: 'unavailable_type' } });
    expect(f.resolveInputs).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
  });

  it.each(['control', 'composite', 'interaction'] as const)(
    '拒绝 %s 类型，不套普通 Action 管线',
    async (executionKind) => {
      const f = fixture();
      const registry = new NodeRegistry([
        { ...f.schemas, manifest: { ...f.manifest, executionKind } },
      ]);
      const executor = new DefaultNodeExecutor(registry, f.bindings, f.codec);
      await expect(executor.execute(f.node, f.context)).rejects.toMatchObject({
        stage: 'resolve_input',
      });
      expect(f.resolveInputs).not.toHaveBeenCalled();
      expect(f.decodeRecord).not.toHaveBeenCalled();
    },
  );

  it.each<{ cause: unknown }>([{ cause: null }, { cause: undefined }, { cause: '非 Error 异常' }])(
    '非 Error 异常也保留原始 cause：$cause',
    async ({ cause }) => {
      const f = fixture();
      f.execute.mockRejectedValue(cause);
      await expect(f.executor.execute(f.node, f.context)).rejects.toMatchObject({
        stage: 'execute',
        cause,
      });
      expect(f.execute).toHaveBeenCalledTimes(1);
    },
  );
});

describe('LangGraph 原生控制异常边界', () => {
  it.each([new GraphInterrupt(), new ParentCommand(new Command({ goto: 'parent-node' }))])(
    '原样传播 $name，不包装为 NodeExecutionError',
    async (error) => {
      const f = fixture();
      f.execute.mockRejectedValue(error);
      await expect(f.executor.execute(f.node, f.context)).rejects.toBe(error);
      expect(f.outputParse).not.toHaveBeenCalled();
    },
  );

  it('真实 LangGraph interrupt 可穿过 Executor 暂停，并由原生 Command 恢复', async () => {
    const f = fixture();
    f.execute.mockImplementation(async (input) => ({
      result: interrupt<string, number>('提供 A') + input.b,
    }));
    const TestState = Annotation.Root({ done: Annotation<boolean>() });
    const graph = new StateGraph(TestState)
      .addNode('call', async () => {
        expect(await f.executor.execute(f.node, f.context)).toEqual({ output: { result: 30 } });
        // 仅测试原生中断传播，不将业务输出编码为生产 WorkflowState。
        return { done: true };
      })
      .addEdge(START, 'call')
      .addEdge('call', END)
      .compile({ checkpointer: new MemorySaver() });
    const config = { configurable: { thread_id: 'executor-interrupt-test' } };
    await graph.invoke({ done: false }, config);
    expect((await graph.getState(config)).tasks[0]?.interrupts).toHaveLength(1);
    expect(f.outputParse).not.toHaveBeenCalled();
    expect(await graph.invoke(new Command({ resume: 10 }), config)).toMatchObject({ done: true });
    expect(f.outputParse).toHaveBeenCalledTimes(1);
    expect((await graph.getState(config)).tasks).toHaveLength(0);
  });
});
