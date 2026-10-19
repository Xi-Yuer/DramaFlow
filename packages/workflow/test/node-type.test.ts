import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { NodeTypeManifest } from '@dramaflow/contracts';
import {
  createOperationNodeType,
  isDataTypeAssignable,
  NodeRegistry,
  parseNodeManifest,
  type CompileContext,
  type NodeSchemas,
} from '../src/index.js';

function manifest(): NodeTypeManifest {
  return {
    type: 'test.text',
    version: 1,
    metadata: { name: '测试文本操作', category: 'data', icon: 'text' },
    inputs: [{ key: 'text', name: '文本', dataType: { kind: 'string' }, required: true }],
    outputs: [{ key: 'text', name: '结果', dataType: { kind: 'string' } }],
    config: [
      { key: 'prefix', type: 'string', name: '前缀', ui: { component: 'text' } },
      {
        key: 'temperature',
        type: 'number',
        name: '温度',
        defaultValue: 0.5,
        min: 0,
        max: 2,
        ui: { component: 'slider' },
      },
    ],
    ui: { inputs: { text: { component: 'textarea' } } },
  };
}
const schemas = {
  inputSchema: z.object({ text: z.string() }),
  outputSchema: z.object({ text: z.string() }),
  configSchema: z.object({
    prefix: z.string(),
    temperature: z.number().min(0).max(2).default(0.5),
  }),
};
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
    inputs: {},
    config: { prefix: '测试：' },
    ui: { position: { x: 0, y: 0 } },
  };
}
function graph(registry: NodeRegistry<TestValue, TestUpdate>, node = instance()) {
  return new StateGraph(TestState)
    .addNode('operation', registry.compile(node, context))
    .addEdge(START, 'operation')
    .addEdge('operation', END)
    .compile();
}

describe('公开 Manifest 与服务端 NodeType', () => {
  it('公开描述可独立JSON往返，不接受Zod或可执行字段', () => {
    const source = manifest();
    const parsed = parseNodeManifest(JSON.parse(JSON.stringify(source)));
    expect(parsed).toEqual(source);
    for (const addition of [
      { configSchema: schemas.configSchema },
      { compile: () => ({}) },
      { inputSchema: schemas.inputSchema },
    ]) {
      expect(() => parseNodeManifest({ ...source, ...addition })).toThrow(z.ZodError);
    }
    parsed.metadata.name = '客户端修改';
    expect(source.metadata.name).toBe('测试文本操作');
  });
  it('输入输出与配置的声明键必须分别匹配真实Schema', () => {
    const invalid: NodeSchemas[] = [
      { ...schemas, inputSchema: z.object({ other: z.string() }) },
      { ...schemas, outputSchema: z.object({ text: z.string(), extra: z.string() }) },
      { ...schemas, configSchema: z.object({ prefix: z.string() }) },
    ];
    for (const values of invalid)
      expect(() => createOperationNodeType(manifest(), values, () => ({ text: '' }))).toThrow(
        expect.objectContaining({
          code:
            values.configSchema === schemas.configSchema
              ? 'port_schema_mismatch'
              : 'config_schema_mismatch',
        }),
      );
  });
  it('公开配置默认值必须被服务端对应字段接受，但不会修改实例', () => {
    expect(() =>
      createOperationNodeType(
        manifest(),
        {
          ...schemas,
          configSchema: schemas.configSchema.extend({ temperature: z.number().max(0.1) }),
        },
        () => ({ text: '' }),
      ),
    ).toThrow(z.ZodError);
    const source = instance();
    const registry = new NodeRegistry<TestValue, TestUpdate>([
      createOperationNodeType(manifest(), schemas, ({ inputs }) => ({ text: inputs.text })),
    ]);
    registry.compile(source, context);
    expect(source.config).toEqual({ prefix: '测试：' });
  });
  it('Binding常量仅为定义描述，尚未设计的State适配不会自动求值', async () => {
    const invoke = vi.fn(({ inputs }: { inputs: { text: string } }) => ({ text: inputs.text }));
    const registry = new NodeRegistry<TestValue, TestUpdate>([
      createOperationNodeType(manifest(), schemas, invoke),
    ]);
    const node = { ...instance(), inputs: { text: { type: 'constant', value: '固定内容' } } };
    await expect(graph(registry, node).invoke({ inputs: {} })).rejects.toBeInstanceOf(z.ZodError);
    expect(invoke).not.toHaveBeenCalled();
  });
  it('目录只返回Manifest复制，不暴露执行实现、私有字段或Schema元数据', () => {
    const source = manifest();
    const implementation = {
      ...createOperationNodeType(source, schemas, ({ inputs }) => ({ text: inputs.text })),
      serverCredential: 'synthetic-private-value',
    };
    const registry = new NodeRegistry<TestValue, TestUpdate>([implementation]);
    const listed = registry.listManifests();
    const json = JSON.stringify(listed);
    expect(z.array(z.json()).parse(listed)).toEqual([source]);
    for (const name of [
      'serverCredential',
      'synthetic-private-value',
      'compile',
      'inputSchema',
      'outputSchema',
      'configSchema',
    ])
      expect(json).not.toContain(name);
    listed[0]!.config[0]!.name = '目录修改';
    source.metadata.name = '源修改';
    registry.get('test.text', 1).manifest.metadata.name = '读取修改';
    expect(registry.listManifests()[0]!.metadata.name).toBe('测试文本操作');
    expect(registry.listManifests()[0]!.config[0]!.name).toBe('前缀');
  });
  it('空目录返回真实空数组，不注册虚构模型或触发编译', () => {
    const registry = new NodeRegistry<TestValue, TestUpdate>();
    expect(registry.listManifests()).toEqual([]);
    expect(() => registry.get('ai.llm', 1)).toThrow(
      expect.objectContaining({ code: 'unavailable_type' }),
    );
  });
});

