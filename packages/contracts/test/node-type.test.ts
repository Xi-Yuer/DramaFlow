import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  configFieldDefinitionSchema,
  isNodeVisibleInCatalog,
  dataTypeSchema,
  inputPortDefinitionSchema,
  isTypeAssignable,
  nodeCategorySchema,
  nodeTypeIdSchema,
  nodeTypeManifestSchema,
  nodeTypeManifestListSchema,
  nodeTypeVersionSchema,
  outputPortDefinitionSchema,
} from '../src/index.js';

function manifest() {
  return {
    type: 'video.image_to_video',
    version: 1,
    executionKind: 'action',
    metadata: {
      name: '图生视频',
      description: '根据首帧和提示词生成视频',
      category: 'video',
      icon: 'video',
    },
    inputs: [
      {
        key: 'image',
        name: '首帧',
        description: '图片资产引用',
        dataType: { kind: 'named', name: 'media.image' },
        required: true,
      },
      {
        key: 'prompt',
        name: '提示词',
        dataType: { kind: 'primitive', name: 'string' },
        required: true,
      },
      { key: 'duration', name: '时长', dataType: { kind: 'primitive', name: 'number' } },
    ],
    outputs: [
      {
        key: 'video',
        name: '视频',
        description: '生成结果',
        dataType: { kind: 'named', name: 'media.video' },
      },
    ],
    config: [
      {
        key: 'resolution',
        name: '分辨率',
        type: 'select',
        options: [
          { label: '720P', value: '720p' },
          { label: '1080P', value: '1080p' },
        ],
        defaultValue: '1080p',
      },
      {
        key: 'temperature',
        name: 'Temperature',
        type: 'number',
        min: 0,
        max: 2,
        defaultValue: 0.7,
        ui: { component: 'slider' },
      },
    ],
    capabilities: [{ type: 'video.image_to_video' }],
    ui: {
      color: 'video',
      inputs: { prompt: { component: 'textarea', placeholder: '填写提示词' } },
    },
  };
}

describe('可序列化 DataType 声明', () => {
  it('共用兼容检查只允许目标 any 放宽约束，递归数组仍遵守相同方向', () => {
    expect(isTypeAssignable({ kind: 'any' }, { kind: 'named', name: 'media.image' })).toBe(false);
    expect(isTypeAssignable({ kind: 'named', name: 'media.image' }, { kind: 'any' })).toBe(true);
    expect(
      isTypeAssignable(
        { kind: 'array', itemType: { kind: 'any' } },
        { kind: 'array', itemType: { kind: 'named', name: 'media.image' } },
      ),
    ).toBe(false);
    expect(
      isTypeAssignable(
        { kind: 'array', itemType: { kind: 'named', name: 'media.image' } },
        { kind: 'array', itemType: { kind: 'any' } },
      ),
    ).toBe(true);
  });

  it('支持基础、命名、结构及递归集合，不使用 Zod 实例充当类型', () => {
    const types = [
      { kind: 'any' },
      { kind: 'named', name: 'system.json' },
      { kind: 'named', name: 'media.file' },
      { kind: 'named', name: 'media.image' },
      { kind: 'primitive', name: 'string' },
      { kind: 'primitive', name: 'number' },
      { kind: 'primitive', name: 'boolean' },
      { kind: 'primitive', name: 'null' },
      { kind: 'object', properties: { title: { kind: 'primitive', name: 'string' } } },
      {
        kind: 'union',
        types: [
          { kind: 'primitive', name: 'string' },
          { kind: 'primitive', name: 'null' },
        ],
      },
    ];
    for (const type of types) expect(dataTypeSchema.parse(type)).toEqual(type);
    const nested = {
      kind: 'array',
      itemType: { kind: 'array', itemType: { kind: 'named', name: 'story.shot' } },
    };
    expect(dataTypeSchema.parse(JSON.parse(JSON.stringify(nested)))).toEqual(nested);
    expect(dataTypeSchema.safeParse(z.string()).success).toBe(false);
  });

  it('拒绝不完整描述、旧式 kind、额外字段和无效命名空间', () => {
    for (const value of [
      { kind: 'union' },
      { kind: 'object' },
      { kind: 'named', name: 'media.image', url: 'https://example.com/image.png' },
      { kind: 'array' },
      { kind: 'array', itemType: { kind: 'unknown' } },
      { kind: 'named', name: '' },
      { kind: 'named', name: ' shot ' },
    ])
      expect(dataTypeSchema.safeParse(value).success).toBe(false);
  });
});

