import { z } from 'zod';
import { nestedGraphSlots } from './traversal.js';
import { dataTypeSchema } from '../data/type.js';
import { nodeDefinitionSchema, type NodeDefinition } from '../node/definition.js';
import { workflowEdgeSchema, type WorkflowEdge } from '../workflow/edge-definition.js';
import { createWorkflowSchemas } from '../workflow/metadata.js';

const schemas = createWorkflowSchemas({
  dataType: dataTypeSchema,
  node: z.lazy(() => nodeDefinitionSchema),
  edge: workflowEdgeSchema,
});

export const graphInputDefinitionSchema = schemas.inputSchema;
export type GraphInputDefinition = z.infer<typeof graphInputDefinitionSchema>;

// 仅校验静态引用与控制 / 数据联合 DAG，不解释运行值、不查询资产，也不推断声明端口。
export const graphDraftDefinitionSchema = schemas.draftDefinitionSchema.superRefine(
  (definition, context) => {
    const nodes = new Set(definition.nodes.map((node) => node.id));
    const nodeDefinitions = new Map(definition.nodes.map((node) => [node.id, node]));
    const inputs = new Set(definition.inputs.map((input) => input.name));
    const dependents = new Map<string, Set<string>>();
    const incoming = new Map<string, number>();
    for (const id of nodes) {
      dependents.set(id, new Set());
      incoming.set(id, 0);
    }
    const addDependency = (source: string, target: string) => {
      const targets = dependents.get(source);
      if (targets && !targets.has(target) && nodes.has(target)) {
        targets.add(target);
        incoming.set(target, (incoming.get(target) ?? 0) + 1);
      }
    };

    definition.nodes.forEach((node, index) => {
      for (const [key, binding] of Object.entries(node.inputs)) {
        if (binding.type === 'workflow_input' && !inputs.has(binding.key)) {
          context.addIssue({
            code: 'custom',
            path: ['nodes', index, 'inputs', key, 'key'],
            message: '绑定引用了不存在的工作流输入',
          });
        }
        if (binding.type === 'candidate') {
          binding.sources.forEach((source, sourceIndex) => {
            if (!nodes.has(source.nodeId)) {
              context.addIssue({
                code: 'custom',
                path: ['nodes', index, 'inputs', key, 'sources', sourceIndex, 'nodeId'],
                message: '候选输入引用了不存在的节点',
              });
              return;
            }
            if (source.nodeId === node.id) {
              context.addIssue({
                code: 'custom',
                path: ['nodes', index, 'inputs', key, 'sources', sourceIndex, 'nodeId'],
                message: '候选输入不能引用自身',
              });
            }
            addDependency(source.nodeId, node.id);
          });
          continue;
        }
        if (binding.type !== 'template') continue;
        for (const [name, source] of Object.entries(binding.variables)) {
          if (source.type === 'workflow_input') {
            if (!inputs.has(source.key)) {
              context.addIssue({
                code: 'custom',
                path: ['nodes', index, 'inputs', key, 'variables', name, 'key'],
                message: '模板变量引用了不存在的工作流输入',
              });
            }
            continue;
          }
          if (!nodes.has(source.nodeId)) {
            context.addIssue({
              code: 'custom',
              path: ['nodes', index, 'inputs', key, 'variables', name, 'nodeId'],
              message: '模板变量引用了不存在的节点',
            });
            continue;
          }
          if (source.nodeId === node.id) {
            context.addIssue({
              code: 'custom',
              path: ['nodes', index, 'inputs', key, 'variables', name, 'nodeId'],
              message: '模板变量不能引用自身',
            });
          }
          addDependency(source.nodeId, node.id);
        }
      }
    });

    const edgeIds = new Set<string>();
    const connectedInputs = new Map<string, Set<string>>();
    definition.edges.forEach((edge, index) => {
      if (edgeIds.has(edge.id)) {
        context.addIssue({
          code: 'custom',
          path: ['edges', index, 'id'],
          message: '边标识不能重复',
        });
      }
      edgeIds.add(edge.id);
      for (const key of ['source', 'target'] as const) {
        if (!nodes.has(edge[key].nodeId)) {
          context.addIssue({
            code: 'custom',
            path: ['edges', index, key, 'nodeId'],
            message: '边引用了不存在的节点',
          });
        }
      }
      if (edge.source.nodeId === edge.target.nodeId) {
        context.addIssue({
          code: 'custom',
          path: ['edges', index, 'target', 'nodeId'],
          message: '边不能连接自身',
        });
      } else {
        addDependency(edge.source.nodeId, edge.target.nodeId);
      }

      if (edge.kind === 'data') {
        const targetPorts = connectedInputs.get(edge.target.nodeId) ?? new Set<string>();
        if (targetPorts.has(edge.target.portKey)) {
          context.addIssue({
            code: 'custom',
            path: ['edges', index, 'target', 'portKey'],
            message: '每个输入端口最多连接一条数据边',
            params: { code: 'INPUT_SOURCE_CONFLICT' },
          });
        }
        targetPorts.add(edge.target.portKey);
        connectedInputs.set(edge.target.nodeId, targetPorts);

        const targetNode = nodeDefinitions.get(edge.target.nodeId);
        if (targetNode && Object.hasOwn(targetNode.inputs, edge.target.portKey)) {
          context.addIssue({
            code: 'custom',
            path: ['edges', index, 'target', 'portKey'],
            message: '数据边目标端口不能同时保存静态输入绑定',
            params: { code: 'INPUT_SOURCE_CONFLICT' },
          });
        }
      }
    });

    const ready = [...nodes].filter((id) => incoming.get(id) === 0);
    let visited = 0;
    for (let index = 0; index < ready.length; index++) {
      const id = ready[index];
      if (id === undefined) continue;
      visited++;
      for (const target of dependents.get(id) ?? []) {
        const count = (incoming.get(target) ?? 0) - 1;
        incoming.set(target, count);
        if (count === 0) ready.push(target);
      }
    }
    if (visited !== nodes.size) {
      context.addIssue({
        code: 'custom',
        path: ['edges'],
        message: '控制关系与数据依赖联合必须无环',
      });
    }
  },
);

