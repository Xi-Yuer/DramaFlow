import { describe, expect, it, vi } from 'vitest';
import {
  ImageType,
  StringType,
  type DataEdgeDefinition,
  type NodeDefinition,
  type NodeOutputMap,
  type RuntimeValue,
  type StaticInputBinding,
  type WorkflowEdge,
} from '@dramaflow/contracts';
import {
  BindingResolutionError,
  createBindingResolver,
  resolveDataEdgeInputs,
  type StaticBindingResolver,
  type WorkflowState,
} from '../src/index.js';

const image: RuntimeValue = {
  storage: 'reference',
  type: ImageType,
  reference: { kind: 'artifact', id: 'image-artifact' },
};
const prompt: RuntimeValue = { storage: 'inline', type: StringType, value: '让人物向前走' };
const topic: RuntimeValue = { storage: 'inline', type: StringType, value: '工作流输入' };
const reference: RuntimeValue = {
  storage: 'reference',
  type: ImageType,
  reference: { kind: 'asset', id: 'asset-1', versionId: 'version-1' },
};
const imageEdge: DataEdgeDefinition = {
  id: 'image-edge',
  kind: 'data',
  source: { nodeId: 'A', portKey: 'generatedImage' },
  target: { nodeId: 'B', portKey: 'image' },
};
const node: NodeDefinition = {
  id: 'B',
  type: 'test.action',
  typeVersion: 1,
  name: '目标节点',
  inputs: {},
  config: {},
  ui: { position: { x: 0, y: 0 } },
};

function state(outputs: NodeOutputMap = { A: { generatedImage: image } }): WorkflowState {
  return {
    run: { workflowId: 'w', workflowVersionId: 'v', workflowRunId: 'r', projectId: 'p' },
    inputs: { novel: topic },
    outputs,
    variables: {},
    execution: {},
  };
}

function staticBindings() {
  return {
    resolveValue: vi
      .fn<StaticBindingResolver['resolveValue']>()
      .mockRejectedValue(new Error('本用例不应调用静态绑定解析')),
  };
}

const imageErrorDetails = {
  nodeId: 'B',
  inputKey: 'image',
  edgeId: 'image-edge',
  sourceNodeId: 'A',
  sourcePortKey: 'generatedImage',
};

describe('Data Edge 输入解析', () => {
  it('按目标端口映射上游 RuntimeValue，忽略控制边与其他节点的数据边', () => {
    const edges: WorkflowEdge[] = [
      {
        id: 'control',
        kind: 'control',
        source: { nodeId: 'missing', portKey: 'missing' },
        target: { nodeId: 'B', portKey: 'image' },
      },
      { ...imageEdge, id: 'other-node', target: { nodeId: 'C', portKey: 'image' } },
      imageEdge,
      {
        id: 'text-edge',
        kind: 'data',
        source: { nodeId: 'text', portKey: 'result' },
        target: { nodeId: 'B', portKey: 'prompt' },
      },
    ];
    const outputs = { A: { generatedImage: image }, text: { result: prompt } };
    const inputs = resolveDataEdgeInputs('B', edges, outputs);
    expect(inputs).toEqual({ image, prompt });
    expect(inputs.image).toBe(image);
    expect(inputs.prompt).toBe(prompt);
    expect(resolveDataEdgeInputs('unconnected', edges, {})).toEqual({});
  });

  it.each<{ name: string; outputs: NodeOutputMap }>([
    { name: '来源节点不存在', outputs: {} },
    { name: '来源输出端口不存在', outputs: { A: {} } },
  ])('$name 时抛结构化错误，不返回 undefined', ({ outputs }) => {
    expect(() => resolveDataEdgeInputs('B', [imageEdge], outputs)).toThrow(
      expect.objectContaining({
        name: 'BindingResolutionError',
        code: 'SOURCE_NODE_OUTPUT_MISSING',
        details: imageErrorDetails,
      }),
    );
  });

  it('不把继承属性当作来源节点或输出端口', () => {
    const inheritedNode: NodeOutputMap = {};
    Object.setPrototypeOf(inheritedNode, { A: { generatedImage: image } });
    const inheritedOutput: NodeOutputMap = { A: {} };
    Object.setPrototypeOf(inheritedOutput.A!, { generatedImage: image });
    for (const outputs of [inheritedNode, inheritedOutput]) {
      expect(() => resolveDataEdgeInputs('B', [imageEdge], outputs)).toThrow(
        expect.objectContaining({ code: 'SOURCE_NODE_OUTPUT_MISSING' }),
      );
    }
  });

  it('多条数据边连接同一目标端口时先报来源冲突，不采用覆盖规则', () => {
    const duplicate: DataEdgeDefinition = {
      ...imageEdge,
      id: 'second-image',
      source: { nodeId: 'other', portKey: 'image' },
    };
    for (const edges of [
      [imageEdge, duplicate],
      [duplicate, imageEdge],
    ]) {
      expect(() => resolveDataEdgeInputs('B', edges, {})).toThrow(
        expect.objectContaining({ code: 'INPUT_SOURCE_CONFLICT' }),
      );
    }
  });

  it('RuntimeValue 的内部引用完全不读取，保留引用给后续 Codec', () => {
    const value: RuntimeValue = {
      storage: 'reference',
      type: ImageType,
      get reference(): never {
        throw new Error('BindingResolver 不应 decode 或解析 reference');
      },
    };
    expect(resolveDataEdgeInputs('B', [imageEdge], { A: { generatedImage: value } }).image).toBe(
      value,
    );
  });
});

