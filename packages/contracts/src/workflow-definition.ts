import { z } from 'zod';
import { dataTypeSchema } from './data-type.js';
import { controlEdgeDefinitionSchema, nodeDefinitionSchema } from './node.js';
import { createWorkflowSchemas } from './workflow.js';

const schemas = createWorkflowSchemas({
  dataType: dataTypeSchema,
  node: nodeDefinitionSchema,
  edge: controlEdgeDefinitionSchema,
});

// 仅校验静态引用与联合 DAG，不解释运行值、不查询资产，也不推断声明端口。
export const workflowDefinitionSchema = schemas.definitionSchema.superRefine(
  (definition, context) => {
    const nodes = new Set(definition.nodes.map((node) => node.id));
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
        if (binding.type === 'connection') {
          if (!nodes.has(binding.nodeId)) {
            context.addIssue({
              code: 'custom',
              path: ['nodes', index, 'inputs', key, 'nodeId'],
              message: '数据绑定引用了不存在的节点',
            });
          } else if (binding.nodeId === node.id) {
            context.addIssue({
              code: 'custom',
              path: ['nodes', index, 'inputs', key, 'nodeId'],
              message: '数据绑定不能引用自身',
            });
          } else {
            addDependency(binding.nodeId, node.id);
          }
        } else if (binding.type === 'workflow_input' && !inputs.has(binding.key)) {
          context.addIssue({
            code: 'custom',
            path: ['nodes', index, 'inputs', key, 'key'],
            message: '绑定引用了不存在的工作流输入',
          });
        }
      }
    });

    const edgeIds = new Set<string>();
    definition.edges.forEach((edge, index) => {
      if (edgeIds.has(edge.id)) {
        context.addIssue({
          code: 'custom',
          path: ['edges', index, 'id'],
          message: '控制边标识不能重复',
        });
      }
      edgeIds.add(edge.id);
      for (const key of ['sourceNodeId', 'targetNodeId'] as const) {
        if (!nodes.has(edge[key])) {
          context.addIssue({
            code: 'custom',
            path: ['edges', index, key],
            message: '控制边引用了不存在的节点',
          });
        }
      }
      if (edge.sourceNodeId === edge.targetNodeId) {
        context.addIssue({
          code: 'custom',
          path: ['edges', index, 'targetNodeId'],
          message: '控制边不能连接自身',
        });
      } else {
        addDependency(edge.sourceNodeId, edge.targetNodeId);
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
        path: ['nodes'],
        message: '控制关系与数据依赖联合必须无环',
      });
    }
  },
);

export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;
