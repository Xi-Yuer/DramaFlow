import { z } from 'zod';

export const identifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/);
export const jsonObjectSchema = z.record(z.string(), z.json());
export type JsonObject = z.infer<typeof jsonObjectSchema>;
export const portSchema = z
  .object({
    id: identifierSchema,
    label: z.string().min(1).max(80),
    kind: z.enum(['json', 'text', 'number', 'boolean', 'asset', 'image', 'video', 'file']),
    required: z.boolean(),
  })
  .strict();
export const nodeDefinitionSchema = z
  .object({
    type: identifierSchema,
    version: z.number().int().positive(),
    title: z.string().min(1).max(80),
    description: z.string().max(500),
    inputs: z.array(portSchema).max(50),
    outputs: z.array(portSchema).max(50),
    configSchema: jsonObjectSchema,
    defaultConfig: jsonObjectSchema,
    executable: z.boolean(),
    pluginCapability: z.enum(['text', 'image', 'video']).nullable(),
  })
  .strict();
export type NodeDefinition = z.infer<typeof nodeDefinitionSchema>;
export const workflowNodeSchema = z
  .object({
    id: identifierSchema,
    type: identifierSchema,
    version: z.number().int().positive(),
    title: z.string().trim().min(1).max(80),
    position: z
      .object({
        x: z.number().finite().min(-100000).max(100000),
        y: z.number().finite().min(-100000).max(100000),
      })
      .strict(),
    config: jsonObjectSchema,
  })
  .strict();
export const workflowEdgeSchema = z
  .object({ id: identifierSchema, source: identifierSchema, target: identifierSchema })
  .strict();
export const bindingSchema = z
  .object({
    source: z.object({ nodeId: identifierSchema, port: identifierSchema }).strict(),
    target: z.object({ nodeId: identifierSchema, port: identifierSchema }).strict(),
  })
  .strict();
export const workflowDefinitionSchema = z
  .object({
    schemaVersion: z.literal(1),
    nodes: z.array(workflowNodeSchema).max(200),
    edges: z.array(workflowEdgeSchema).max(1000),
    bindings: z.array(bindingSchema).max(1000),
  })
  .strict();
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;
export type WorkflowNode = z.infer<typeof workflowNodeSchema>;
export const viewportSchema = z
  .object({
    x: z.number().finite().min(-1000000).max(1000000),
    y: z.number().finite().min(-1000000).max(1000000),
    zoom: z.number().min(0.1).max(3),
  })
  .strict();
export const createProjectSchema = z.object({ name: z.string().trim().min(1).max(80) }).strict();
export const saveProjectSchema = z
  .object({
    revision: z.number().int().positive(),
    name: createProjectSchema.shape.name,
    definition: workflowDefinitionSchema,
    viewport: viewportSchema,
  })
  .strict();
export const projectSummarySchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    revision: z.number().int().positive(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    nodeCount: z.number().int().nonnegative(),
  })
  .strict();
export const projectSchema = projectSummarySchema.extend({
  definition: workflowDefinitionSchema,
  viewport: viewportSchema,
});
export type Project = z.infer<typeof projectSchema>;
export type SaveProject = z.infer<typeof saveProjectSchema>;
export const emptyWorkflow = (): WorkflowDefinition => ({
  schemaVersion: 1,
  nodes: [],
  edges: [],
  bindings: [],
});

// 节点配置只描述草稿。模型调用由已安装插件提供，当前节点本身不执行生成。
export const stepConfigSchema = z.object({ notes: z.string().max(2000) }).strict();
export const startNodeConfigSchema = z
  .object({
    text: z.string().max(20000),
    fileUrl: z
      .string()
      .max(2000)
      .refine(
        (value) => value === '' || /^https:\/\/\S+$/.test(value),
        '文件地址需要是 https 链接',
      ),
  })
  .strict();
export const textNodeConfigSchema = z.object({ body: z.string().max(20000) }).strict();
export const characterNodeConfigSchema = z.object({ summary: z.string().max(4000) }).strict();
export const imageNodeConfigSchema = z
  .object({
    url: z
      .string()
      .max(2000)
      .refine(
        (value) => value === '' || /^https:\/\/\S+$/.test(value),
        '图片地址需要是 https 链接',
      ),
    caption: z.string().max(500),
  })
  .strict();
