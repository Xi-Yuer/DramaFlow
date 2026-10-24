import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { StringType, type NodeTypeManifest } from '@dramaflow/contracts';
import { NodeRegistry, createOperationNodeType, DataTypeRegistry } from '../src/index.js';
const manifest = (): NodeTypeManifest => ({
  type: 'test.text',
  version: 1,
  executionKind: 'action',
  metadata: { name: '测试文本', category: 'data' },
  inputs: [{ key: 'text', name: '文本', dataType: StringType }],
  outputs: [{ key: 'text', name: '结果', dataType: StringType }],
  config: [],
});
const schemas = {
  inputSchema: z.object({ text: z.string() }),
  outputSchema: z.object({ text: z.string() }),
  configSchema: z.object({}),
};
const context = {
  scopeKey: 'root',
  projectId: 'p',
  workflowRunId: 'r',
  workflow: { inputs: [], nodes: [], edges: [], outputs: [] },
  state: {
    run: { workflowId: 'w', workflowVersionId: 'v', workflowRunId: 'r', projectId: 'p' },
    inputs: {},
    outputs: {},
    variables: {},
    execution: {},
  },
};

describe('NodeType 只负责业务 execute', () => {
  it('版本精确查找、重复与缺失失败，不用 Preset 注册运行身份', async () => {
    const registry = new NodeRegistry();
    for (const version of [1, 2])
      registry.register(
        createOperationNodeType({ ...manifest(), version }, schemas, ({ inputs }) => ({
          text: `${version}:${inputs.text}`,
        })),
      );
    expect(await registry.getAction('test.text', 1).execute({ text: '内容' }, {}, context)).toEqual(
      { text: '1:内容' },
    );
    expect(await registry.getAction('test.text', 2).execute({ text: '内容' }, {}, context)).toEqual(
      { text: '2:内容' },
    );
    expect(() => registry.get('test.text', 3)).toThrow('不可用');
    expect(() =>
      registry.register(createOperationNodeType(manifest(), schemas, () => ({}))),
    ).toThrow('已注册');
    expect(registry.get('test.text', 1)).not.toHaveProperty('compile');
  });
  it('保持原始 this 依赖及不可变 Manifest，公开目录不含可执行或私有字段', async () => {
    const original = {
      manifest: manifest(),
      ...schemas,
      secret: 'test-only-secret',
      async execute() {
        return { text: `${this.manifest.version}:${this.secret}` };
      },
    };
    const registry = new NodeRegistry([original]);
    expect(Reflect.set(original.manifest, 'version', 2)).toBe(false);
    expect(Reflect.set(original, 'manifest', { ...manifest(), version: 2 })).toBe(false);
    const listed = registry.listManifests();
    listed[0]!.metadata.name = '改动';
    expect(registry.listManifests()[0]!.metadata.name).toBe('测试文本');
    expect(await registry.getAction('test.text', 1).execute({}, {}, context)).toEqual({
      text: '1:test-only-secret',
    });
    expect(JSON.stringify(registry.listManifests())).not.toMatch(/secret|execute|Schema/);
  });
  it('控制结构可声明目录契约，但不强行实现普通 execute', () => {
    const registry = new NodeRegistry([
      { ...schemas, manifest: { ...manifest(), executionKind: 'interaction' } },
    ]);
    expect(registry.listManifests()[0]!.executionKind).toBe('interaction');
    expect(() => registry.getAction('test.text', 1)).toThrow('不是普通');
    expect(() => new NodeRegistry([{ ...schemas, manifest: manifest() }])).toThrow('必须提供');
  });
  it('声明与 Zod 字段不一致或默认值不被接受时拒绝注册', () => {
    const operation = vi.fn();
    expect(() =>
      createOperationNodeType(
        manifest(),
        { ...schemas, inputSchema: z.object({ wrong: z.string() }) },
        operation,
      ),
    ).toThrow('字段不一致');
    expect(() =>
      createOperationNodeType(
        { ...manifest(), config: [{ key: 'size', type: 'number', name: '大小', defaultValue: 3 }] },
        { ...schemas, configSchema: z.object({ size: z.number().max(2) }) },
        operation,
      ),
    ).toThrow();
    expect(operation).not.toHaveBeenCalled();
    expect(new NodeRegistry().listManifests()).toEqual([]);
  });
});

describe('命名数据类型注册', () => {
  it('Manifest 独立 JSON 副本，执行 Schema 仅在服务端，重复和未知名称明确失败', () => {
    const registry = new DataTypeRegistry();
    const definition = {
      manifest: {
        name: 'story.character',
        displayName: '角色',
        category: 'story',
        storage: 'auto' as const,
      },
      schema: z.object({ name: z.string() }).strict(),
    };
    registry.register(definition);
    definition.manifest.displayName = '改动';
    const list = registry.listManifests();
    list[0]!.displayName = '另一改动';
    expect(registry.get('story.character').manifest.displayName).toBe('角色');
    expect(JSON.stringify(registry.listManifests())).not.toContain('schema');
    expect(() => registry.register(definition)).toThrow('已注册');
    expect(() => registry.get('story.missing')).toThrow('不可用');
  });
  it('递归真实值校验，nullable 不等于缺失，any 仍不能携带非 JSON', () => {
    const registry = new DataTypeRegistry();
    registry.register({
      manifest: {
        name: 'story.character',
        displayName: '角色',
        category: 'story',
        storage: 'auto',
      },
      schema: z.object({ name: z.string() }).strict(),
    });
    const type = {
      kind: 'object',
      properties: {
        title: StringType,
        characters: { kind: 'array', itemType: { kind: 'named', name: 'story.character' } },
        note: { kind: 'union', types: [StringType, { kind: 'primitive', name: 'null' }] },
      },
    } as const;
    // 可变 descriptor 与共享协议一致，union types 是普通 JSON 数组。
    const descriptor = {
      ...type,
      properties: {
        ...type.properties,
        note: {
          kind: 'union' as const,
          types: [StringType, { kind: 'primitive' as const, name: 'null' as const }],
        },
      },
    };
    expect(
      registry.parse(descriptor, { title: '剧本', characters: [{ name: '林雪' }], note: null }),
    ).toHaveProperty('note', null);
    expect(() =>
      registry.parse(descriptor, { title: '剧本', characters: [{ name: 1 }], note: null }),
    ).toThrow();
    expect(() => registry.parse(descriptor, { title: '剧本', characters: [] })).toThrow();
    expect(() => registry.parse({ kind: 'any' }, new Uint8Array([1]))).toThrow();
  });
});
