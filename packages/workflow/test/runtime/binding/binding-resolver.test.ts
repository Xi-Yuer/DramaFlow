import { describe, expect, it, vi } from 'vitest';
import {
  ImageType,
  DocumentType,
  JsonType,
  NumberType,
  StringType,
  type ConstantBinding,
  type DataEdgeDefinition,
  type NodeDefinition,
  type NodeOutputMap,
  type NodeTypeManifest,
  type RuntimeValue,
  type StaticInputBinding,
  type WorkflowEdge,
} from '@dramaflow/contracts';
import {
  createBindingResolver,
  resolveDataEdgeInputs,
  type WorkflowState,
} from '../../../src/index.js';

const image: RuntimeValue = {
  storage: 'reference',
  type: ImageType,
  reference: { kind: 'artifact', id: 'image-artifact' },
};
const prompt: RuntimeValue = { storage: 'inline', type: StringType, value: '让人物向前走' };
const document: RuntimeValue = {
  storage: 'reference',
  type: DocumentType,
  reference: { kind: 'artifact', id: 'novel-artifact' },
};
const reference: RuntimeValue = {
  storage: 'reference',
  type: ImageType,
  reference: { kind: 'asset', id: 'asset-1', versionId: 'version-3' },
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
const nodeType: NodeTypeManifest = {
  type: node.type,
  version: node.typeVersion,
  executionKind: 'action',
  metadata: { name: '目标节点', category: 'video' },
  inputs: [
    { key: 'image', name: '图片', dataType: ImageType, required: true },
    { key: 'prompt', name: '提示词', dataType: StringType },
    { key: 'reference', name: '参考图', dataType: ImageType },
    { key: 'document', name: '小说', dataType: DocumentType },
  ],
  outputs: [],
  config: [],
};

function state(outputs: NodeOutputMap = { A: { generatedImage: image } }): WorkflowState {
  return {
    run: { workflowId: 'w', workflowVersionId: 'v', workflowRunId: 'r', projectId: 'p' },
    inputs: { novel: document },
    outputs,
    variables: {},
    execution: {},
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

describe('BindingResolver 完整输入组装', () => {
  const bindingResolver = createBindingResolver();

  it('optional 来源缺失时省略目标 key，保留其他输入，不修改 State', async () => {
    const original = { ...state(), inputs: {} };
    const inputs = await bindingResolver.resolveInputs({
      workflowInputs: [{ name: 'novel', type: DocumentType, required: false }],
      node: {
        ...node,
        inputs: {
          document: { type: 'workflow_input', key: 'novel' },
          prompt: { type: 'constant', value: '写作' },
        },
      },
      nodeType,
      edges: [],
      state: original,
    });
    expect(inputs).toEqual({ prompt: { storage: 'inline', type: StringType, value: '写作' } });
    expect(Object.hasOwn(inputs, 'document')).toBe(false);
    expect(original.inputs).toEqual({});
  });

  it.each([true, false])('缺失来源 required=%s 不能静默满足必填端口', async (required) => {
    await expect(
      bindingResolver.resolveInputs({
        workflowInputs: [{ name: 'picture', type: ImageType, required }],
        node: { ...node, inputs: { image: { type: 'workflow_input', key: 'picture' } } },
        nodeType,
        edges: [],
        state: state(),
      }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_INPUT_MISSING' });
  });

  it('required nullable 来源缺失时即使目标可省略仍报错', async () => {
    await expect(
      bindingResolver.resolveInputs({
        workflowInputs: [
          {
            name: 'novel',
            required: true,
            type: { kind: 'union', types: [DocumentType, { kind: 'primitive', name: 'null' }] },
          },
        ],
        node: { ...node, inputs: { document: { type: 'workflow_input', key: 'novel' } } },
        nodeType,
        edges: [],
        state: { ...state(), inputs: {} },
      }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_INPUT_MISSING' });
  });

  it.each([null, false, 0, ''])('optional 的显式值 %s 仍保留，不当作 missing', async (value) => {
    const runtimeValue: RuntimeValue = { storage: 'inline', type: JsonType, value };
    const inputs = await bindingResolver.resolveInputs({
      workflowInputs: [{ name: 'novel', type: JsonType, required: false }],
      node: { ...node, inputs: { document: { type: 'workflow_input', key: 'novel' } } },
      nodeType,
      edges: [],
      state: { ...state(), inputs: { novel: runtimeValue } },
    });
    expect(Object.hasOwn(inputs, 'document')).toBe(true);
    expect(inputs.document).toBe(runtimeValue);
  });

  it('optional reference 原样传递，不读取引用内容', async () => {
    const value: RuntimeValue = {
      storage: 'reference',
      type: DocumentType,
      get reference(): never {
        throw new Error('不能解析引用');
      },
    };
    const inputs = await bindingResolver.resolveInputs({
      workflowInputs: [{ name: 'novel', type: DocumentType, required: false }],
      node: { ...node, inputs: { document: { type: 'workflow_input', key: 'novel' } } },
      nodeType,
      edges: [],
      state: { ...state(), inputs: { novel: value } },
    });
    expect(inputs.document).toBe(value);
  });

  it('实际解析四类来源，保留输入和上游值，整个过程不发生外部 I/O', async () => {
    const target: NodeDefinition = {
      ...node,
      inputs: {
        reference: { type: 'asset', assetId: 'asset-1', versionId: 'version-3' },
        prompt: { type: 'constant', value: '让人物向前走' },
        document: { type: 'workflow_input', key: 'novel' },
      },
    };
    const context = {
      workflowInputs: [],
      node: target,
      nodeType,
      edges: [imageEdge],
      state: state(),
    };
    const snapshot = structuredClone(context);
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('BindingResolver 不得访问网络');
    });
    try {
      const inputs = await bindingResolver.resolveInputs(context);
      expect(inputs).toEqual({ image, reference, prompt, document });
      expect(inputs.image).toBe(image);
      expect(inputs.document).toBe(document);
      expect(inputs.prompt?.type).toBe(StringType);
      expect(inputs.reference?.type).toBe(ImageType);
      expect(context).toEqual(snapshot);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });

  it.each<{ value: ConstantBinding['value'] }>([
    { value: null },
    { value: false },
    { value: 0 },
    { value: '' },
    { value: [0, false] },
    { value: { nested: ['值'] } },
  ])('常量保留 JSON 值并使用目标端口类型，不推断实际值类型：$value', async ({ value }) => {
    const inputs = await bindingResolver.resolveInputs({
      workflowInputs: [],
      node: { ...node, inputs: { prompt: { type: 'constant', value } } },
      nodeType: {
        ...nodeType,
        inputs: [{ key: 'prompt', name: 'JSON', dataType: JsonType }],
      },
      edges: [],
      state: state(),
    });
    expect(inputs.prompt).toEqual({ storage: 'inline', type: JsonType, value });
    if (inputs.prompt?.storage === 'inline') expect(inputs.prompt.value).toBe(value);
  });

  it('业务值与端口类型不符时仍只构造 RuntimeValue，校验留给 NodeExecutor', async () => {
    const inputs = await bindingResolver.resolveInputs({
      workflowInputs: [],
      node: { ...node, inputs: { prompt: { type: 'constant', value: 123 } } },
      nodeType,
      edges: [],
      state: state(),
    });
    expect(inputs.prompt).toEqual({ storage: 'inline', type: StringType, value: 123 });
  });

  it.each<RuntimeValue>([{ storage: 'inline', type: StringType, value: '短文本' }, document])(
    '工作流输入原样复用 RuntimeValue，不按目标端口重新包装：$storage',
    async (value) => {
      const inputs = await bindingResolver.resolveInputs({
        workflowInputs: [],
        node: { ...node, inputs: { document: { type: 'workflow_input', key: 'novel' } } },
        nodeType,
        edges: [],
        state: { ...state(), inputs: { novel: value } },
      });
      expect(inputs.document).toBe(value);
    },
  );

  it('缺失的工作流输入抛 WORKFLOW_INPUT_MISSING，不返回 undefined', async () => {
    await expect(
      bindingResolver.resolveInputs({
        workflowInputs: [],
        node: { ...node, inputs: { document: { type: 'workflow_input', key: 'missing' } } },
        nodeType,
        edges: [],
        state: state(),
      }),
    ).rejects.toMatchObject({
      name: 'BindingResolutionError',
      code: 'WORKFLOW_INPUT_MISSING',
      details: { nodeId: 'B', inputKey: 'document', workflowInputKey: 'missing' },
    });
  });

  it('继承属性不作为已有工作流输入', async () => {
    const inputs: Record<string, RuntimeValue> = {};
    Object.setPrototypeOf(inputs, { novel: document });
    await expect(
      bindingResolver.resolveInputs({
        workflowInputs: [],
        node: { ...node, inputs: { document: { type: 'workflow_input', key: 'novel' } } },
        nodeType,
        edges: [],
        state: { ...state(), inputs },
      }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_INPUT_MISSING' });
  });

  it('工作流输入的内部引用不读取，保留给后续 Codec', async () => {
    const value: RuntimeValue = {
      storage: 'reference',
      type: DocumentType,
      get reference(): never {
        throw new Error('BindingResolver 不应解析工作流输入引用');
      },
    };
    const inputs = await bindingResolver.resolveInputs({
      workflowInputs: [],
      node: { ...node, inputs: { document: { type: 'workflow_input', key: 'novel' } } },
      nodeType,
      edges: [],
      state: { ...state(), inputs: { novel: value } },
    });
    expect(inputs.document).toBe(value);
  });

  it('同一资产的不同绑定固定各自版本，后续解析不改写先前的引用', async () => {
    const resolveVersion = (versionId: string) =>
      bindingResolver.resolveInputs({
        workflowInputs: [],
        node: { ...node, inputs: { reference: { type: 'asset', assetId: 'asset-1', versionId } } },
        nodeType,
        edges: [],
        state: state(),
      });
    const first = await resolveVersion('version-3');
    const second = await resolveVersion('version-4');
    expect(first.reference).toEqual(reference);
    expect(second.reference).toEqual({
      storage: 'reference',
      type: ImageType,
      reference: { kind: 'asset', id: 'asset-1', versionId: 'version-4' },
    });
  });

  it.each<StaticInputBinding>([
    { type: 'constant', value: '静态值' },
    { type: 'workflow_input', key: 'novel' },
    { type: 'asset', assetId: 'asset-1', versionId: 'version-1' },
    {
      type: 'template',
      value: '{{novel}}',
      variables: { novel: { type: 'workflow_input', key: 'novel' } },
    },
    {
      type: 'candidate',
      sources: [
        { type: 'node_output', nodeId: 'A', portKey: 'generatedImage' },
        { type: 'node_output', nodeId: 'C', portKey: 'generatedImage' },
      ],
    },
  ])(
    '任意静态绑定与 Data Edge 冲突时，在取值前抛 INPUT_SOURCE_CONFLICT：$type',
    async (binding) => {
      await expect(
        bindingResolver.resolveInputs({
          workflowInputs: [],
          node: { ...node, inputs: { image: binding } },
          nodeType,
          edges: [imageEdge],
          // 来源输出也缺失，仍须先报来源冲突；不能用静态值掩盖缺失输出。
          state: state({}),
        }),
      ).rejects.toMatchObject({
        code: 'INPUT_SOURCE_CONFLICT',
        details: imageErrorDetails,
      });
    },
  );

  it('上游输出缺失时直接抛原始问题，不用静态值补齐', async () => {
    await expect(
      bindingResolver.resolveInputs({
        workflowInputs: [],
        node: { ...node, inputs: { prompt: { type: 'constant', value: '提示词' } } },
        nodeType,
        edges: [imageEdge],
        state: state({ A: {} }),
      }),
    ).rejects.toMatchObject({ code: 'SOURCE_NODE_OUTPUT_MISSING' });
  });

  it('没有绑定时返回空 map，必填检查留到执行层，控制边不触发取值', async () => {
    expect(
      await bindingResolver.resolveInputs({
        workflowInputs: [],
        node,
        nodeType,
        edges: [
          { id: 'control', kind: 'control', source: { nodeId: 'A' }, target: { nodeId: 'B' } },
        ],
        state: state({}),
      }),
    ).toEqual({});
  });

  it.each<StaticInputBinding>([
    { type: 'constant', value: '常量' },
    { type: 'workflow_input', key: 'novel' },
    { type: 'asset', assetId: 'asset-1', versionId: 'version-3' },
    {
      type: 'template',
      value: '{{novel}}',
      variables: { novel: { type: 'workflow_input', key: 'novel' } },
    },
  ])('未声明的静态输入端口抛 INPUT_PORT_NOT_FOUND：$type', async (binding) => {
    await expect(
      bindingResolver.resolveInputs({
        workflowInputs: [],
        node: { ...node, inputs: { undeclared: binding } },
        nodeType,
        edges: [],
        state: state(),
      }),
    ).rejects.toMatchObject({
      code: 'INPUT_PORT_NOT_FOUND',
      details: { nodeId: 'B', inputKey: 'undeclared' },
    });
  });

  it('数据边的目标端口未声明时抛 INPUT_PORT_NOT_FOUND', async () => {
    await expect(
      bindingResolver.resolveInputs({
        workflowInputs: [],
        node,
        nodeType: { ...nodeType, inputs: [] },
        edges: [imageEdge],
        state: state({}),
      }),
    ).rejects.toMatchObject({ code: 'INPUT_PORT_NOT_FOUND', details: imageErrorDetails });
  });

  it('控制边的同名端口不占用静态输入，也不读取上游输出', async () => {
    const inputs = await bindingResolver.resolveInputs({
      workflowInputs: [],
      node: { ...node, inputs: { prompt: { type: 'constant', value: '让人物向前走' } } },
      nodeType,
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
  });

  it('一个模板引用多个上游输出，并按原文替换为内联字符串', async () => {
    const bindingResolver = createBindingResolver();
    const inputs = await bindingResolver.resolveInputs({
      workflowInputs: [],
      node: {
        ...node,
        inputs: {
          prompt: {
            type: 'template',
            value: '请根据 {{outline}} 和 {{characters}} 生成剧本。原文 {{outline}} $&',
            variables: {
              outline: { type: 'node_output', nodeId: 'outline', portKey: 'text' },
              characters: { type: 'node_output', nodeId: 'characters', portKey: 'text' },
            },
          },
        },
      },
      nodeType,
      edges: [],
      state: state({
        outline: { text: { storage: 'inline', type: StringType, value: '第一幕 {{characters}}' } },
        characters: { text: { storage: 'inline', type: StringType, value: '阿青' } },
      }),
    });
    expect(inputs.prompt).toEqual({
      storage: 'inline',
      type: StringType,
      value: '请根据 第一幕 {{characters}} 和 阿青 生成剧本。原文 第一幕 {{characters}} $&',
    });
  });

  it('模板中的 workflow input 渲染为字符串，不读取引用', async () => {
    const bindingResolver = createBindingResolver();
    const inputs = await bindingResolver.resolveInputs({
      workflowInputs: [],
      node: {
        ...node,
        inputs: {
          prompt: {
            type: 'template',
            value: '风格：{{style}}',
            variables: { style: { type: 'workflow_input', key: 'style' } },
          },
        },
      },
      nodeType,
      edges: [],
      state: {
        ...state(),
        inputs: { style: { storage: 'inline', type: StringType, value: '简洁' } },
      },
    });
    expect(inputs.prompt).toEqual({ storage: 'inline', type: StringType, value: '风格：简洁' });
  });

  it('模板来源缺失时报告变量名称', async () => {
    const bindingResolver = createBindingResolver();
    const prompt = {
      type: 'template' as const,
      value: '请根据 {{outline}} 生成剧本',
      variables: {
        outline: { type: 'node_output' as const, nodeId: 'outline', portKey: 'text' },
      },
    };
    await expect(
      bindingResolver.resolveInputs({
        workflowInputs: [],
        node: { ...node, inputs: { prompt } },
        nodeType,
        edges: [],
        state: state({}),
      }),
    ).rejects.toMatchObject({
      code: 'SOURCE_NODE_OUTPUT_MISSING',
      details: {
        nodeId: 'B',
        inputKey: 'prompt',
        sourceNodeId: 'outline',
        sourcePortKey: 'text',
        variableName: 'outline',
      },
    });
    await expect(
      bindingResolver.resolveInputs({
        workflowInputs: [],
        node: {
          ...node,
          inputs: {
            prompt: {
              type: 'template',
              value: '风格：{{style}}',
              variables: { style: { type: 'workflow_input', key: 'style' } },
            },
          },
        },
        nodeType,
        edges: [],
        state: state(),
      }),
    ).rejects.toMatchObject({
      code: 'WORKFLOW_INPUT_MISSING',
      details: {
        nodeId: 'B',
        inputKey: 'prompt',
        workflowInputKey: 'style',
        variableName: 'style',
      },
    });
  });

  it('非字符串或引用值不能进入模板，且不读取引用', async () => {
    const bindingResolver = createBindingResolver();
    const referenced = {
      storage: 'reference' as const,
      type: StringType,
      get reference(): never {
        throw new Error('模板解析不得读取引用');
      },
    };
    await expect(
      bindingResolver.resolveInputs({
        workflowInputs: [],
        node: {
          ...node,
          inputs: {
            prompt: {
              type: 'template',
              value: '{{outline}}',
              variables: {
                outline: { type: 'node_output', nodeId: 'outline', portKey: 'text' },
              },
            },
          },
        },
        nodeType,
        edges: [],
        state: state({ outline: { text: referenced } }),
      }),
    ).rejects.toMatchObject({
      code: 'TEMPLATE_VARIABLE_INVALID',
      details: { variableName: 'outline' },
    });
    await expect(
      bindingResolver.resolveInputs({
        workflowInputs: [],
        node: {
          ...node,
          inputs: {
            prompt: {
              type: 'template',
              value: '{{count}}',
              variables: { count: { type: 'node_output', nodeId: 'counter', portKey: 'count' } },
            },
          },
        },
        nodeType,
        edges: [],
        state: state({
          counter: { count: { storage: 'inline', type: NumberType, value: 3 } },
        }),
      }),
    ).rejects.toMatchObject({
      code: 'TEMPLATE_VARIABLE_INVALID',
      details: { variableName: 'count' },
    });
  });

  it('candidate：0 个来源存在抛 SOURCE_NODE_OUTPUT_MISSING，>1 个存在抛 CANDIDATE_INPUT_AMBIGUOUS，不按顺序取第一个', async () => {
    const candidate: StaticInputBinding = {
      type: 'candidate',
      sources: [
        { type: 'node_output', nodeId: 'B', portKey: 'text' },
        { type: 'node_output', nodeId: 'C', portKey: 'text' },
      ],
    };
    await expect(
      bindingResolver.resolveInputs({
        workflowInputs: [],
        node: { ...node, id: 'D', inputs: { prompt: candidate } },
        nodeType,
        edges: [],
        state: state({ B: {}, other: { text: prompt } }),
      }),
    ).rejects.toMatchObject({
      name: 'BindingResolutionError',
      code: 'SOURCE_NODE_OUTPUT_MISSING',
      details: { nodeId: 'D', inputKey: 'prompt' },
    });

    await expect(
      bindingResolver.resolveInputs({
        workflowInputs: [],
        node: { ...node, id: 'D', inputs: { prompt: candidate } },
        nodeType,
        edges: [],
        state: state({
          B: { text: { storage: 'inline', type: StringType, value: 'TRUE' } },
          C: { text: { storage: 'inline', type: StringType, value: 'FALSE' } },
        }),
      }),
    ).rejects.toMatchObject({
      name: 'BindingResolutionError',
      code: 'CANDIDATE_INPUT_AMBIGUOUS',
      details: { nodeId: 'D', inputKey: 'prompt' },
    });
  });

  it.each(['', 0, false, null] as const)(
    'candidate：恰好 1 个存在时原样返回，inline %s 均按存在处理',
    async (raw) => {
      const candidate: StaticInputBinding = {
        type: 'candidate',
        sources: [
          { type: 'node_output', nodeId: 'B', portKey: 'text' },
          { type: 'node_output', nodeId: 'C', portKey: 'text' },
        ],
      };
      const value: RuntimeValue = { storage: 'inline', type: JsonType, value: raw };
      for (const active of ['B', 'C'] as const) {
        const inputs = await bindingResolver.resolveInputs({
          workflowInputs: [],
          node: { ...node, id: 'D', inputs: { prompt: candidate } },
          nodeType: { ...nodeType, inputs: [{ key: 'prompt', name: 'JSON', dataType: JsonType }] },
          edges: [],
          state: state({ [active]: { text: value } }),
        });
        expect(inputs.prompt).toBe(value);
      }
    },
  );

  it('candidate：reference RuntimeValue 原样返回，不 decode 或读取 reference', async () => {
    const value: RuntimeValue = {
      storage: 'reference',
      type: ImageType,
      get reference(): never {
        throw new Error('BindingResolver 不得读取 candidate reference');
      },
    };
    const inputs = await bindingResolver.resolveInputs({
      workflowInputs: [],
      node: {
        ...node,
        id: 'D',
        inputs: {
          image: {
            type: 'candidate',
            sources: [
              { type: 'node_output', nodeId: 'B', portKey: 'image' },
              { type: 'node_output', nodeId: 'C', portKey: 'image' },
            ],
          },
        },
      },
      nodeType,
      edges: [],
      state: state({ C: { image: value } }),
    });
    expect(inputs.image).toBe(value);
  });
});