export const modelNodeConfigSchema = z
  .object({
    installationId: z.union([z.uuid(), z.literal('')]),
    modelId: z.string().max(160),
    instruction: z.string().max(8000),
  })
  .strict();
const port = (
  id: string,
  label: string,
  kind: 'text' | 'image' | 'video' | 'file',
  required: boolean,
) => ({ id, label, kind, required }) as const;
const portKindLabel = {
  json: 'JSON',
  text: '文本',
  number: '数字',
  boolean: '布尔',
  asset: '素材',
  image: '图片',
  video: '视频',
  file: '文件',
} as const;
function definition(
  partial: Omit<NodeDefinition, 'version' | 'executable' | 'configSchema'> & {
    config: z.ZodType;
  },
): NodeDefinition {
  const { config, ...rest } = partial;
  return {
    ...rest,
    version: 1,
    executable: false,
    configSchema: jsonObjectSchema.parse(z.toJSONSchema(config)),
  };
}
export const foundationNodeDefinitions: NodeDefinition[] = [
  definition({
    type: 'drama.start',
    title: '开始',
    description:
      '接收用户输入。输出文本和文件，只能连到接受对应类型的下游。本地上传尚未接入，文件可先填写 https 地址。',
    inputs: [],
    outputs: [port('text', '文本', 'text', false), port('file', '文件', 'file', false)],
    defaultConfig: { text: '', fileUrl: '' },
    pluginCapability: null,
    config: startNodeConfigSchema,
  }),
  definition({
    type: 'drama.text',
    title: '文本',
    description: '手写剧本、旁白或提示词，输出文本。',
    inputs: [],
    outputs: [port('text', '文本', 'text', true)],
    defaultConfig: { body: '' },
    pluginCapability: null,
    config: textNodeConfigSchema,
  }),
  definition({
    type: 'drama.character',
    title: '角色',
    description: '记录角色设定，输出文本，可供大模型和文生图引用。',
    inputs: [],
    outputs: [port('text', '设定', 'text', true)],
    defaultConfig: { summary: '' },
    pluginCapability: null,
    config: characterNodeConfigSchema,
  }),
  definition({
    type: 'drama.llm',
    title: '大模型',
    description:
      '输入文本，可选文件，输出文本。选择已安装的文本模型。当前只保存选择和指令，不会发起生成。',
    inputs: [port('prompt', '提示', 'text', false), port('file', '文件', 'file', false)],
    outputs: [port('text', '结果', 'text', true)],
    defaultConfig: { installationId: '', modelId: '', instruction: '' },
    pluginCapability: 'text',
    config: modelNodeConfigSchema,
  }),
  definition({
    type: 'drama.image',
    title: '图片',
    description: '放置一张参考图片并输出图片。可填写 https 地址；本地上传尚未接入。',
    inputs: [],
    outputs: [port('image', '图片', 'image', false)],
    defaultConfig: { url: '', caption: '' },
    pluginCapability: null,
    config: imageNodeConfigSchema,
  }),
  definition({
    type: 'drama.image-gen',
    title: '文生图',
    description:
      '输入文本，可选参考图，输出图片。选择已安装的图片模型。当前只保存选择和指令，不会发起生成。',
    inputs: [port('prompt', '提示', 'text', true), port('image', '参考图', 'image', false)],
    outputs: [port('image', '图片', 'image', true)],
    defaultConfig: { installationId: '', modelId: '', instruction: '' },
    pluginCapability: 'image',
    config: modelNodeConfigSchema,
  }),
  definition({
    type: 'drama.video-gen',
    title: '视频生成',
    description:
      '输入文本或参考图，输出视频。选择已安装的视频模型。当前只保存选择和指令，不会发起生成。',
    inputs: [port('prompt', '提示', 'text', false), port('image', '参考图', 'image', false)],
    outputs: [port('video', '视频', 'video', true)],
    defaultConfig: { installationId: '', modelId: '', instruction: '' },
    pluginCapability: 'video',
    config: modelNodeConfigSchema,
  }),
  definition({
    type: 'core.step',
    title: '流程节点',
    description: '只连接其他没有数据端口的流程节点，不能接入文本、图片、视频或文件。',
    inputs: [],
    outputs: [],
    defaultConfig: { notes: '' },
    pluginCapability: null,
    config: stepConfigSchema,
  }),
];