describe('按类型版本注册，不以Preset作为执行身份', () => {
  it('多个版本并存，未知版本明确失败，不选择最新版', async () => {
    const registry = new NodeRegistry<TestValue, TestUpdate>();
    for (const version of [1, 2])
      registry.register(
        createOperationNodeType({ ...manifest(), version }, schemas, ({ inputs }) => ({
          text: `${version}:${inputs.text}`,
        })),
      );
    for (const version of [1, 2])
      expect(
        (await graph(registry, instance(version)).invoke({ inputs: { text: '内容' } })).output,
      ).toEqual({ text: `${version}:内容` });
    expect(() => registry.compile(instance(3), context)).toThrow(
      expect.objectContaining({ code: 'unavailable_type' }),
    );
    expect(() => registry.get('test.text', 0)).toThrow(z.ZodError);
    expect(() =>
      registry.register(createOperationNodeType(manifest(), schemas, () => ({ text: '' }))),
    ).toThrow(expect.objectContaining({ code: 'duplicate_type' }));
  });
  it('多个Preset配置复用一个类型实现，配置应用与类型查找分离', async () => {
    const operation = vi.fn(
      ({ inputs, config }: { inputs: { text: string }; config: { prefix: string } }) => ({
        text: config.prefix + inputs.text,
      }),
    );
    const registry = new NodeRegistry<TestValue, TestUpdate>([
      createOperationNodeType(manifest(), schemas, operation),
    ]);
    for (const preset of ['story', 'advertisement']) {
      const node = { ...instance(1, preset), config: { prefix: `${preset}:` } };
      expect((await graph(registry, node).invoke({ inputs: { text: '内容' } })).output).toEqual({
        text: `${preset}:内容`,
      });
    }
    expect(registry.listManifests()).toHaveLength(1);
    expect(operation).toHaveBeenCalledTimes(2);
  });
  it('受信任自定义编译器保留this依赖，但不会将该依赖发布给客户端', async () => {
    const custom = {
      manifest: manifest(),
      ...schemas,
      marker: '自定义依赖',
      compile() {
        const text = `${this.manifest.version}:${this.marker}`;
        return () => ({ output: { text } });
      },
    };
    const registry = new NodeRegistry<TestValue, TestUpdate>([custom]);
    expect(Reflect.set(custom.manifest, 'version', 2)).toBe(false);
    expect(Reflect.set(custom, 'manifest', { ...manifest(), version: 2 })).toBe(false);
    expect((await graph(registry).invoke({ inputs: {} })).output).toEqual({ text: '1:自定义依赖' });
    expect(new NodeRegistry<TestValue, TestUpdate>([custom]).listManifests()[0]!.version).toBe(1);
    expect(JSON.stringify(registry.listManifests())).not.toContain('自定义依赖');
  });
});

describe('V1 DataType仅用于静态兼容', () => {
  it('基础与媒体类型同种兼容，json/file不隐式提升或转换', () => {
    for (const kind of [
      'string',
      'number',
      'boolean',
      'json',
      'image',
      'video',
      'audio',
      'file',
    ] as const)
      expect(isDataTypeAssignable({ kind }, { kind })).toBe(true);
    for (const pair of [
      ['video', 'image'],
      ['image', 'file'],
      ['string', 'json'],
      ['json', 'string'],
    ] as const)
      expect(isDataTypeAssignable({ kind: pair[0] }, { kind: pair[1] })).toBe(false);
  });
  it('any放宽双向静态检查，仍不能绕过服务端真实值契约', async () => {
    expect(isDataTypeAssignable({ kind: 'any' }, { kind: 'image' })).toBe(true);
    expect(isDataTypeAssignable({ kind: 'video' }, { kind: 'any' })).toBe(true);
    const registry = new NodeRegistry<TestValue, TestUpdate>([
      createOperationNodeType(manifest(), schemas, ({ inputs }) => ({ text: inputs.text })),
    ]);
    await expect(graph(registry).invoke({ inputs: { text: 123 } })).rejects.toBeInstanceOf(
      z.ZodError,
    );
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
