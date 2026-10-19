import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  dataTypeSchema,
  inputPortDefinitionSchema,
  nodeTypeDeclarationSchema,
  nodeTypeIdSchema,
  nodeTypeManifestSchema,
  nodeTypeVersionSchema,
} from '../src/index.js';

function declaration() {
  return {
    type: 'video.image_to_video',
    version: 1,
    metadata: {
      name: '图生视频',
      description: '根据首帧图片和提示词生成视频',
      category: 'video',
      icon: 'video',
    },
    inputs: [
      { key: 'image', name: '首帧图片', dataType: { kind: 'image' }, required: true },
      { key: 'prompt', name: '提示词', dataType: { kind: 'string' }, required: true },
      { key: 'duration', name: '时长', dataType: { kind: 'number' }, defaultValue: 5 },
    ],
    outputs: [{ key: 'video', name: '视频', dataType: { kind: 'video' } }],
    capabilities: [{ type: 'video.image_to_video' }],
    ui: {
      color: 'video',
      inputs: {
        prompt: { component: 'textarea' },
        duration: { component: 'slider', min: 1, max: 10 },
      },
      config: { fps: { component: 'number' } },
    },
  };
}

describe('可序列化 DataType 声明', () => {
  it('支持基础值、媒体及嵌套领域集合声明，不使用 Zod 实例充当类型', () => {
    for (const kind of ['string', 'number', 'boolean', 'image', 'video', 'audio']) {
      expect(dataTypeSchema.parse({ kind })).toEqual({ kind });
    }
    const nested = {
      kind: 'array',
      item: { kind: 'array', item: { kind: 'domain', name: 'character' } },
    };
    expect(dataTypeSchema.parse(JSON.parse(JSON.stringify(nested)))).toEqual(nested);
    expect(dataTypeSchema.safeParse(z.string()).success).toBe(false);
  });

  it('拒绝未知类型、额外字段、缺失数组元素类型及无效领域标识', () => {
    for (const value of [
      { kind: 'object' },
      { kind: 'image', url: 'https://example.com/image.png' },
      { kind: 'array' },
      { kind: 'array', item: { kind: 'unknown' } },
      { kind: 'domain', name: '' },
      { kind: 'domain', name: ' character ' },
    ]) {
      expect(dataTypeSchema.safeParse(value).success).toBe(false);
    }
  });

  it('defaultValue 只接受 JSON，声明本身不读取资产或调用执行器', () => {
    const input = { key: 'value', name: '值', dataType: { kind: 'string' } };
    const defaultValue = { nested: ['text', 1, true, null] };
    expect(inputPortDefinitionSchema.parse({ ...input, defaultValue }).defaultValue).toEqual(
      defaultValue,
    );
    for (const value of [new Date(), new Map(), BigInt(1), () => 'value', Infinity]) {
      expect(inputPortDefinitionSchema.safeParse({ ...input, defaultValue: value }).success).toBe(
        false,
      );
    }
  });
});

