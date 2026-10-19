import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  createNodeTypeManifest,
  createOperationNodeType,
  isDataTypeAssignable,
  NodeRegistry,
  parseNodeTypeDefinition,
  type CompileContext,
  type NodeTypeDefinition,
  type NodeValueSchemas,
} from '../src/index.js';

function definition() {
  return {
    type: 'test.text',
    version: 1,
    metadata: { name: '测试文本操作', category: 'test', icon: 'text' },
    inputs: [{ key: 'text', name: '文本', dataType: { kind: 'string' }, required: true }],
    outputs: [{ key: 'text', name: '结果', dataType: { kind: 'string' } }],
    configSchema: z.object({
      prefix: z.string(),
      temperature: z.number().min(0).max(2).default(0.5),
    }),
    ui: {
      inputs: { text: { component: 'textarea' } },
      config: {
        prefix: { component: 'text', label: '前缀' },
        temperature: { component: 'slider', min: 0, max: 2, step: 0.1 },
      },
    },
  } satisfies NodeTypeDefinition;
}
const values = {
  inputSchema: z.object({ text: z.string() }),
  outputSchema: z.object({ text: z.string() }),
};
// 显式测试图，不注册生产模型或领域能力。
const TestState = Annotation.Root({
  inputs: Annotation<Record<string, unknown>>(),
  output: Annotation<z.JSONType>(),
});
type TestValue = typeof TestState.State;
type TestUpdate = typeof TestState.Update;
const context: CompileContext<TestValue, TestUpdate> = {
  readInputs: (state) => state.inputs,
  writeOutputs: (_node, outputs) => ({ output: outputs }),
};
function instance(version = 1, preset?: string) {
  return {
    id: 'text',
    type: 'test.text',
    typeVersion: version,
    preset,
    name: '测试实例',
    inputs: [],
    config: { prefix: '测试：' },
  };
}
function graph(registry: NodeRegistry<TestValue, TestUpdate>, node = instance()) {
  return new StateGraph(TestState)
    .addNode('operation', registry.compile(node, context))
    .addEdge(START, 'operation')
    .addEdge('operation', END)
    .compile();
}

describe('静态说明书与执行值契约分离', () => {
  it('UI 输入与配置分别校验，不能跨作用域引用字段', () => {
    expect(() =>
      parseNodeTypeDefinition({ ...definition(), ui: { config: { text: { component: 'text' } } } }),
    ).toThrow(expect.objectContaining({ code: 'unknown_config_field' }));
    expect(() =>
      parseNodeTypeDefinition({
        ...definition(),
        ui: { inputs: { prefix: { component: 'text' } } },
      }),
    ).toThrow(z.ZodError);
  });
  it('声明端口与显式 Zod 值契约必须拥有相同的字段集合', () => {
    const invalid: NodeValueSchemas[] = [
      { inputSchema: z.object({ other: z.string() }), outputSchema: values.outputSchema },
      {
        inputSchema: values.inputSchema,
        outputSchema: z.object({ text: z.string(), extra: z.string() }),
      },
    ];
    for (const schemas of invalid) {
      expect(() =>
        createOperationNodeType(definition(), schemas, () => ({ text: '测试' })),
      ).toThrow(expect.objectContaining({ code: 'port_schema_mismatch' }));
    }
  });
  it('声明复制隔离嵌套编辑数据，Zod 配置仍留在服务端', () => {
    const source = definition();
    const parsed = parseNodeTypeDefinition(source);
    parsed.metadata.name = '修改';
    parsed.inputs[0]!.name = '修改';
    parsed.ui.config!.prefix!.label = '修改';
    expect(source.metadata.name).toBe('测试文本操作');
    expect(source.inputs[0]!.name).toBe('文本');
    expect(source.ui.config.prefix.label).toBe('前缀');
    expect(parsed.configSchema).toBe(source.configSchema);
  });
  it('端口默认值只保留声明，不自动注入实例或替代尚未设计的 Binding', async () => {
    const descriptor: NodeTypeDefinition = {
      ...definition(),
      inputs: [
        { key: 'text', name: '文本', dataType: { kind: 'string' }, defaultValue: '声明默认' },
      ],
    };
    const invoke = vi.fn(({ inputs }: { inputs: { text: string } }) => ({ text: inputs.text }));
    const registry = new NodeRegistry<TestValue, TestUpdate>([
      createOperationNodeType(descriptor, values, invoke),
    ]);
    await expect(graph(registry).invoke({ inputs: {} })).rejects.toBeInstanceOf(z.ZodError);
    expect(invoke).not.toHaveBeenCalled();
    expect(instance().inputs).toEqual([]);
  });
});

