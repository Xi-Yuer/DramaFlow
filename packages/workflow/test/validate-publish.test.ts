import {
  ImageType,
  NumberType,
  StringType,
  workflowDefinitionSchema,
  type WorkflowDefinition,
} from '@dramaflow/contracts';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  createTextGenerationNodeType,
  NodeRegistry,
  validateWorkflowForPublish,
} from '../src/index.js';

const modelConfigurationId = '00000000-0000-4000-8000-000000000001';
function definition(): WorkflowDefinition {
  return {
    inputs: [{ name: 'prompt', type: StringType, required: true }],
    nodes: ['A', 'B'].map((id): WorkflowDefinition['nodes'][number] => ({
      id,
      type: 'ai.text_generate',
      typeVersion: 1,
      name: '文本',
      inputs: id === 'A' ? { prompt: { type: 'workflow_input' as const, key: 'prompt' } } : {},
      config: { modelConfigurationId },
      ui: { position: { x: 0, y: 0 } },
    })),
    edges: [
      {
        id: 'data',
        kind: 'data',
        source: { nodeId: 'A', portKey: 'text' },
        target: { nodeId: 'B', portKey: 'prompt' },
      },
    ],
    outputs: [{ name: 'text', type: StringType, source: { nodeId: 'B', outputKey: 'text' } }],
  };
}
function check(
  input: WorkflowDefinition,
  registry = new NodeRegistry([createTextGenerationNodeType()]),
) {
  return validateWorkflowForPublish(workflowDefinitionSchema.parse(input), registry);
}