describe('NodeType 静态说明书协议', () => {
  it('完整声明可按 JSON 往返，输入和执行配置 UI 独立保存', () => {
    const source = declaration();
    const parsed = nodeTypeDeclarationSchema.parse(JSON.parse(JSON.stringify(source)));

    expect(parsed).toEqual(source);
    expect(parsed.ui.inputs?.duration).toMatchObject({ component: 'slider', min: 1, max: 10 });
    expect(parsed.ui.config?.fps).toEqual({ component: 'number' });
    expect(parsed.inputs.find((port) => port.key === 'duration')?.defaultValue).toBe(5);
  });

  it('名称修改不改变类型身份，并拒绝旧的扁平元数据与 UI 字段', () => {
    const source = declaration();
    const renamed = nodeTypeDeclarationSchema.parse({
      ...source,
      metadata: { ...source.metadata, name: '生成镜头视频' },
    });
    expect(renamed.type).toBe(source.type);
    for (const value of [
      { ...source, displayName: '图生视频' },
      { ...source, category: 'video' },
      { ...source, ui: { fields: {} } },
      { ...source, ui: { icon: 'video' } },
      { ...source, metadata: { ...source.metadata, execute: () => ({}) } },
      { ...source, metadata: { ...source.metadata, name: ' ' } },
      { ...source, metadata: { ...source.metadata, category: '' } },
    ]) {
      expect(nodeTypeDeclarationSchema.safeParse(value).success).toBe(false);
    }
  });

  it('要求命名空间类型及明确的正整数版本', () => {
    for (const type of ['ai.llm', 'video.image_to_video', 'flow.human_review', 'ai.v2.agent']) {
      expect(nodeTypeIdSchema.parse(type)).toBe(type);
    }
    for (const type of [
      'llm',
      'AI.llm',
      'ai.',
      '.llm',
      'ai..llm',
      'ai.text-generation',
      ' ai.llm',
    ]) {
      expect(nodeTypeIdSchema.safeParse(type).success).toBe(false);
    }
    for (const version of [undefined, 0, -1, 1.5, Infinity, '1']) {
      expect(nodeTypeVersionSchema.safeParse(version).success).toBe(false);
      expect(nodeTypeDeclarationSchema.safeParse({ ...declaration(), version }).success).toBe(
        false,
      );
    }
  });

  it('分别拒绝重复输入和输出端口，允许两个方向使用相同 key', () => {
    const source = declaration();
    for (const direction of ['inputs', 'outputs'] as const) {
      expect(
        nodeTypeDeclarationSchema.safeParse({
          ...source,
          [direction]: [...source[direction], source[direction][0]],
        }).success,
      ).toBe(false);
    }
    expect(
      nodeTypeDeclarationSchema.parse({
        ...source,
        outputs: [{ key: 'image', name: '图片', dataType: { kind: 'image' } }],
      }).outputs[0]?.key,
    ).toBe('image');
  });

  it('端口 key 遵守 Handle 协议，UI 输入只能引用已声明端口', () => {
    const source = declaration();
    for (const key of ['bad-handle', '', 'constructor']) {
      expect(
        nodeTypeDeclarationSchema.safeParse({
          ...source,
          inputs: [{ key, name: '输入', dataType: { kind: 'string' } }],
        }).success,
      ).toBe(false);
    }
    expect(
      nodeTypeDeclarationSchema.safeParse({
        ...source,
        ui: { inputs: { absent: { component: 'text' } } },
      }).success,
    ).toBe(false);
  });

  it('能力只声明稳定类型，拒绝重复能力及供应商绑定字段', () => {
    const source = declaration();
    expect(nodeTypeDeclarationSchema.parse({ ...source, capabilities: [] }).capabilities).toEqual(
      [],
    );
    for (const capabilities of [
      [{ type: 'video.image_to_video' }, { type: 'video.image_to_video' }],
      [{ type: 'image_to_video' }],
      [{ type: 'video.image_to_video', provider: 'vendor' }],
    ]) {
      expect(nodeTypeDeclarationSchema.safeParse({ ...source, capabilities }).success).toBe(false);
    }
  });

  it('UI 仅允许受控组件及有效参数，不接受函数或远程组件', () => {
    const source = declaration();
    for (const component of [
      { component: () => null },
      { component: 'https://example.com/widget.js' },
      { component: 'slider', min: 10, max: 1 },
      { component: 'slider', min: 0, max: 10, step: 0 },
      { component: 'select', options: [] },
    ]) {
      expect(
        nodeTypeDeclarationSchema.safeParse({
          ...source,
          ui: { inputs: { prompt: component } },
        }).success,
      ).toBe(false);
    }
  });

  it('manifest 仅增加配置 JSON Schema，不再接收输入输出 Zod 或 JSON Schema', () => {
    const source = declaration();
    const manifest = {
      ...source,
      configSchema: { type: 'object', properties: { fps: { type: 'number' } } },
    };
    expect(nodeTypeManifestSchema.parse(manifest)).toEqual(manifest);
    for (const value of [
      { ...manifest, inputSchema: { type: 'object' } },
      { ...manifest, outputSchema: z.object({}) },
      { ...manifest, configSchema: z.object({}) },
      { ...manifest, inputs: [...source.inputs, source.inputs[0]] },
    ]) {
      expect(nodeTypeManifestSchema.safeParse(value).success).toBe(false);
    }
  });
});
