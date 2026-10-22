import { describe, expect, it } from 'vitest';
import {
  AnyType,
  ImageType,
  NumberType,
  StringType,
  workflowDefinitionSchema,
  type NodeTypeManifest,
  type WorkflowDefinition,
} from '@dramaflow/contracts';
import {
  availableStringOutputs,
  displayTemplateSegments,
  draftBinding,
  insertVariable,
  removeVariable,
  replaceNodeInput,
  templateFromSegments,
  templateSegments,
  variableNameForPort,
} from '../src/features/workflow/inputs/template-input';

const textManifest = {
  type: 'ai.text_generate',
  version: 1,
  executionKind: 'action',
  metadata: { name: '文本生成', category: 'ai' },
  inputs: [
    { key: 'prompt', name: '提示词', dataType: StringType, required: true },
    { key: 'system', name: '系统提示词', dataType: StringType },
  ],
  outputs: [{ key: 'text', name: '生成文本', dataType: StringType }],
  config: [],
} satisfies NodeTypeManifest;

const imageManifest = {
  type: 'test.image',
  version: 1,
  executionKind: 'action',
  metadata: { name: '图片', category: 'image' },
  inputs: [],
  outputs: [
    { key: 'image', name: '图片', dataType: ImageType },
    { key: 'caption', name: '说明', dataType: StringType },
    { key: 'count', name: '数量', dataType: NumberType },
    { key: 'raw', name: '原始', dataType: AnyType },
  ],
  config: [],
} satisfies NodeTypeManifest;

function node(
  id: string,
  name: string,
  type = 'ai.text_generate',
  inputs: WorkflowDefinition['nodes'][number]['inputs'] = {},
): WorkflowDefinition['nodes'][number] {
  return {
    id,
    type,
    typeVersion: 1,
    name,
    inputs,
    config: {},
    ui: { position: { x: 0, y: 0 } },
  };
}

function graph(extra?: Partial<WorkflowDefinition>): WorkflowDefinition {
  return {
    inputs: [],
    nodes: [node('outline', '生成大纲'), node('script', '剧本'), node('polish', '润色')],
    edges: [
      {
        id: 'forward',
        kind: 'control',
        source: { nodeId: 'script' },
        target: { nodeId: 'polish' },
      },
    ],
    outputs: [],
    ...extra,
  };
}

describe('文本节点可用上游', () => {
  it('展示自身和下游以外的字符串输出，并过滤不能赋给 string 的端口', () => {
    const definition = graph({
      nodes: [
        node('outline', '生成大纲'),
        node('picture', '场景图', 'test.image'),
        node('script', '剧本'),
        node('polish', '润色'),
        node('missing', '缺目录', 'test.missing'),
      ],
    });
    expect(availableStringOutputs(definition, 'script', [textManifest, imageManifest])).toEqual([
      { nodeId: 'outline', nodeName: '生成大纲', portKey: 'text', portName: '生成文本' },
      { nodeId: 'picture', nodeName: '场景图', portKey: 'caption', portName: '说明' },
    ]);
    expect(availableStringOutputs(definition, 'polish', [textManifest, imageManifest])).toEqual([
      { nodeId: 'outline', nodeName: '生成大纲', portKey: 'text', portName: '生成文本' },
      { nodeId: 'picture', nodeName: '场景图', portKey: 'caption', portName: '说明' },
      { nodeId: 'script', nodeName: '剧本', portKey: 'text', portName: '生成文本' },
    ]);
  });

  it('已有模板引用的下游不能再反向选择', () => {
    const definition = graph({
      edges: [],
      nodes: [
        node('outline', '生成大纲'),
        node('script', '剧本', 'ai.text_generate', {
          prompt: {
            type: 'template',
            value: '{{outline}}',
            variables: { outline: { type: 'node_output', nodeId: 'outline', portKey: 'text' } },
          },
        }),
      ],
    });
    expect(
      availableStringOutputs(definition, 'outline', [textManifest]).map((item) => item.nodeId),
    ).toEqual([]);
    expect(
      availableStringOutputs(definition, 'script', [textManifest]).map((item) => item.nodeId),
    ).toEqual(['outline']);
  });
});