describe('配置字段声明', () => {
  it('四类配置字段携带类型正确的默认值，控件不重复保存数值边界', () => {
    for (const field of [
      {
        key: 'prompt',
        name: '提示词',
        type: 'string',
        defaultValue: '',
        required: true,
        ui: { component: 'textarea' },
      },
      {
        key: 'temperature',
        name: 'Temperature',
        type: 'number',
        defaultValue: 0.7,
        min: 0,
        max: 2,
        ui: { component: 'slider' },
      },
      {
        key: 'enabled',
        name: '启用',
        type: 'boolean',
        defaultValue: false,
        ui: { component: 'switch' },
      },
      {
        key: 'mode',
        name: '模式',
        type: 'select',
        options: [{ label: '默认', value: 'default' }],
        defaultValue: 'default',
      },
    ])
      expect(configFieldDefinitionSchema.parse(field)).toEqual(field);
  });

  it('拒绝默认值类型错误、非 JSON 值及超出数值范围', () => {
    const base = { key: 'value', name: '值' };
    for (const field of [
      { ...base, type: 'string', defaultValue: 1 },
      { ...base, type: 'number', defaultValue: '1' },
      { ...base, type: 'boolean', defaultValue: 0 },
      { ...base, type: 'number', defaultValue: Infinity },
      { ...base, type: 'number', min: 10, max: 1 },
      { ...base, type: 'number', min: 0, defaultValue: -1 },
      { ...base, type: 'number', max: 1, defaultValue: 2 },
      { ...base, type: 'string', defaultValue: new Date() },
      { ...base, type: 'string', defaultValue: () => 'text' },
      { ...base, type: 'string', defaultValue: BigInt(1) },
    ])
      expect(configFieldDefinitionSchema.safeParse(field).success).toBe(false);
  });

  it('select 要求非空、无重复字符串选项且默认值属于选项', () => {
    const field = { key: 'mode', name: '模式', type: 'select' };
    for (const extra of [
      { options: [] },
      { options: [{ label: '数值', value: 1 }] },
      {
        options: [
          { label: '甲', value: 'same' },
          { label: '乙', value: 'same' },
        ],
      },
      { options: [{ label: '甲', value: 'a' }], defaultValue: 'b' },
    ])
      expect(configFieldDefinitionSchema.safeParse({ ...field, ...extra }).success).toBe(false);
  });
});