export const graphOutputDefinitionSchema = schemas.outputSchema;
export type GraphOutputDefinition = z.infer<typeof graphOutputDefinitionSchema>;
// 编辑态允许候选不足；不可变版本及执行边界必须通过最终输出协议。
export const graphDefinitionSchema: typeof graphDraftDefinitionSchema =
  graphDraftDefinitionSchema.superRefine((definition, context) => {
    definition.nodes.forEach((node, index) => {
      for (const slot of nestedGraphSlots(node)) {
        const body = graphDefinitionSchema.safeParse(slot.graph);
        if (!body.success)
          for (const issue of body.error.issues)
            context.addIssue({
              ...issue,
              path: ['nodes', index, 'composite', slot.graphKey, ...issue.path],
            });
      }
      for (const [key, binding] of Object.entries(node.inputs)) {
        if (binding.type === 'candidate' && binding.sources.length < 2) {
          context.addIssue({
            code: 'custom',
            path: ['nodes', index, 'inputs', key, 'sources'],
            message: '候选输入绑定至少需要两个来源',
          });
        }
      }
    });
    definition.outputs.forEach((output, index) => {
      const result = graphOutputDefinitionSchema.safeParse(output);
      if (!result.success)
        for (const issue of result.error.issues)
          context.addIssue({ ...issue, path: ['outputs', index, ...issue.path] });
    });
  });
export interface GraphDefinition {
  inputs: GraphInputDefinition[];
  nodes: NodeDefinition[];
  edges: WorkflowEdge[];
  outputs: GraphOutputDefinition[];
}