describe('公开 manifest 以端口 DataType 描述连线', () => {
  it('只投影静态声明及配置 JSON Schema，剔除执行属性和 Schema 私有元数据', () => {
    const source = definition();
    const server = {
      ...source,
      configSchema: source.configSchema
        .extend({
          prefix: z.string().meta({ privateMetadata: 'synthetic-field-secret', type: 'number' }),
        })
        .meta({ privateMetadata: 'synthetic-object-secret' }),
      inputSchema: z.object({ text: z.date() }),
      compile: vi.fn(),
      serverSecret: 'synthetic-server-secret',
    };
    const manifest = createNodeTypeManifest(server);
    const json = JSON.stringify(manifest);
    expect(Object.keys(manifest).sort()).toEqual(
      ['type', 'version', 'metadata', 'inputs', 'outputs', 'ui', 'configSchema'].sort(),
    );
    expect(manifest.inputs[0]!.dataType).toEqual({ kind: 'string' });
    expect(manifest.configSchema).toMatchObject({ properties: { prefix: { type: 'string' } } });
    for (const value of [
      'inputSchema',
      'outputSchema',
      'compile',
      'serverSecret',
      'privateMetadata',
      'synthetic-',
    ])
      expect(json).not.toContain(value);
    expect(server.compile).not.toHaveBeenCalled();
    manifest.metadata.name = '客户端修改';
    expect(source.metadata.name).toBe('测试文本操作');
  });
  it('配置使用原始输入方向保留公开默认值，不能从它推断端口类型', () => {
    const manifest = createNodeTypeManifest({
      ...definition(),
      configSchema: z.object({
        prefix: z.string().default('公开默认'),
        temperature: z.string().transform(Number),
      }),
    });
    expect(manifest.configSchema).toMatchObject({
      properties: { prefix: { default: '公开默认' }, temperature: { type: 'string' } },
      required: ['temperature'],
      additionalProperties: false,
    });
    expect(manifest.outputs).toEqual(definition().outputs);
  });
  it('配置无法转换时明确失败，业务 refine 仍由服务端完整校验', () => {
    const source = definition();
    expect(() =>
      createNodeTypeManifest({
        ...source,
        configSchema: source.configSchema.extend({ counter: z.bigint() }),
      }),
    ).toThrow();
    const refined = {
      ...source,
      configSchema: source.configSchema.refine((value) => value.prefix !== '禁止值'),
    };
    expect(createNodeTypeManifest(refined).configSchema).toMatchObject({ type: 'object' });
    expect(() => refined.configSchema.parse({ prefix: '禁止值' })).toThrow(z.ZodError);
  });
  it('能力需求与端口默认值可公开，声明不触发任何 Capability 选择或调用', () => {
    const manifest = createNodeTypeManifest({
      ...definition(),
      capabilities: [{ type: 'ai.text_generation' }],
    });
    expect(manifest.capabilities).toEqual([{ type: 'ai.text_generation' }]);
    expect(manifest).not.toHaveProperty('provider');
    expect(manifest).not.toHaveProperty('model');
  });
});