describe('NodeTypeManifest 公开协议', () => {
  it('Catalog 暴露和产品分类是独立 JSON metadata；未声明类型默认不可创建', () => {
    const source = manifest();
    const undeclared = nodeTypeManifestSchema.parse(source);
    expect(isNodeVisibleInCatalog(undeclared)).toBe(false);
    expect(isNodeVisibleInCatalog(undeclared, 'advanced')).toBe(false);
    for (const exposure of ['public', 'advanced', 'internal'] as const) {
      for (const category of ['ai', 'data', 'workflow', 'advanced'] as const) {
        const value = {
          ...source,
          metadata: { ...source.metadata, catalog: { exposure, category } },
        };
        const parsed = nodeTypeManifestSchema.parse(JSON.parse(JSON.stringify(value)));
        expect(parsed).toEqual(value);
        expect(isNodeVisibleInCatalog(parsed)).toBe(exposure === 'public');
        expect(isNodeVisibleInCatalog(parsed, 'advanced')).toBe(exposure !== 'internal');
      }
    }
    for (const catalog of [
      {},
      { exposure: 'public' },
      { exposure: 'unknown', category: 'data' },
      { exposure: 'public', category: 'runtime' },
      { exposure: 'public', category: 'data', execute: true },
    ]) {
      expect(
        nodeTypeManifestSchema.safeParse({ ...source, metadata: { ...source.metadata, catalog } })
          .success,
      ).toBe(false);
    }
  });

  it('输出端口可声明存储策略，省略时保持省略，由 Runtime 采用 auto', () => {
    const port = { key: 'video', name: '视频', dataType: { kind: 'named', name: 'media.video' } };
    expect(outputPortDefinitionSchema.parse(port)).toEqual(port);
    for (const storagePolicy of ['inline', 'reference', 'auto']) {
      const output = { ...port, storagePolicy };
      expect(outputPortDefinitionSchema.parse(output)).toEqual(output);
      expect(nodeTypeManifestSchema.parse({ ...manifest(), outputs: [output] }).outputs).toEqual([
        output,
      ]);
    }
    expect(outputPortDefinitionSchema.safeParse({ ...port, storagePolicy: 'size' }).success).toBe(
      false,
    );
    expect(inputPortDefinitionSchema.safeParse({ ...port, storagePolicy: 'auto' }).success).toBe(
      false,
    );
  });
  it('目录允许多个明确版本并存，拒绝同类型同版本的重复声明', () => {
    const source = manifest();
    expect(nodeTypeManifestListSchema.parse([])).toEqual([]);
    expect(nodeTypeManifestListSchema.parse([source, { ...source, version: 2 }])).toHaveLength(2);
    expect(() => nodeTypeManifestListSchema.parse([source, source])).toThrow('重复类型版本');
  });

  it('完整 Manifest 按 JSON 往返，输入 UI 与字段配置 UI 各有一个来源', () => {
    const source = manifest();
    const parsed = nodeTypeManifestSchema.parse(JSON.parse(JSON.stringify(source)));
    expect(parsed).toEqual(source);
    expect(parsed.ui?.inputs?.prompt).toMatchObject({ component: 'textarea' });
    expect(parsed.config.find((field) => field.key === 'temperature')?.ui).toEqual({
      component: 'slider',
    });
    expect(nodeTypeManifestSchema.parse({ ...source, ui: undefined }).type).toBe(source.type);
  });

  it('名称可改但类型身份稳定，分类只支持八种已定义类别', () => {
    const source = manifest();
    expect(
      nodeTypeManifestSchema.parse({
        ...source,
        executionKind: 'action',
        metadata: { ...source.metadata, name: '生成镜头' },
      }).type,
    ).toBe(source.type);
    for (const category of ['input', 'ai', 'image', 'video', 'audio', 'flow', 'data', 'output']) {
      expect(nodeCategorySchema.parse(category)).toBe(category);
    }
    expect(
      nodeTypeManifestSchema.safeParse({
        ...source,
        executionKind: 'action',
        metadata: { ...source.metadata, category: 'custom' },
      }).success,
    ).toBe(false);
    expect(
      nodeTypeManifestSchema.safeParse({ ...source, metadata: { ...source.metadata, name: ' ' } })
        .success,
    ).toBe(false);
  });

  it('要求命名空间类型及正整数版本', () => {
    for (const type of ['ai.llm', 'video.image_to_video', 'flow.human_review', 'ai.v2.agent'])
      expect(nodeTypeIdSchema.parse(type)).toBe(type);
    for (const type of ['llm', 'AI.llm', 'ai.', '.llm', 'ai..llm', 'ai.text-generation', ' ai.llm'])
      expect(nodeTypeIdSchema.safeParse(type).success).toBe(false);
    for (const version of [undefined, 0, -1, 1.5, Infinity, '1']) {
      expect(nodeTypeVersionSchema.safeParse(version).success).toBe(false);
      expect(nodeTypeManifestSchema.safeParse({ ...manifest(), version }).success).toBe(false);
    }
  });

  it('分别拒绝输入、输出和配置中重复 key，允许不同方向同名', () => {
    const source = manifest();
    for (const group of ['inputs', 'outputs', 'config'] as const) {
      expect(
        nodeTypeManifestSchema.safeParse({
          ...source,
          [group]: [...source[group], source[group][0]],
        }).success,
      ).toBe(false);
    }
    expect(
      nodeTypeManifestSchema.parse({
        ...source,
        outputs: [{ key: 'image', name: '图片', dataType: { kind: 'named', name: 'media.image' } }],
      }).outputs[0]?.key,
    ).toBe('image');
  });

  it('端口 key 安全、UI 引用现有输入，端口不再含默认值', () => {
    const source = manifest();
    for (const key of ['bad-handle', '', 'constructor']) {
      expect(
        inputPortDefinitionSchema.safeParse({
          key,
          name: '输入',
          dataType: { kind: 'primitive', name: 'string' },
        }).success,
      ).toBe(false);
    }
    expect(
      inputPortDefinitionSchema.safeParse({
        key: 'duration',
        name: '时长',
        dataType: { kind: 'primitive', name: 'number' },
        defaultValue: 5,
      }).success,
    ).toBe(false);
    expect(
      inputPortDefinitionSchema.safeParse({
        key: 'duration',
        name: '时长',
        dataType: { kind: 'primitive', name: 'number' },
        multiple: true,
      }).success,
    ).toBe(false);
    expect(
      nodeTypeManifestSchema.safeParse({
        ...source,
        ui: { inputs: { missing: { component: 'text' } } },
      }).success,
    ).toBe(false);
  });

  it('能力只有无重复稳定类型，不接受供应商绑定', () => {
    const source = manifest();
    expect(nodeTypeManifestSchema.parse({ ...source, capabilities: [] }).capabilities).toEqual([]);
    for (const capabilities of [
      [{ type: 'video.image_to_video' }, { type: 'video.image_to_video' }],
      [{ type: 'image_to_video' }],
      [{ type: 'video.image_to_video', provider: 'vendor' }],
    ])
      expect(nodeTypeManifestSchema.safeParse({ ...source, capabilities }).success).toBe(false);
  });

  it('拒绝 Zod、旧配置 JSON Schema、UI 双重配置来源与可执行字段', () => {
    const source = manifest();
    for (const value of [
      { ...source, configSchema: { type: 'object' } },
      { ...source, inputSchema: z.object({}) },
      { ...source, config: z.object({}) },
      { ...source, execute: () => ({}) },
      { ...source, ui: { fields: {} } },
      { ...source, ui: { config: {} } },
      { ...source, ui: { inputs: { prompt: { component: 'https://example.com/widget.js' } } } },
      { ...source, ui: { inputs: { prompt: { component: () => null } } } },
      { ...source, ui: { inputs: { duration: { component: 'slider', min: 1, max: 10 } } } },
    ])
      expect(nodeTypeManifestSchema.safeParse(value).success).toBe(false);
  });
});
