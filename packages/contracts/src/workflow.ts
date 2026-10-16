import { z } from 'zod';

export const identifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/);
export const jsonObjectSchema = z.record(z.string(), z.json());
export type JsonObject = z.infer<typeof jsonObjectSchema>;
export const portSchema = z
  .object({
    id: identifierSchema,
    label: z.string().min(1).max(80),
    kind: z.enum(['json', 'text', 'number', 'boolean', 'asset']),
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

// 仅供画布编排使用；业务执行器由后续节点实现显式注册。
export const stepConfigSchema = z.object({ notes: z.string().max(2000) }).strict();
export const foundationNodeDefinitions: NodeDefinition[] = [
  {
    type: 'core.step',
    version: 1,
    title: '流程节点',
    description: '用于组织流程结构。当前仅编排，具体业务能力后续接入。',
    inputs: [],
    outputs: [],
    configSchema: jsonObjectSchema.parse(z.toJSONSchema(stepConfigSchema)),
    defaultConfig: { notes: '' },
    executable: false,
  },
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
      issues.push({ code: 'port_type', message: '数据绑定端口类型不匹配', nodeId: target?.id });
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
