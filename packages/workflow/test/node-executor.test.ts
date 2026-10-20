import { nodeRunRepositoryFixture } from './node-run-fixture.js';
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
  VideoType,
  type NodeDefinition,
  type NodeTypeManifest,
} from '@dramaflow/contracts';
import {
  BindingResolutionError,
  createBindingResolver,
  DefaultNodeExecutor,
  DefaultRuntimeValueCodec,
  DefaultDataStoragePolicyResolver,
  type ArtifactWriter,
  NodeExecutionError,
  NodeRunRecordingError,
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
  const write = vi
    .fn<ArtifactWriter['write']>()
    .mockResolvedValue({ kind: 'artifact', id: 'video-artifact' });
  const codec = new DefaultRuntimeValueCodec(
    referenceResolver,
    { write },
    new DefaultDataStoragePolicyResolver(),
  );
  const encode = vi.spyOn(codec, 'encode');
  const decodeRecord = vi.spyOn(codec, 'decodeRecord');
  const inputParse = vi.spyOn(schemas.inputSchema, 'parse');
  const configParse = vi.spyOn(schemas.configSchema, 'parse');
  const outputParse = vi.spyOn(schemas.outputSchema, 'parse');
  const nodeRuns = nodeRunRepositoryFixture();
  const executor = new DefaultNodeExecutor(registry, bindings, codec, nodeRuns);
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
    write,
    encode,
    decodeRecord,
    inputParse,
    configParse,
    execute,
    outputParse,
    executor,
    nodeRuns,
    context,
  };
}