export type WorkflowIssue = { code: string; message: string; nodeId?: string };
/** 控制边与数据绑定共同参与依赖校验；不依赖画布或运行引擎内部类型。 */
export function workflowDependencies(definition: WorkflowDefinition): Map<string, Set<string>> {
  const dependencies = new Map(definition.nodes.map((n) => [n.id, new Set<string>()]));
  for (const edge of definition.edges) dependencies.get(edge.target)?.add(edge.source);
  for (const binding of definition.bindings)
    dependencies.get(binding.target.nodeId)?.add(binding.source.nodeId);
  return dependencies;
}
export function validateWorkflow(
  definition: WorkflowDefinition,
  catalog: NodeDefinition[],
): WorkflowIssue[] {
  const issues: WorkflowIssue[] = [];
  const ids = new Set<string>();
  const definitions = new Map(catalog.map((d) => [`${d.type}@${d.version}`, d]));
  const byId = new Map(definition.nodes.map((n) => [n.id, n]));
  for (const node of definition.nodes) {
    if (ids.has(node.id))
      issues.push({ code: 'duplicate_node', message: '节点标识重复', nodeId: node.id });
    ids.add(node.id);
    if (node.id === '__start__' || node.id === '__end__')
      issues.push({ code: 'reserved_id', message: '节点使用了保留标识', nodeId: node.id });
    if (!definitions.has(`${node.type}@${node.version}`))
      issues.push({ code: 'unknown_node', message: '节点类型或版本未安装', nodeId: node.id });
  }
  const edgeIds = new Set<string>();
  const pairs = new Set<string>();
  for (const edge of definition.edges) {
    if (edgeIds.has(edge.id) || pairs.has(`${edge.source}:${edge.target}`))
      issues.push({ code: 'duplicate_edge', message: '执行连线重复' });
    edgeIds.add(edge.id);
    pairs.add(`${edge.source}:${edge.target}`);
    if (!ids.has(edge.source) || !ids.has(edge.target))
      issues.push({ code: 'dangling_edge', message: '连线引用不存在的节点' });
  }
  const targets = new Set<string>();
  for (const binding of definition.bindings) {
    const source = byId.get(binding.source.nodeId),
      target = byId.get(binding.target.nodeId);
    const output =
      source &&
      definitions
        .get(`${source.type}@${source.version}`)
        ?.outputs.find((p) => p.id === binding.source.port);
    const input =
      target &&
      definitions
        .get(`${target.type}@${target.version}`)
        ?.inputs.find((p) => p.id === binding.target.port);
    if (!output || !input)
      issues.push({ code: 'invalid_binding', message: '数据绑定引用不存在的节点或端口' });
    else if (input.kind !== 'json' && input.kind !== output.kind)
      issues.push({
        code: 'port_type',
        message: `${portKindLabel[output.kind]}不能连接到${portKindLabel[input.kind]}`,
        nodeId: target?.id,
      });
    const key = `${binding.target.nodeId}:${binding.target.port}`;
    if (targets.has(key))
      issues.push({
        code: 'duplicate_binding',
        message: '同一输入不能绑定多个来源',
        nodeId: target?.id,
      });
    targets.add(key);
  }
  const dependencies = workflowDependencies(definition);
  const resolved = new Set<string>();
  while (true) {
    const ready = [...dependencies].filter(
      ([id, deps]) => !resolved.has(id) && [...deps].every((d) => resolved.has(d)),
    );
    if (!ready.length) break;
    ready.forEach(([id]) => resolved.add(id));
  }
  if (
    resolved.size !== ids.size &&
    !issues.some((i) => i.code === 'dangling_edge' || i.code === 'invalid_binding')
  )
    issues.push({ code: 'cycle', message: '流程包含循环，请调整执行连线或数据绑定' });
  return issues;
}
