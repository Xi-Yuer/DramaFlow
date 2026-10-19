import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  createNodeTypeManifest,
  createOperationNodeType,
  NodeRegistry,
  parseNodeTypeDefinition,
  type CompileContext,
  type NodeTypeDefinition,
} from '../src/index.js';

function definition() {
  return {
    type: 'test-text',
    preset: 'test-preset',
    displayName: '测试文本操作',
    category: 'test',
    inputSchema: z.object({ text: z.string() }),
    outputSchema: z.object({ text: z.string() }),
    configSchema: z.object({
      prefix: z.string(),
      temperature: z.number().min(0).max(2).default(0.5),
    }),
    ui: {
      icon: 'test-text-icon',
      fields: {
        prefix: { component: 'text', label: '前缀' },
        temperature: { component: 'slider', label: '温度', min: 0, max: 2, step: 0.1 },
      },
    },
  } satisfies NodeTypeDefinition;
}

// 显式测试 State，仅验证 Registry 产物可交给原生 LangGraph。
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

describe('NodeTypeDefinition 与独立 UI Schema', () => {
  it('UI 必须引用真实配置字段，不能把输入字段当作配置字段', () => {
    const source = definition();
    expect(() =>
      parseNodeTypeDefinition({
        ...source,
        ui: { fields: { text: { component: 'text' } } },
      }),
    ).toThrow(expect.objectContaining({ code: 'unknown_config_field' }));
  });

  it('类型端口遵守工作流绑定名称规则，不能注册无法保存的 Handle', () => {
    const unavailable: NodeTypeDefinition[] = [
      { ...definition(), inputSchema: z.object({ 'bad-handle': z.string() }) },
      { ...definition(), outputSchema: z.object({ constructor: z.string() }) },
    ];
    for (const contract of unavailable) {
      expect(() => parseNodeTypeDefinition(contract)).toThrow(z.ZodError);
    }
  });

  it('拒绝倒置范围、非法步长和非有限数值的滑块描述', () => {
    for (const slider of [
      { component: 'slider' as const, min: 2, max: 1 },
      { component: 'slider' as const, min: 0, max: 2, step: 0 },
      { component: 'slider' as const, min: 0, max: 2, step: -1 },
      { component: 'slider' as const, min: 0, max: Infinity },
    ]) {
      expect(() =>
        parseNodeTypeDefinition({ ...definition(), ui: { fields: { temperature: slider } } }),
      ).toThrow(z.ZodError);
    }
  });

  it('UI 描述不接受脚本等额外属性', () => {
    const unsafe = {
      ...definition(),
      ui: {
        fields: {
          prefix: { component: 'text' as const, execute: () => '不应传往浏览器' },
        },
      },
    };
    expect(() => parseNodeTypeDefinition(unsafe)).toThrow(z.ZodError);
  });

  it('只复制公开元数据，保留可继续执行校验的服务端 Zod 实例', () => {
    const source = definition();
    const parsed = parseNodeTypeDefinition(source);
    parsed.displayName = '修改后的名称';
    parsed.ui.fields.prefix!.label = '修改后的标签';
    expect(source.displayName).toBe('测试文本操作');
    expect(source.ui.fields.prefix.label).toBe('前缀');
    expect(parsed.configSchema).toBe(source.configSchema);
    expect(parsed.configSchema.parse({ prefix: '测试' })).toEqual({
      prefix: '测试',
      temperature: 0.5,
    });
  });
});

