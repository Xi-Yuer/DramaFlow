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
    inputs: [{ name: 'prompt', type: StringType }],
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
        g.outputs[0]!.source.outputKey = 'missing';
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
    graph.inputs.push({ name: 'style', type: StringType });
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
});