describe('普通 Action Node 执行主链', () => {
  it('math.add 严格依次经过 Registry、Binding、Decode、三组 Schema 和业务调用，按端口编码输出', async () => {
    const f = fixture();
    const snapshot = structuredClone({ node: f.node, context: f.context });
    expect(await f.executor.execute(f.node, f.context)).toEqual({
      output: { result: { storage: 'inline', type: NumberType, value: 30 } },
    });
    const pipeline = [
      f.nodeRuns.createRunning,
      f.get,
      f.resolveInputs,
      f.nodeRuns.updateInputs,
      f.decodeRecord,
      f.inputParse,
      f.configParse,
      f.execute,
      f.outputParse,
      f.encode,
      f.nodeRuns.markCompleted,
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
    expect(f.execute).toHaveBeenCalledWith(
      { a: 10, b: 20 },
      {},
      { ...f.context, nodeRunId: 'node-run-1' },
    );
    expect(f.encode).toHaveBeenCalledExactlyOnceWith(30, {
      type: NumberType,
      storagePolicy: 'auto',
      context: {
        projectId: 'p',
        workflowRunId: 'r',
        nodeRunId: 'node-run-1',
        nodeId: 'sum',
        outputKey: 'result',
      },
    });
    expect(f.write).not.toHaveBeenCalled();
    expect(f.nodeRuns.createRunning).toHaveBeenCalledExactlyOnceWith({
      workflowRunId: 'r',
      nodeId: 'sum',
    });
    expect(f.nodeRuns.updateInputs).toHaveBeenCalledExactlyOnceWith('node-run-1', {
      a: { storage: 'inline', type: NumberType, value: 10 },
      b: { storage: 'inline', type: NumberType, value: 20 },
    });
    expect(f.nodeRuns.markCompleted).toHaveBeenCalledExactlyOnceWith('node-run-1', {
      result: { storage: 'inline', type: NumberType, value: 30 },
    });
    expect(f.nodeRuns.markFailed).not.toHaveBeenCalled();
    expect(f.referenceResolver.resolve).not.toHaveBeenCalled();
    expect({ node: f.node, context: f.context }).toEqual(snapshot);
    expect(f.context.state.outputs).toEqual({});
  });

  it('精确选择 typeVersion，不静默回退版本或业务类型', async () => {
    const f = fixture();
    const second = vi.fn(async () => ({ result: 200 }));
    f.registry.register({ ...f.schemas, manifest: { ...f.manifest, version: 2 }, execute: second });
    expect(await f.executor.execute({ ...f.node, typeVersion: 2 }, f.context)).toEqual({
      output: { result: { storage: 'inline', type: NumberType, value: 200 } },
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
    const executor = new DefaultNodeExecutor(registry, f.bindings, f.codec, f.nodeRuns);
    expect(await executor.execute(f.node, context)).toEqual({
      output: { result: { storage: 'inline', type: NumberType, value: 61 } },
    });
    expect(execute).toHaveBeenCalledWith(
      { a: 10, b: 20 },
      { factor: 2 },
      { ...context, nodeRunId: 'node-run-1' },
    );
    expect({ node: f.node, context }).toEqual(snapshot);
  });
});

describe('NodeExecutor 错误阶段', () => {
  it.each([
    'SOURCE_NODE_OUTPUT_MISSING',
    'WORKFLOW_INPUT_MISSING',
    'INPUT_SOURCE_CONFLICT',
  ] as const)('真实 Binding 失败 %s 已有 NodeRun，并记录 resolve_input', async (code) => {
    const f = fixture();
    let context = f.context;
    if (code === 'WORKFLOW_INPUT_MISSING') {
      context = { ...context, state: { ...context.state, inputs: {} } };
    } else {
      context = {
        ...context,
        workflow: {
          ...context.workflow,
          nodes: [{ ...f.node, id: 'upstream' }, f.node],
          edges: [
            {
              id: 'upstream-sum',
              kind: 'data',
              source: { nodeId: 'upstream', portKey: 'result' },
              target: { nodeId: f.node.id, portKey: 'a' },
            },
          ],
        },
      };
      if (code === 'SOURCE_NODE_OUTPUT_MISSING') {
        f.node.inputs = { b: { type: 'constant', value: 20 } };
      }
    }
    const invocation = f.executor.execute(f.node, context);
    await expect(invocation).rejects.toMatchObject({ stage: 'resolve_input', cause: { code } });
    expect(f.nodeRuns.createRunning).toHaveBeenCalledTimes(1);
    expect(f.nodeRuns.markFailed).toHaveBeenCalledExactlyOnceWith(
      'node-run-1',
      expect.objectContaining({ stage: 'resolve_input' }),
    );
    expect(f.nodeRuns.updateInputs).not.toHaveBeenCalled();
    expect(f.decodeRecord).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('失败记录写入失败时同时报告两种原因，保留业务阶段 / cause，不重试执行', async () => {
    const f = fixture();
    const cause = new Error('业务错误');
    const recordingError = new Error('审计写入失败');
    f.execute.mockRejectedValue(cause);
    f.nodeRuns.markFailed.mockRejectedValue(recordingError);
    const invocation = f.executor.execute(f.node, f.context);
    await expect(invocation).rejects.toBeInstanceOf(NodeRunRecordingError);
    await expect(invocation).rejects.toMatchObject({
      stage: 'execute',
      cause,
      recordingError,
      nodeRunId: 'node-run-1',
    });
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it('持久化错误只保存结构化阶段信息，不序列化原始 cause / stack / 供应商文本', async () => {
    const f = fixture();
    const cause = new Error('signed-url-and-credential-test-marker');
    f.execute.mockRejectedValue(cause);
    await expect(f.executor.execute(f.node, f.context)).rejects.toHaveProperty('cause', cause);
    expect(f.nodeRuns.markFailed).toHaveBeenCalledExactlyOnceWith('node-run-1', {
      code: 'NODE_EXECUTION_FAILED',
      stage: 'execute',
      message: '节点 sum（math.add）在 execute 阶段执行失败',
    });
    expect(JSON.stringify(f.nodeRuns.markFailed.mock.calls)).not.toContain(cause.message);
  });

  it.each<NodeExecutionStage>([
    'resolve_input',
    'decode_input',
    'validate_input',
    'validate_config',
    'execute',
    'validate_output',
    'encode_output',
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
      case 'encode_output':
        cause = new Error('编码失败');
        f.encode.mockRejectedValue(cause);
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
    if (stage === 'encode_output')
      await expect(invocation).rejects.toHaveProperty('code', 'NODE_OUTPUT_ENCODING_FAILED');
    const steps = [
      f.nodeRuns.createRunning,
      f.resolveInputs,
      f.nodeRuns.updateInputs,
      f.decodeRecord,
      f.inputParse,
      f.configParse,
      f.execute,
      f.outputParse,
      f.encode,
      f.nodeRuns.markCompleted,
    ];
    const stages: NodeExecutionStage[] = [
      'create_run',
      'resolve_input',
      'record_inputs',
      'decode_input',
      'validate_input',
      'validate_config',
      'execute',
      'validate_output',
      'encode_output',
      'complete_run',
    ];
    for (const step of steps.slice(stages.indexOf(stage) + 1)) expect(step).not.toHaveBeenCalled();
    expect(f.nodeRuns.markFailed).toHaveBeenCalledExactlyOnceWith(
      'node-run-1',
      expect.objectContaining({ stage }),
    );
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
      const executor = new DefaultNodeExecutor(registry, f.bindings, f.codec, f.nodeRuns);
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

describe('NodeRun Repository 基础设施异常', () => {
  it.each(['createRunning', 'updateInputs', 'markCompleted'] as const)(
    '%s 失败保留原异常，不调用 markFailed，不改为业务执行失败',
    async (method) => {
      const f = fixture();
      const cause = new Error('数据库不可用');
      f.nodeRuns[method].mockRejectedValue(cause);
      const invocation = f.executor.execute(f.node, f.context);
      await expect(invocation).rejects.toBe(cause);
      await expect(invocation).rejects.not.toBeInstanceOf(NodeExecutionError);
      expect(f.nodeRuns.markFailed).not.toHaveBeenCalled();
      expect(f.execute).toHaveBeenCalledTimes(method === 'markCompleted' ? 1 : 0);
      expect(f.context.state.outputs).toEqual({});
      if (method === 'createRunning') expect(f.resolveInputs).not.toHaveBeenCalled();
      if (method === 'updateInputs') expect(f.decodeRecord).not.toHaveBeenCalled();
      if (method !== 'markCompleted') expect(f.nodeRuns.markCompleted).not.toHaveBeenCalled();
    },
  );

  it('markCompleted 确认写入前，不返回 NodeExecutionResult', async () => {
    const f = fixture();
    let acknowledge!: () => void;
    const persisted = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    f.nodeRuns.markCompleted.mockReturnValue(persisted);
    let returned = false;
    const invocation = f.executor.execute(f.node, f.context).then((result) => {
      returned = true;
      return result;
    });
    try {
      await vi.waitFor(() => expect(f.nodeRuns.markCompleted).toHaveBeenCalledTimes(1));
      expect(returned).toBe(false);
      expect(f.nodeRuns.markFailed).not.toHaveBeenCalled();
      acknowledge();
      expect(await invocation).toEqual({
        output: { result: { storage: 'inline', type: NumberType, value: 30 } },
      });
    } finally {
      acknowledge();
      await invocation;
    }
  });
});

describe('LangGraph 原生控制异常边界', () => {
  it.each([new GraphInterrupt(), new ParentCommand(new Command({ goto: 'parent-node' }))])(
    '原样传播 $name，不包装为 NodeExecutionError',
    async (error) => {
      const f = fixture();
      f.execute.mockRejectedValue(error);
      await expect(f.executor.execute(f.node, f.context)).rejects.toBe(error);
      expect(f.outputParse).not.toHaveBeenCalled();
      expect(f.nodeRuns.markFailed).not.toHaveBeenCalled();
      expect(f.nodeRuns.markCompleted).not.toHaveBeenCalled();
    },
  );

  it('真实 LangGraph interrupt 可穿过 Executor 暂停，并由原生 Command 恢复', async () => {
    const f = fixture();
    // 人为注入控制异常仅验证原生边界；普通 Action 业务禁止主动 interrupt。
    f.execute.mockImplementation(async (input) => ({
      result: interrupt<string, number>('提供 A') + input.b,
    }));
    const TestState = Annotation.Root({ done: Annotation<boolean>() });
    const graph = new StateGraph(TestState)
      .addNode('call', async () => {
        expect(await f.executor.execute(f.node, f.context)).toEqual({
          output: { result: { storage: 'inline', type: NumberType, value: 30 } },
        });
        // 仅测试原生中断传播，不将编码结果映射为生产 WorkflowState。
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

describe('NodeExecutor 按输出端口编码', () => {
  function videoFixture() {
    const f = fixture();
    const node: NodeDefinition = { ...f.node, id: 'render', type: 'test.video', inputs: {} };
    const video = {
      id: 'business-video',
      mediaType: 'video',
      mimeType: 'video/mp4',
      access: { url: 'https://media.example.test/video' },
    };
    const manifest: NodeTypeManifest = {
      ...f.manifest,
      type: node.type,
      inputs: [],
      outputs: [
        { key: 'video', name: '视频', dataType: VideoType },
        { key: 'duration', name: '时长', dataType: NumberType, storagePolicy: 'inline' },
      ],
    };
    const execute = vi.fn(async () => ({ video, duration: 12.5 }));
    const outputSchema = z
      .object({
        video: z.object({
          id: z.string(),
          mediaType: z.string(),
          mimeType: z.string(),
          access: z.object({ url: z.string() }),
        }),
        duration: z.number(),
      })
      .strict();
    const executor = new DefaultNodeExecutor(
      new NodeRegistry([
        {
          manifest,
          inputSchema: z.object({}).strict(),
          configSchema: z.object({}).strict(),
          outputSchema,
          execute,
        },
      ]),
      f.bindings,
      f.codec,
      f.nodeRuns,
    );
    const context = { ...f.context, workflow: { ...f.context.workflow, nodes: [node] } };
    return { ...f, executor, context, node, video, execute };
  }

  it('video 写 Artifact，duration 内联，业务 Node 无需返回存储封装，Executor 不写 State', async () => {
    const f = videoFixture();
    const snapshot = structuredClone({ node: f.node, context: f.context });
    expect(await f.executor.execute(f.node, f.context)).toEqual({
      output: {
        video: {
          storage: 'reference',
          type: VideoType,
          reference: { kind: 'artifact', id: 'video-artifact' },
        },
        duration: { storage: 'inline', type: NumberType, value: 12.5 },
      },
    });
    expect(f.write).toHaveBeenCalledExactlyOnceWith(f.video, {
      projectId: 'p',
      workflowRunId: 'r',
      nodeRunId: 'node-run-1',
      nodeId: 'render',
      outputKey: 'video',
      type: VideoType,
    });
    expect(f.encode.mock.calls).toEqual([
      [
        f.video,
        {
          type: VideoType,
          storagePolicy: 'auto',
          context: {
            projectId: 'p',
            workflowRunId: 'r',
            nodeRunId: 'node-run-1',
            nodeId: 'render',
            outputKey: 'video',
          },
        },
      ],
      [
        12.5,
        {
          type: NumberType,
          storagePolicy: 'inline',
          context: {
            projectId: 'p',
            workflowRunId: 'r',
            nodeRunId: 'node-run-1',
            nodeId: 'render',
            outputKey: 'duration',
          },
        },
      ],
    ]);
    expect(await f.execute.mock.results[0]?.value).toEqual({ video: f.video, duration: 12.5 });
    expect({ node: f.node, context: f.context }).toEqual(snapshot);
  });

  it('ArtifactWriter 失败标记 encode_output，保留原因，不编码后续端口或返回部分结果', async () => {
    const f = videoFixture();
    const cause = new Error('写入失败');
    f.write.mockRejectedValue(cause);
    await expect(f.executor.execute(f.node, f.context)).rejects.toMatchObject({
      nodeId: 'render',
      nodeType: 'test.video',
      stage: 'encode_output',
      code: 'NODE_OUTPUT_ENCODING_FAILED',
      cause,
    });
    expect(f.write).toHaveBeenCalledTimes(1);
    expect(f.encode).toHaveBeenCalledTimes(1);
    expect(f.context.state.outputs).toEqual({});
  });

  it('输出 Schema 失败时不开始 Artifact 写入', async () => {
    const f = videoFixture();
    f.execute.mockResolvedValue({ video: f.video, duration: NaN });
    await expect(f.executor.execute(f.node, f.context)).rejects.toMatchObject({
      stage: 'validate_output',
    });
    expect(f.write).not.toHaveBeenCalled();
    expect(f.encode).not.toHaveBeenCalled();
  });
});