describe('类型版本、Preset 与注册扩展', () => {
  it('多个版本并存，实例精确绑定版本，不隐式选最新或基础 Preset', async () => {
    const registry = new NodeRegistry<TestValue, TestUpdate>();
    for (const version of [1, 2])
      registry.register(
        createOperationNodeType({ ...definition(), version }, values, ({ inputs }) => ({
          text: `${version}:${inputs.text}`,
        })),
      );
    for (const version of [1, 2])
      expect(
        (await graph(registry, instance(version)).invoke({ inputs: { text: '内容' } })).output,
      ).toEqual({ text: `${version}:内容` });
    for (const node of [instance(3), instance(1, 'unavailable')])
      expect(() => registry.compile(node, context)).toThrow(
        expect.objectContaining({ code: 'unavailable_compiler' }),
      );
    expect(() => registry.get('test.text', 0)).toThrow(z.ZodError);
    expect(() =>
      registry.register(createOperationNodeType(definition(), values, () => ({ text: '' }))),
    ).toThrow(expect.objectContaining({ code: 'duplicate_compiler' }));
  });
  it('注册与读取隔离元数据修改，公开名称不能改变类型身份', () => {
    const source = definition();
    const nodeType = createOperationNodeType(source, values, ({ inputs }) => ({
      text: inputs.text,
    }));
    const registry = new NodeRegistry<TestValue, TestUpdate>([nodeType]);
    source.metadata.name = '源修改';
    nodeType.definition.metadata.name = '注册对象修改';
    const first = registry.get('test.text', 1);
    first.definition.metadata.name = '读取修改';
    first.definition.inputs[0]!.name = '端口修改';
    expect(registry.get('test.text', 1).definition.metadata.name).toBe('测试文本操作');
    expect(registry.get('test.text', 1).definition.inputs[0]!.name).toBe('文本');
    expect(Reflect.set(nodeType.definition, 'type', 'test.changed')).toBe(false);
  });
  it('保留受信任自定义编译器的 this 上下文', async () => {
    const custom = {
      definition: definition(),
      marker: '自定义依赖',
      compile() {
        const text = this.marker;
        return () => ({ output: { text } });
      },
    };
    const registry = new NodeRegistry<TestValue, TestUpdate>([custom]);
    expect((await graph(registry).invoke({ inputs: {} })).output).toEqual({ text: '自定义依赖' });
  });
  it('不同有效 Preset 复用同一操作实现，各自声明真实端口和校验契约', async () => {
    const operation = vi.fn(({ inputs }: { inputs: Record<string, unknown> }) => ({
      text: Object.values(inputs).join('、'),
    }));
    const registry = new NodeRegistry<TestValue, TestUpdate>();
    for (const key of ['subject', 'product']) {
      registry.register(
        createOperationNodeType(
          {
            ...definition(),
            inputs: [{ key, name: key, dataType: { kind: 'string' } }],
            ui: { config: definition().ui.config },
          },
          {
            preset: key,
            inputSchema: z.object({ [key]: z.string() }),
            outputSchema: values.outputSchema,
          },
          operation,
        ),
      );
      expect(
        (await graph(registry, instance(1, key)).invoke({ inputs: { [key]: key } })).output,
      ).toEqual({ text: key });
    }
    expect(operation).toHaveBeenCalledTimes(2);
    expect(() => registry.get('test.text', 1)).toThrow(
      expect.objectContaining({ code: 'unavailable_compiler' }),
    );
  });
});

describe('静态 DataType 兼容与真实值校验职责', () => {
  it('基础类型和媒体类型仅同种兼容，不进行隐式转换', () => {
    for (const kind of ['string', 'number', 'boolean', 'image', 'video', 'audio'] as const)
      expect(isDataTypeAssignable({ kind }, { kind })).toBe(true);
    expect(isDataTypeAssignable({ kind: 'video' }, { kind: 'image' })).toBe(false);
    expect(isDataTypeAssignable({ kind: 'string' }, { kind: 'image' })).toBe(false);
    expect(isDataTypeAssignable({ kind: 'number' }, { kind: 'string' })).toBe(false);
  });
  it('领域名称精确匹配，数组递归比较元素类型', () => {
    expect(isDataTypeAssignable({ kind: 'domain', name: 'character' }, { kind: 'image' })).toBe(
      false,
    );
    expect(
      isDataTypeAssignable(
        { kind: 'domain', name: 'character' },
        { kind: 'domain', name: 'scene' },
      ),
    ).toBe(false);
    expect(
      isDataTypeAssignable(
        { kind: 'array', item: { kind: 'video' } },
        { kind: 'array', item: { kind: 'video' } },
      ),
    ).toBe(true);
    expect(
      isDataTypeAssignable(
        { kind: 'array', item: { kind: 'video' } },
        { kind: 'array', item: { kind: 'image' } },
      ),
    ).toBe(false);
    expect(
      isDataTypeAssignable(
        { kind: 'array', item: { kind: 'domain', name: 'character' } },
        { kind: 'array', item: { kind: 'domain', name: 'character' } },
      ),
    ).toBe(true);
  });
});
