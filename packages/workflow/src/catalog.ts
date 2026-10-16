import { jsonObjectSchema, jsonValueSchema, modelSelectionSchema } from '@dramaflow/contracts';
import type { NodeDefinition, NodeType } from '@dramaflow/contracts';
import { z } from 'zod';

const generationFields = {
  model: modelSelectionSchema,
  prompt: z.string().max(50000).default(''),
  systemPrompt: z.string().max(50000).optional(),
  parameters: jsonObjectSchema.default({}),
};

export const nodeConfigSchemas = {
  input: z.object({}).strict(),
  text: z.object(generationFields).strict(),
  image: z.object(generationFields).strict(),
  video: z.object(generationFields).strict(),
  review: z
    .object({ prompt: z.string().min(1).max(10000).default('请确认本节点的内容后继续') })
    .strict(),
  condition: z
    .object({
      operator: z
        .enum(['equals', 'notEquals', 'contains', 'greaterThan', 'lessThan', 'isTruthy'])
        .default('isTruthy'),
      expected: jsonValueSchema.optional(),
    })
    .strict(),
  merge: z.object({ mode: z.enum(['selected', 'collect']).default('selected') }).strict(),
  batch: z
    .object({
      ...generationFields,
      capability: z.enum(['text.generate', 'image.generate']).default('text.generate'),
      maxConcurrency: z.number().int().min(1).max(32).default(4),
      maxItems: z.number().int().min(1).max(1000).default(100),
    })
    .strict(),
  output: z.object({}).strict(),
} satisfies Record<NodeType, z.ZodType>;

const definitions: Omit<NodeDefinition, 'version' | 'configSchema'>[] = [
  {
    type: 'input',
    label: '工作流输入',
    description: '读取本次运行的输入对象。',
    category: 'flow',
    inputs: [],
    outputs: [{ name: 'value', label: '输入值', dataType: 'json' }],
    actions: { regenerate: false, editOutput: false },
  },
  {
    type: 'text',
    label: '文本生成',
    description: '通过明确选择的插件、连接和模型生成剧本等文本。',
    category: 'generation',
    inputs: [
      { name: 'prompt', label: '需求', dataType: 'text' },
      { name: 'context', label: '绑定上下文', dataType: 'any' },
    ],
    outputs: [{ name: 'text', label: '生成文本', dataType: 'text' }],
    capability: 'text.generate',
    actions: { regenerate: true, editOutput: true },
  },
  {
    type: 'image',
    label: '图片生成',
    description: '将绑定需求提交给图片插件，并保存版本化资产。',
    category: 'generation',
    inputs: [
      { name: 'prompt', label: '图片需求', dataType: 'text' },
      { name: 'context', label: '绑定上下文', dataType: 'any' },
    ],
    outputs: [{ name: 'images', label: '图片资产', dataType: 'array' }],
    capability: 'image.generate',
    actions: { regenerate: true, editOutput: false },
  },
  {
    type: 'video',
    label: '视频生成',
    description: '需要已安装的视频插件；当前内置插件未提供此能力。',
    category: 'generation',
    inputs: [
      { name: 'prompt', label: '视频需求', dataType: 'text' },
      { name: 'context', label: '绑定上下文', dataType: 'any' },
    ],
    outputs: [{ name: 'videos', label: '视频资产', dataType: 'array' }],
    capability: 'video.generate',
    actions: { regenerate: true, editOutput: false },
  },
  {
    type: 'review',
    label: '人工确认',
    description: '持久化暂停，批准或拒绝后沿对应出口继续。',
    category: 'flow',
    inputs: [{ name: 'value', label: '待确认内容', dataType: 'any', required: true }],
    outputs: [
      { name: 'value', label: '确认后的内容', dataType: 'any' },
      { name: 'decision', label: '审核决定', dataType: 'text' },
      { name: 'feedback', label: '反馈', dataType: 'text' },
    ],
    actions: { regenerate: false, editOutput: true },
  },
  {
    type: 'condition',
    label: '条件判断',
    description: '确定性比较绑定输入，仅激活匹配的 true 或 false 出口。',
    category: 'flow',
    inputs: [{ name: 'value', label: '判断值', dataType: 'any', required: true }],
    outputs: [
      { name: 'value', label: '原值', dataType: 'any' },
      { name: 'matched', label: '判断结果', dataType: 'boolean' },
    ],
    actions: { regenerate: false, editOutput: false },
  },
  {
    type: 'merge',
    label: '分支合并',
    description: 'selected 要求恰好一个可用候选；collect 按绑定顺序收集可用输入。',
    category: 'data',
    inputs: [
      { name: 'a', label: '候选 A', dataType: 'any' },
      { name: 'b', label: '候选 B', dataType: 'any' },
    ],
    outputs: [
      { name: 'value', label: '选中的值', dataType: 'any' },
      { name: 'values', label: '值集合', dataType: 'array' },
    ],
    actions: { regenerate: false, editOutput: false },
  },
  {
    type: 'batch',
    label: '批量生成',
    description: '对有界数组逐项调用明确选择的模型能力，按原顺序收集结果。',
    category: 'generation',
    inputs: [{ name: 'items', label: '输入数组', dataType: 'array', required: true }],
    outputs: [{ name: 'items', label: '结果数组', dataType: 'array' }],
    actions: { regenerate: true, editOutput: false },
  },
  {
    type: 'output',
    label: '收集结果',
    description: '收集任意命名输入，支持文本、结构化数据和资产，并可继续连接下游。',
    category: 'data',
    inputs: [{ name: 'result', label: '结果', dataType: 'any' }],
    outputs: [{ name: 'result', label: '透传结果', dataType: 'any' }],
    actions: { regenerate: false, editOutput: false },
  },
];

export const nodeCatalog: NodeDefinition[] = definitions.map((definition) => ({
  ...definition,
  version: '1.0.0',
  configSchema: jsonObjectSchema.parse(z.toJSONSchema(nodeConfigSchemas[definition.type])),
}));

export function listNodeDefinitions(): NodeDefinition[] {
  return structuredClone(nodeCatalog);
}
export function getNodeDefinition(type: NodeType): NodeDefinition {
  return nodeCatalog.find((definition) => definition.type === type)!;
}
export function controlPorts(type: NodeType): string[] {
  if (type === 'condition') return ['true', 'false'];
  if (type === 'review') return ['out', 'approve', 'reject'];
  return ['out'];
}