describe('文本编辑与 TemplateBinding', () => {
  it('没有变量时保持 constant，插入多个上游后成为 template，删除后清掉无用绑定', () => {
    expect(draftBinding('请根据大纲生成剧本', {})).toEqual({
      status: 'ready',
      binding: { type: 'constant', value: '请根据大纲生成剧本' },
    });
    expect(draftBinding('', {})).toEqual({ status: 'clear' });
    const variables = {
      text: { type: 'node_output' as const, nodeId: 'outline', portKey: 'text' },
      text2: { type: 'node_output' as const, nodeId: 'cast', portKey: 'text' },
    };
    const inserted = insertVariable('请根据 ', 4, 4, 'text');
    expect(inserted).toEqual({ text: '请根据 {{text}}', cursor: 12 });
    expect(draftBinding(`${inserted.text} 和 {{text2}} 生成剧本`, variables)).toEqual({
      status: 'ready',
      binding: {
        type: 'template',
        value: '请根据 {{text}} 和 {{text2}} 生成剧本',
        variables,
      },
    });
    expect(
      draftBinding(removeVariable('请根据 {{text}} 和 {{text2}} 生成剧本', 'text'), variables),
    ).toEqual({
      status: 'ready',
      binding: {
        type: 'template',
        value: '请根据  和 {{text2}} 生成剧本',
        variables: { text2: variables.text2 },
      },
    });
    expect(draftBinding('请根据 {{outline}}', {})).toEqual({
      status: 'ready',
      binding: { type: 'constant', value: '请根据 {{outline}}' },
    });
    expect(draftBinding('请根据 {{text}} {{', variables)).toEqual({ status: 'invalid' });
  });

  it('已绑定 alias 切成变量段，未绑定标记和展示名都不进入保存文本', () => {
    const names = new Set(['text', 'text2']);
    const text = '请根据 {{text}} 和 {{text2}} 生成剧本';
    expect(templateSegments(text, names)).toEqual([
      { kind: 'text', text: '请根据 ' },
      { kind: 'variable', name: 'text' },
      { kind: 'text', text: ' 和 ' },
      { kind: 'variable', name: 'text2' },
      { kind: 'text', text: ' 生成剧本' },
    ]);
    expect(templateFromSegments(templateSegments(text, names))).toBe(text);
    expect(templateSegments('请根据 {{outline}} 写', names)).toEqual([
      { kind: 'text', text: '请根据 {{outline}} 写' },
    ]);
    const displayed = displayTemplateSegments('{{text}}{{text2}}', names);
    expect(templateFromSegments(displayed)).toBe('{{text}}{{text2}}');
    expect(displayed.map((segment) => segment.kind)).toEqual([
      'text',
      'variable',
      'text',
      'variable',
      'text',
    ]);
  });

  it('同一来源复用变量名，不同来源的相同端口名递增', () => {
    const first = { text: { type: 'node_output' as const, nodeId: 'outline', portKey: 'text' } };
    expect(variableNameForPort('text', {}, { nodeId: 'outline', portKey: 'text' })).toBe('text');
    expect(variableNameForPort('text', first, { nodeId: 'outline', portKey: 'text' })).toBe('text');
    expect(variableNameForPort('text', first, { nodeId: 'cast', portKey: 'text' })).toBe('text2');
  });

  it('prompt 与 system 分别替换绑定，不改动边', () => {
    const source = graph();
    const prompt = replaceNodeInput(source, 'script', 'prompt', {
      type: 'template',
      value: '请根据 {{text}} 生成剧本',
      variables: { text: { type: 'node_output', nodeId: 'outline', portKey: 'text' } },
    });
    const both = replaceNodeInput(prompt, 'script', 'system', {
      type: 'constant',
      value: '使用中文',
    });
    expect(both.edges).toEqual(source.edges);
    expect(
      workflowDefinitionSchema.parse(both).nodes.find((item) => item.id === 'script')?.inputs,
    ).toEqual({
      prompt: {
        type: 'template',
        value: '请根据 {{text}} 生成剧本',
        variables: { text: { type: 'node_output', nodeId: 'outline', portKey: 'text' } },
      },
      system: { type: 'constant', value: '使用中文' },
    });
    const cleared = replaceNodeInput(both, 'script', 'prompt', null);
    expect(cleared.nodes.find((item) => item.id === 'script')?.inputs).toEqual({
      system: { type: 'constant', value: '使用中文' },
    });
  });
});
