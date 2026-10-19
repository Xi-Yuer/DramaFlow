import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  configFieldDefinitionSchema,
  dataTypeSchema,
  inputPortDefinitionSchema,
  nodeCategorySchema,
  nodeTypeIdSchema,
  nodeTypeManifestSchema,
  nodeTypeVersionSchema,
} from '../src/index.js';

function manifest() {
  return {
    type: 'video.image_to_video',
    version: 1,
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
        dataType: { kind: 'image' },
        required: true,
      },
      { key: 'prompt', name: '提示词', dataType: { kind: 'string' }, required: true },
      { key: 'duration', name: '时长', dataType: { kind: 'number' }, multiple: false },
    ],
    outputs: [{ key: 'video', name: '视频', description: '生成结果', dataType: { kind: 'video' } }],
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
  it('支持 any / json / file、基础媒体和递归领域集合，不使用 Zod 实例充当类型', () => {
    for (const kind of [
      'any',
      'json',
      'file',
      'string',
      'number',
      'boolean',
      'image',
      'video',
      'audio',
    ]) {
      expect(dataTypeSchema.parse({ kind })).toEqual({ kind });
    }
    const nested = {
      kind: 'array',
      item: { kind: 'array', item: { kind: 'domain', name: 'shot' } },
    };
    expect(dataTypeSchema.parse(JSON.parse(JSON.stringify(nested)))).toEqual(nested);
    expect(dataTypeSchema.safeParse(z.string()).success).toBe(false);
  });

  it('拒绝复杂类型扩展、额外字段、缺失元素类型和无效领域标识', () => {
    for (const value of [
      { kind: 'union' },
      { kind: 'object' },
      { kind: 'image', url: 'https://example.com/image.png' },
      { kind: 'array' },
      { kind: 'array', item: { kind: 'unknown' } },
      { kind: 'domain', name: '' },
      { kind: 'domain', name: ' shot ' },
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
        metadata: { ...source.metadata, name: '生成镜头' },
      }).type,
    ).toBe(source.type);
    for (const category of ['input', 'ai', 'image', 'video', 'audio', 'flow', 'data', 'output']) {
      expect(nodeCategorySchema.parse(category)).toBe(category);
    }
    expect(
      nodeTypeManifestSchema.safeParse({
        ...source,
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
        outputs: [{ key: 'image', name: '图片', dataType: { kind: 'image' } }],
      }).outputs[0]?.key,
    ).toBe('image');
  });

  it('端口 key 安全、UI 引用现有输入，端口不再含默认值', () => {
    const source = manifest();
    for (const key of ['bad-handle', '', 'constructor']) {
      expect(
        inputPortDefinitionSchema.safeParse({ key, name: '输入', dataType: { kind: 'string' } })
          .success,
      ).toBe(false);
    }
    expect(
      inputPortDefinitionSchema.safeParse({
        key: 'duration',
        name: '时长',
        dataType: { kind: 'number' },
        defaultValue: 5,
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