describe('浏览器安全 NodeType manifest', () => {
  it('显式投影可传输 JSON，不泄露执行属性或全局及嵌套 Schema 元数据', () => {
    const source = definition();
    const serverDefinition = {
      ...source,
      inputSchema: source.inputSchema.meta({
        type: 'number',
        privateMetadata: 'synthetic-server-only-metadata',
      }),
      configSchema: source.configSchema.extend({
        prefix: z.string().meta({ privateMetadata: 'synthetic-field-only-metadata' }),
      }),
      compile: vi.fn(),
      operation: vi.fn(),
      serverSecret: 'synthetic-server-only-property',
    };
    const manifest = createNodeTypeManifest(serverDefinition);
    const serialized = JSON.stringify(manifest);
    expect(z.record(z.string(), z.json()).parse(manifest)).toEqual(manifest);
    expect(Object.keys(manifest).sort()).toEqual(
      [
        'type',
        'preset',
        'displayName',
        'category',
        'ui',
        'inputSchema',
        'outputSchema',
        'configSchema',
      ].sort(),
    );
    expect(manifest.inputSchema).toMatchObject({ type: 'object' });
    expect(manifest.configSchema).toMatchObject({
      properties: { prefix: { type: 'string' } },
    });
    for (const privateValue of [
      'compile',
      'operation',
      'serverSecret',
      'privateMetadata',
      'synthetic-server-only',
      'synthetic-field-only',
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
    expect(serverDefinition.compile).not.toHaveBeenCalled();
    expect(serverDefinition.operation).not.toHaveBeenCalled();

    manifest.ui.fields.prefix!.label = '客户端修改';
    expect(source.ui.fields.prefix.label).toBe('前缀');
  });

  it('输入和配置描述原始输入，输出描述转换后的值，并区分默认字段的必填性', () => {
    const manifest = createNodeTypeManifest({
      ...definition(),
      inputSchema: z.object({
        amount: z.string().transform(Number),
        note: z.string().default('输入默认值'),
      }),
      configSchema: z.object({
        prefix: z.string().default('默认前缀'),
        temperature: z.string().transform(Number),
      }),
      outputSchema: z.object({
        amount: z.string().transform(Number).pipe(z.number()),
        note: z.string().default('输出默认值'),
      }),
    });
    expect(manifest.inputSchema).toMatchObject({
      properties: { amount: { type: 'string' }, note: { type: 'string', default: '输入默认值' } },
      required: ['amount'],
      additionalProperties: false,
    });
    expect(manifest.configSchema).toMatchObject({
      properties: { prefix: { default: '默认前缀' }, temperature: { type: 'string' } },
      required: ['temperature'],
      additionalProperties: false,
    });
    expect(manifest.outputSchema).toMatchObject({
      properties: { amount: { type: 'number' }, note: { type: 'string', default: '输出默认值' } },
      required: ['amount', 'note'],
      additionalProperties: false,
    });
  });

  it('无法表达的输入、配置或输出 Schema 明确报错，不替换为空契约', () => {
    const source = definition();
    for (const unavailable of [
      { ...source, inputSchema: z.object({ text: z.date() }) },
      { ...source, configSchema: source.configSchema.extend({ count: z.bigint() }) },
      { ...source, outputSchema: z.object({ text: z.string().transform(Number) }) },
    ]) {
      expect(() => createNodeTypeManifest(unavailable)).toThrow();
    }
  });

  it('JSON Schema 不代替未被完整投影的服务端业务校验', () => {
    const source = {
      ...definition(),
      configSchema: definition().configSchema.refine(
        (config) => config.prefix !== '禁止值',
        '测试业务限制',
      ),
    };
    expect(createNodeTypeManifest(source).configSchema).toMatchObject({ type: 'object' });
    expect(() => source.configSchema.parse({ prefix: '禁止值' })).toThrow(z.ZodError);
  });
});

describe('NodeType 注册与复用', () => {
  it('注册和读取均隔离元数据修改，不改变原目录中的名称或 UI', () => {
    const source = definition();
    const nodeType = createOperationNodeType(source, ({ inputs }) => ({ text: inputs.text }));
    const registry = new NodeRegistry<TestValue, TestUpdate>();
    registry.register(nodeType);

    source.displayName = '源对象修改';
    source.ui.fields.prefix.label = '源对象 UI 修改';
    expect(Reflect.set(nodeType.definition, 'displayName', '注册后修改')).toBe(false);
    nodeType.definition.ui.fields.prefix!.label = '注册后 UI 修改';
    const first = registry.get('test-text', 'test-preset');
    expect(first.definition.displayName).toBe('测试文本操作');
    expect(first.definition.ui.fields.prefix!.label).toBe('前缀');

    first.definition.displayName = '读取结果修改';
    first.definition.ui.fields.prefix!.label = '读取结果 UI 修改';
    const second = registry.get('test-text', 'test-preset');
    expect(second.definition.displayName).toBe('测试文本操作');
    expect(second.definition.ui.fields.prefix!.label).toBe('前缀');
    expect(() => registry.get('missing-type')).toThrow(
      expect.objectContaining({ code: 'unavailable_compiler' }),
    );
  });

  it('空目录可以注册新类型并直接执行，无需修改中央分派逻辑', async () => {
    const registry = new NodeRegistry<TestValue, TestUpdate>();
    const invoke = vi.fn(({ inputs }: { inputs: { text: string } }) => ({
      text: inputs.text.toUpperCase(),
    }));
    registry.register(
      createOperationNodeType(
        { ...definition(), type: 'test-uppercase', preset: undefined, displayName: '测试转大写' },
        invoke,
      ),
    );
    const registered = registry.get('test-uppercase');
    expect(registered.definition.displayName).toBe('测试转大写');
    expect(invoke).not.toHaveBeenCalled();
    const graph = new StateGraph(TestState)
      .addNode(
        'registered',
        registry.compile(
          {
            id: 'uppercase',
            type: 'test-uppercase',
            name: '测试节点',
            inputs: [],
            config: { prefix: '' },
          },
          context,
        ),
      )
      .addEdge(START, 'registered')
      .addEdge('registered', END)
      .compile();

    expect((await graph.invoke({ inputs: { text: 'hello' } })).output).toEqual({ text: 'HELLO' });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('不同 Preset 可以声明各自契约并共用同一个值操作', async () => {
    const invoke = vi.fn(
      ({ inputs, config }: { inputs: Record<string, unknown>; config: { prefix: string } }) => ({
        text: config.prefix + Object.values(inputs).join('、'),
      }),
    );
    const registry = new NodeRegistry<TestValue, TestUpdate>();
    registry.register(
      createOperationNodeType(
        { ...definition(), preset: 'story', inputSchema: z.object({ subject: z.string() }) },
        invoke,
      ),
    );
    registry.register(
      createOperationNodeType(
        {
          ...definition(),
          preset: 'advertisement',
          inputSchema: z.object({ product: z.string() }),
        },
        invoke,
      ),
    );

    for (const selection of [
      { preset: 'story', inputs: { subject: '故事主题' }, expected: 'story：故事主题' },
      {
        preset: 'advertisement',
        inputs: { product: '测试商品' },
        expected: 'advertisement：测试商品',
      },
    ]) {
      const graph = new StateGraph(TestState)
        .addNode(
          'operation',
          registry.compile(
            {
              id: selection.preset,
              type: 'test-text',
              preset: selection.preset,
              name: '测试预设节点',
              inputs: [],
              config: { prefix: `${selection.preset}：` },
            },
            context,
          ),
        )
        .addEdge(START, 'operation')
        .addEdge('operation', END)
        .compile();
      expect((await graph.invoke({ inputs: selection.inputs })).output).toEqual({
        text: selection.expected,
      });
    }
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(() => registry.get('test-text')).toThrow(
      expect.objectContaining({ code: 'unavailable_compiler' }),
    );
  });
});