describe('正式 Registry 的静态发布校验', () => {
  it.each([
    [true, 'prompt', true],
    [true, 'system', true],
    [false, 'system', true],
    [false, 'prompt', false],
  ] as const)('required=%s 绑定 %s：允许=%s', (required, portKey, allowed) => {
    const graph = definition();
    graph.inputs[0]!.required = required;
    graph.nodes[0]!.inputs = {
      prompt: { type: 'constant', value: '写作' },
      [portKey]: { type: 'workflow_input', key: 'prompt' },
    };
    if (allowed) expect(check(graph)).toHaveLength(2);
    else
      expect(() => check(graph)).toThrow(
        expect.objectContaining({
          code: 'INPUT_SOURCE_OPTIONAL',
          nodeId: 'A',
          portKey,
        }),
      );
  });

  it.each([true, false])('optional 目标仍校验 DataType，来源 required=%s', (required) => {
    const graph = definition();
    graph.inputs[0] = { name: 'prompt', type: NumberType, required };
    graph.nodes[0]!.inputs = {
      prompt: { type: 'constant', value: '写作' },
      system: { type: 'workflow_input', key: 'prompt' },
    };
    expect(() => check(graph)).toThrow(expect.objectContaining({ code: 'INPUT_TYPE_MISMATCH' }));
  });

  it.each([true, false])(
    'Manifest 与 Schema 的可省略性必须同时成立：Manifest required=%s',
    (required) => {
      const graph = definition();
      graph.inputs[0]!.required = false;
      graph.nodes[0]!.inputs = {
        prompt: { type: 'constant', value: '写作' },
        system: { type: 'workflow_input', key: 'prompt' },
      };
      const text = createTextGenerationNodeType();
      const registry = new NodeRegistry([
        {
          ...text,
          manifest: {
            ...text.manifest,
            inputs: text.manifest.inputs.map((port) =>
              port.key === 'system' ? { ...port, required } : port,
            ),
          },
          inputSchema: z.object({
            prompt: z.string(),
            system: required ? z.string().optional() : z.string(),
          }),
        },
      ]);
      expect(() => check(graph, registry)).toThrow(
        expect.objectContaining({ code: 'INPUT_SOURCE_OPTIONAL' }),
      );
    },
  );

  it('nullable 不代表 optional，也不能自动作为 string 模板变量', () => {
    const graph = definition();
    const nullable = {
      kind: 'union' as const,
      types: [StringType, { kind: 'primitive' as const, name: 'null' as const }],
    };
    graph.inputs[0] = { name: 'prompt', type: nullable, required: true };
    graph.nodes[0]!.inputs = {
      prompt: { type: 'constant', value: '写作' },
      system: { type: 'workflow_input', key: 'prompt' },
    };
    const text = createTextGenerationNodeType();
    const registry = new NodeRegistry([
      {
        ...text,
        manifest: {
          ...text.manifest,
          inputs: text.manifest.inputs.map((port) =>
            port.key === 'system' ? { ...port, dataType: nullable, required: true } : port,
          ),
        },
        inputSchema: z.object({ prompt: z.string(), system: z.string().nullable() }),
      },
    ]);
    graph.nodes[1]!.inputs.system = { type: 'constant', value: null };
    expect(check(graph, registry)).toHaveLength(2);
    graph.inputs[0]!.required = false;
    expect(() => check(graph, registry)).toThrow(
      expect.objectContaining({ code: 'INPUT_SOURCE_OPTIONAL' }),
    );
    graph.inputs[0]!.required = true;
    graph.nodes[0]!.inputs.system = {
      type: 'template',
      value: '{{style}}',
      variables: { style: { type: 'workflow_input', key: 'prompt' } },
    };
    expect(() => check(graph)).toThrow(expect.objectContaining({ code: 'INPUT_TYPE_MISMATCH' }));
  });

  it.each(['prompt', 'system'])('optional workflow_input 不能作为 %s 模板变量', (portKey) => {
    const graph = definition();
    graph.inputs[0]!.required = false;
    graph.nodes[0]!.inputs = {
      prompt: { type: 'constant', value: '写作' },
      [portKey]: {
        type: 'template',
        value: '{{style}}',
        variables: { style: { type: 'workflow_input', key: 'prompt' } },
      },
    };
    expect(() => check(graph)).toThrow(
      expect.objectContaining({ code: 'INPUT_SOURCE_OPTIONAL', portKey }),
    );
  });

  it('历史 input 缺少 required 时仍能向必填端口发布，原定义不回写', () => {
    const graph = definition();
    const legacy = { ...graph, inputs: [{ name: 'prompt', type: StringType }] };
    expect(
      validateWorkflowForPublish(
        workflowDefinitionSchema.parse(legacy),
        new NodeRegistry([createTextGenerationNodeType()]),
      ),
    ).toHaveLength(2);
    expect(legacy.inputs[0]).not.toHaveProperty('required');
  });

  it('合法文本 DAG 保留完整定义，不执行 Node 或回写默认值', () => {
    const nodeType = createTextGenerationNodeType();
    const execute = vi.spyOn(nodeType, 'execute');
    const graph = definition();
    const before = structuredClone(graph);
    expect(check(graph, new NodeRegistry([nodeType]))).toHaveLength(2);
    expect(graph).toEqual(before);
    expect(execute).not.toHaveBeenCalled();
    expect(check({ inputs: [], nodes: [], edges: [], outputs: [] })).toEqual([]);
  });

  it.each([
    [
      'NODE_TYPE_UNAVAILABLE',
      (g: WorkflowDefinition) => {
        g.nodes[0]!.type = 'test.missing';
      },
    ],
    [
      'NODE_TYPE_UNAVAILABLE',
      (g: WorkflowDefinition) => {
        g.nodes[0]!.typeVersion = 99;
      },
    ],
    [
      'NODE_CONFIG_INVALID',
      (g: WorkflowDefinition) => {
        g.nodes[0]!.config = {};
      },
    ],
    [
      'NODE_CONFIG_INVALID',
      (g: WorkflowDefinition) => {
        g.nodes[0]!.config.apiKey = 'secret-marker';
      },
    ],
    [
      'OUTPUT_PORT_NOT_FOUND',
      (g: WorkflowDefinition) => {
        g.edges[0]!.source.portKey = 'missing';
      },
    ],
    [
      'INPUT_PORT_NOT_FOUND',
      (g: WorkflowDefinition) => {
        g.edges[0]!.target.portKey = 'missing';
      },
    ],
    [
      'INPUT_PORT_NOT_FOUND',
      (g: WorkflowDefinition) => {
        g.nodes[0]!.inputs.extra = { type: 'constant', value: 'x' };
      },
    ],
    [
      'INPUT_SOURCE_MISSING',
      (g: WorkflowDefinition) => {
        g.nodes[0]!.inputs = {};
      },
    ],
    [
      'INPUT_VALUE_INVALID',
      (g: WorkflowDefinition) => {
        g.nodes[0]!.inputs.prompt = { type: 'constant', value: '' };
      },
    ],
    [
      'INPUT_VALUE_INVALID',
      (g: WorkflowDefinition) => {
        g.nodes[0]!.inputs.prompt = { type: 'constant', value: 3 };
      },
    ],
    [
      'INPUT_TYPE_MISMATCH',
      (g: WorkflowDefinition) => {
        g.inputs[0]!.type = NumberType;
      },
    ],
    [
      'OUTPUT_PORT_NOT_FOUND',
      (g: WorkflowDefinition) => {
        g.outputs[0]!.source!.outputKey = 'missing';
      },
    ],
    [
      'WORKFLOW_OUTPUT_TYPE_MISMATCH',
      (g: WorkflowDefinition) => {
        g.outputs[0]!.type = NumberType;
      },
    ],
    [
      'NAMED_CONTROL_PORT_UNSUPPORTED',
      (g: WorkflowDefinition) => {
        g.edges.push({
          id: 'control',
          kind: 'control',
          source: { nodeId: 'A', portKey: 'approved' },
          target: { nodeId: 'B' },
        });
      },
    ],
    [
      'ASSET_BINDING_UNSUPPORTED',
      (g: WorkflowDefinition) => {
        g.nodes[0]!.inputs.prompt = { type: 'asset', assetId: 'asset', versionId: 'v1' };
      },
    ],
  ] as const)('拒绝 %s', (code, mutate) => {
    const graph = definition();
    mutate(graph);
    expect(() => check(graph)).toThrow(expect.objectContaining({ code }));
  });

  it.each(['__start__', '__end__', 'outputs', 'a:b', 'a|b', '__proto__'])(
    '官方 LangGraph 拒绝的名称 %s 不能发布',
    (id) => {
      const graph = definition();
      graph.nodes[0]!.id = id;
      graph.edges[0]!.source.nodeId = id;
      expect(() => check(graph)).toThrow(expect.objectContaining({ code: 'NODE_ID_INVALID' }));
    },
  );

  it('拒绝非 Action 类型，普通控制边仍只表达执行先后', () => {
    const original = createTextGenerationNodeType();
    const registry = new NodeRegistry([
      {
        ...original,
        manifest: { ...original.manifest, executionKind: 'interaction' },
        execute: undefined,
      },
    ]);
    expect(() => check(definition(), registry)).toThrow(
      expect.objectContaining({ code: 'NODE_EXECUTION_KIND_UNSUPPORTED' }),
    );
    const graph = definition();
    graph.edges.push({
      id: 'control',
      kind: 'control',
      source: { nodeId: 'A' },
      target: { nodeId: 'B' },
    });
    expect(check(graph)).toHaveLength(2);
  });

  it('Data Edge 使用共享 DataType 兼容规则；无自动输出存储策略也在发布拒绝', () => {
    const type = createTextGenerationNodeType();
    const registry = new NodeRegistry([
      {
        ...type,
        manifest: {
          ...type.manifest,
          outputs: [{ key: 'text', name: '输出', dataType: NumberType }],
        },
      },
    ]);
    expect(() => check(definition(), registry)).toThrow(
      expect.objectContaining({ code: 'INPUT_TYPE_MISMATCH' }),
    );
    const unsupported = new NodeRegistry([
      {
        ...type,
        manifest: {
          ...type.manifest,
          outputs: [{ key: 'text', name: '输出', dataType: { kind: 'any' } }],
        },
      },
    ]);
    expect(() => check(definition(), unsupported)).toThrow(
      expect.objectContaining({ code: 'OUTPUT_STORAGE_UNSUPPORTED' }),
    );
  });

  it('已知常量执行整组 Schema refine，动态真实值校验保留到 Runtime', () => {
    const type = createTextGenerationNodeType();
    const registry = new NodeRegistry([
      {
        ...type,
        inputSchema: z
          .object({ prompt: z.string(), system: z.string().optional() })
          .refine(({ prompt, system }) => prompt !== system),
      },
    ]);
    const graph = definition();
    graph.nodes[0]!.inputs = {
      prompt: { type: 'constant', value: 'same' },
      system: { type: 'constant', value: 'same' },
    };
    expect(() => check(graph, registry)).toThrow(
      expect.objectContaining({ code: 'INPUT_VALUE_INVALID' }),
    );
    graph.nodes[0]!.inputs.prompt = { type: 'workflow_input', key: 'prompt' };
    expect(check(graph, registry)).toHaveLength(2);
  });

  it('配置 Schema 默认值和 transform 仅用于校验，保留定义原始 JSON', () => {
    const type = createTextGenerationNodeType();
    const registry = new NodeRegistry([
      {
        ...type,
        configSchema: z.object({
          modelConfigurationId: z
            .uuid()
            .default(modelConfigurationId)
            .transform((value) => value.toUpperCase()),
        }),
      },
    ]);
    const graph = definition();
    graph.nodes[0]!.config = {};
    const before = structuredClone(graph);
    const validated = check(graph, registry);
    expect(validated[0]?.config).toEqual({
      modelConfigurationId: modelConfigurationId.toUpperCase(),
    });
    expect(graph).toEqual(before);
  });

  it('字符串模板引用可以发布，原始模板不当作最终 prompt', () => {
    const type = createTextGenerationNodeType();
    const registry = new NodeRegistry([
      {
        ...type,
        inputSchema: z.object({
          prompt: z.string().refine((value) => !value.includes('{{')),
          system: z.string().optional(),
        }),
      },
    ]);
    const graph = definition();
    graph.edges = [];
    graph.inputs.push({ name: 'style', type: StringType, required: true });
    graph.nodes.push({
      id: 'C',
      type: 'ai.text_generate',
      typeVersion: 1,
      name: '人物',
      inputs: { prompt: { type: 'constant', value: '阿青' } },
      config: { modelConfigurationId },
      ui: { position: { x: 0, y: 0 } },
    });
    graph.nodes[1]!.inputs = {
      prompt: {
        type: 'template',
        value: '请根据 {{outline}} 和 {{characters}} 生成剧本',
        variables: {
          outline: { type: 'node_output', nodeId: 'A', portKey: 'text' },
          characters: { type: 'node_output', nodeId: 'C', portKey: 'text' },
        },
      },
      system: {
        type: 'template',
        value: '风格：{{style}}',
        variables: { style: { type: 'workflow_input', key: 'style' } },
      },
    };
    expect(check(graph, registry)).toHaveLength(3);
    graph.inputs[1]!.type = NumberType;
    expect(() => check(graph, registry)).toThrow(
      expect.objectContaining({ code: 'INPUT_TYPE_MISMATCH' }),
    );
  });

  it('模板引用非字符串输出或缺失端口时不能发布', () => {
    const text = createTextGenerationNodeType();
    const registry = new NodeRegistry([
      text,
      {
        manifest: {
          type: 'test.image',
          version: 1,
          executionKind: 'action',
          metadata: { name: '图片', category: 'image' },
          inputs: [],
          outputs: [{ key: 'image', name: '图片', dataType: ImageType }],
          config: [],
        },
        inputSchema: z.object({}),
        outputSchema: z.object({ image: z.string() }),
        configSchema: z.object({}).strict(),
        execute: async () => ({ image: 'unused' }),
      },
    ]);
    const graph = (portKey: string): WorkflowDefinition => ({
      inputs: [],
      nodes: [
        {
          id: 'picture',
          type: 'test.image',
          typeVersion: 1,
          name: '图片',
          inputs: {},
          config: {},
          ui: { position: { x: 0, y: 0 } },
        },
        {
          id: 'writer',
          type: 'ai.text_generate',
          typeVersion: 1,
          name: '文本',
          inputs: {
            prompt: {
              type: 'template',
              value: '看 {{picture}}',
              variables: {
                picture: { type: 'node_output', nodeId: 'picture', portKey },
              },
            },
          },
          config: { modelConfigurationId },
          ui: { position: { x: 0, y: 0 } },
        },
      ],
      edges: [],
      outputs: [],
    });
    expect(() => check(graph('image'), registry)).toThrow(
      expect.objectContaining({ code: 'INPUT_TYPE_MISMATCH', nodeId: 'writer', portKey: 'prompt' }),
    );
    expect(() => check(graph('missing'), registry)).toThrow(
      expect.objectContaining({
        code: 'OUTPUT_PORT_NOT_FOUND',
        nodeId: 'picture',
        portKey: 'missing',
      }),
    );
  });

  it('candidate 校验来源输出端口存在与 DataType 兼容，并视为动态输入跳过常量预检', () => {
    const text = createTextGenerationNodeType();
    const registry = new NodeRegistry([
      {
        ...text,
        inputSchema: z.object({
          prompt: z.string().min(1),
          system: z.string().optional(),
        }),
      },
      {
        manifest: {
          type: 'test.image',
          version: 1,
          executionKind: 'action',
          metadata: { name: '图片', category: 'image' },
          inputs: [],
          outputs: [{ key: 'image', name: '图片', dataType: ImageType }],
          config: [],
        },
        inputSchema: z.object({}),
        outputSchema: z.object({ image: z.string() }),
        configSchema: z.object({}).strict(),
        execute: async () => ({ image: 'unused' }),
      },
    ]);
    const makeGraph = (
      first: { nodeId: string; portKey: string },
      second: { nodeId: string; portKey: string },
    ): WorkflowDefinition => ({
      inputs: [],
      nodes: [
        {
          id: 'picture',
          type: 'test.image',
          typeVersion: 1,
          name: '图片',
          inputs: {},
          config: {},
          ui: { position: { x: 0, y: 0 } },
        },
        {
          id: 'writerA',
          type: 'ai.text_generate',
          typeVersion: 1,
          name: '文本A',
          inputs: { prompt: { type: 'constant', value: 'hello' } },
          config: { modelConfigurationId },
          ui: { position: { x: 0, y: 0 } },
        },
        {
          id: 'target',
          type: 'ai.text_generate',
          typeVersion: 1,
          name: '目标',
          inputs: {
            prompt: {
              type: 'candidate',
              sources: [
                { type: 'node_output', ...first },
                { type: 'node_output', ...second },
              ],
            },
          },
          config: { modelConfigurationId },
          ui: { position: { x: 0, y: 0 } },
        },
      ],
      edges: [],
      outputs: [],
    });

    expect(() =>
      check(
        makeGraph(
          { nodeId: 'writerA', portKey: 'missing' },
          { nodeId: 'picture', portKey: 'image' },
        ),
        registry,
      ),
    ).toThrow(
      expect.objectContaining({
        code: 'OUTPUT_PORT_NOT_FOUND',
        nodeId: 'writerA',
        portKey: 'missing',
      }),
    );

    expect(() =>
      check(
        makeGraph({ nodeId: 'writerA', portKey: 'text' }, { nodeId: 'picture', portKey: 'image' }),
        registry,
      ),
    ).toThrow(
      expect.objectContaining({
        code: 'INPUT_TYPE_MISMATCH',
        nodeId: 'target',
        portKey: 'prompt',
      }),
    );
  });
});
