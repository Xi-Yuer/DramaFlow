import { z } from 'zod';
import { dataTypeSchema } from '../data/type.js';
import { nodeDefinitionSchema } from '../node/definition.js';
import { workflowEdgeSchema } from './edge-definition.js';
import { createWorkflowSchemas } from './metadata.js';

const schemas = createWorkflowSchemas({
  dataType: dataTypeSchema,
  node: nodeDefinitionSchema,
  edge: workflowEdgeSchema,
});

// 仅校验静态引用与数据 DAG，不解释运行值、不查询资产，也不推断声明端口。
export const workflowDefinitionSchema = schemas.definitionSchema.superRefine(
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
      }
    });

    const edgeIds = new Set<string>();
    const connectedInputs = new Map<string, Set<string>>();
    definition.edges.forEach((edge, index) => {
      if (edgeIds.has(edge.id)) {
        context.addIssue({
          code: 'custom',
          path: ['edges', index, 'id'],
          message: '数据边标识不能重复',
        });
      }
      edgeIds.add(edge.id);
      for (const key of ['source', 'target'] as const) {
        if (!nodes.has(edge[key].nodeId)) {
          context.addIssue({
            code: 'custom',
            path: ['edges', index, key, 'nodeId'],
            message: '数据边引用了不存在的节点',
          });
        }
      }
      if (edge.source.nodeId === edge.target.nodeId) {
        context.addIssue({
          code: 'custom',
          path: ['edges', index, 'target', 'nodeId'],
          message: '数据边不能连接自身',
        });
      } else {
        addDependency(edge.source.nodeId, edge.target.nodeId);
      }

      const targetPorts = connectedInputs.get(edge.target.nodeId) ?? new Set<string>();
      if (targetPorts.has(edge.target.portKey)) {
        context.addIssue({
          code: 'custom',
          path: ['edges', index, 'target', 'portKey'],
          message: '每个输入端口最多连接一条数据边',
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
        });
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
        message: '数据依赖必须无环',
      });
    }
  },
);

export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;