describe('BindingResolver 输入组装', () => {
  it('将 Data Edge 与三种显式静态解析结果合并为完整 RuntimeValue map', async () => {
    const target: NodeDefinition = {
      ...node,
      inputs: {
        reference: { type: 'asset', assetId: 'asset-1', versionId: 'version-1' },
        prompt: { type: 'constant', value: '让人物向前走' },
        topic: { type: 'workflow_input', key: 'novel' },
      },
    };
    const context = { node: target, edges: [imageEdge], state: state() };
    const snapshot = structuredClone(context);
    const expectedValues = { reference, prompt, topic };
    const resolveValue = vi
      .fn<StaticBindingResolver['resolveValue']>()
      .mockImplementation(async (binding, staticContext) => {
        expect(binding).toBe(target.inputs[staticContext.inputKey]);
        expect(staticContext.node).toBe(target);
        expect(staticContext.edges).toBe(context.edges);
        expect(staticContext.state).toBe(context.state);
        switch (binding.type) {
          case 'asset':
            expect(binding.versionId).toBe('version-1');
            return expectedValues.reference;
          case 'constant':
            return expectedValues.prompt;
          case 'workflow_input':
            return staticContext.state.inputs[binding.key]!;
        }
      });
    const bindingResolver = createBindingResolver({ resolveValue });
    const inputs = await bindingResolver.resolveInputs(context);
    expect(inputs).toEqual({ image, reference, prompt, topic });
    for (const [key, value] of Object.entries({ image, reference, prompt, topic })) {
      expect(inputs[key]).toBe(value);
    }
    expect(resolveValue).toHaveBeenCalledTimes(3);
    expect(context.node.inputs).not.toHaveProperty('image');
    expect(context.edges).toEqual([imageEdge]);
    expect(context).toEqual(snapshot);
  });

  it.each<StaticInputBinding>([
    { type: 'constant', value: '静态值' },
    { type: 'workflow_input', key: 'novel' },
    { type: 'asset', assetId: 'asset-1', versionId: 'version-1' },
  ])(
    '任意静态绑定与 Data Edge 冲突时，在取值前抛 INPUT_SOURCE_CONFLICT：$type',
    async (binding) => {
      const statics = staticBindings();
      const resolver = createBindingResolver(statics);
      await expect(
        resolver.resolveInputs({
          node: { ...node, inputs: { image: binding } },
          edges: [imageEdge],
          // 来源输出也缺失，仍须先报来源冲突；不能用静态值掩盖缺失输出。
          state: state({}),
        }),
      ).rejects.toMatchObject({
        code: 'INPUT_SOURCE_CONFLICT',
        details: imageErrorDetails,
      });
      expect(statics.resolveValue).not.toHaveBeenCalled();
    },
  );

  it('上游输出缺失时不调用任何静态解析服务，直接抛原始问题', async () => {
    const statics = staticBindings();
    await expect(
      createBindingResolver(statics).resolveInputs({
        node: { ...node, inputs: { prompt: { type: 'constant', value: '提示词' } } },
        edges: [imageEdge],
        state: state({ A: {} }),
      }),
    ).rejects.toBeInstanceOf(BindingResolutionError);
    expect(statics.resolveValue).not.toHaveBeenCalled();
  });

  it('没有输入时返回空 map，控制边不触发取值或来源冲突', async () => {
    const statics = staticBindings();
    const resolver = createBindingResolver(statics);
    expect(
      await resolver.resolveInputs({
        node,
        edges: [
          { id: 'control', kind: 'control', source: { nodeId: 'A' }, target: { nodeId: 'B' } },
        ],
        state: state({}),
      }),
    ).toEqual({});
    expect(statics.resolveValue).not.toHaveBeenCalled();
  });

  it('静态解析服务失败时原样传播错误，不用缺失值或占位结果补齐', async () => {
    const error = new Error('静态绑定解析失败');
    const statics = staticBindings();
    statics.resolveValue.mockRejectedValue(error);
    await expect(
      createBindingResolver(statics).resolveInputs({
        node: { ...node, inputs: { prompt: { type: 'constant', value: '提示词' } } },
        edges: [],
        state: state(),
      }),
    ).rejects.toBe(error);
  });

  it('控制边的同名端口不占用静态输入，也不读取上游输出', async () => {
    const statics = staticBindings();
    statics.resolveValue.mockResolvedValue(prompt);
    const inputs = await createBindingResolver(statics).resolveInputs({
      node: { ...node, inputs: { prompt: { type: 'constant', value: '让人物向前走' } } },
      edges: [
        {
          id: 'named-control',
          kind: 'control',
          source: { nodeId: 'missing', portKey: 'prompt' },
          target: { nodeId: 'B', portKey: 'prompt' },
        },
      ],
      state: state({}),
    });
    expect(inputs).toEqual({ prompt });
    expect(statics.resolveValue).toHaveBeenCalledTimes(1);
  });
});
