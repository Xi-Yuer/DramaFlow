import {
  controlEdgeDefinitionSchema,
  dataEdgeDefinitionSchema,
  workflowDraftDefinitionSchema,
  workflowEdgeSchema,
  workflowIdentifierSchema,
  type WorkflowEdge as WorkflowEdgeDefinition,
} from '@dramaflow/contracts';
import { z } from 'zod';
import { controlHandleId, parseWorkflowHandle } from './workflow-handles';
import { workflowEdgeViewOptions } from '../rendering/edge-presentation';
import type { WorkflowEdge } from './types';

export const connectionSchema = z.object({
  source: workflowIdentifierSchema,
  sourceHandle: z.string().min(1),
  target: workflowIdentifierSchema,
  targetHandle: z.string().min(1),
});

export const reactFlowEdgeSchema = connectionSchema.extend({
  id: workflowIdentifierSchema,
  sourceHandle: z.string().nullish(),
  targetHandle: z.string().nullish(),
  data: z.object({
    kind: z.enum(['data', 'control']),
    projection: z.enum(['candidate-input', 'template-input', 'workflow-input']).optional(),
  }),
});

export type WorkflowConnection = z.infer<typeof connectionSchema>;

// 默认控制 Handle 是 UI 标识；命名控制端口保留方向命名空间并无损映射。
export function controlEdgeToReactFlowEdge(input: unknown): WorkflowEdge {
  const edge = controlEdgeDefinitionSchema.parse(input);
  return {
    id: edge.id,
    source: edge.source.nodeId,
    sourceHandle: controlHandleId('source', edge.source.portKey),
    target: edge.target.nodeId,
    targetHandle: controlHandleId('target', edge.target.portKey),
    data: { kind: 'control' },
    ...workflowEdgeViewOptions({ kind: 'control' }),
  };
}

// 真实领域边保留原 ID；输入绑定由 toReactFlowEdges 另外投影，不写入领域 edges。
export function toReactFlowEdge(input: unknown): WorkflowEdge {
  const edge = workflowEdgeSchema.parse(input);
  if (edge.kind === 'control') return controlEdgeToReactFlowEdge(edge);
  return {
    id: edge.id,
    source: edge.source.nodeId,
    sourceHandle: edge.source.portKey,
    target: edge.target.nodeId,
    targetHandle: edge.target.portKey,
    data: { kind: edge.kind },
    ...workflowEdgeViewOptions({ kind: edge.kind }),
  };
}

export function fromReactFlowEdge(input: unknown): WorkflowEdgeDefinition {
  const edge = reactFlowEdgeSchema.parse(input);
  if (edge.data.projection) throw new Error('输入绑定展示连线不能导出为 DataEdge');
  if (edge.data.kind === 'control') {
    const source = parseWorkflowHandle(edge.sourceHandle ?? controlHandleId('source'), 'source');
    const target = parseWorkflowHandle(edge.targetHandle ?? controlHandleId('target'), 'target');
    if (source.kind !== 'control' || target.kind !== 'control') {
      throw new Error('控制边只能连接控制端口');
    }
    return controlEdgeDefinitionSchema.parse({
      id: edge.id,
      kind: 'control',
      source: {
        nodeId: edge.source,
        ...(source.portKey !== undefined ? { portKey: source.portKey } : {}),
      },
      target: {
        nodeId: edge.target,
        ...(target.portKey !== undefined ? { portKey: target.portKey } : {}),
      },
    });
  }
  return dataEdgeDefinitionSchema.parse({
    id: edge.id,
    kind: edge.data.kind,
    source: { nodeId: edge.source, portKey: edge.sourceHandle },
    target: { nodeId: edge.target, portKey: edge.targetHandle },
  });
}

export function toReactFlowEdges(input: unknown): WorkflowEdge[] {
  const workflow = workflowDraftDefinitionSchema.parse(input);
  const usedIds = new Set(workflow.edges.map((edge) => edge.id));
  const dependencies = new Set(
    workflow.edges.flatMap((edge) =>
      edge.kind === 'data'
        ? [
            JSON.stringify([
              edge.target.nodeId,
              edge.target.portKey,
              edge.source.nodeId,
              edge.source.portKey,
            ]),
          ]
        : [],
    ),
  );
  const projections: WorkflowEdge[] = [];
  for (const node of workflow.nodes) {
    for (const [portKey, binding] of Object.entries(node.inputs)) {
      if (binding.type !== 'candidate' && binding.type !== 'template') continue;
      const projection = binding.type === 'candidate' ? 'candidate-input' : 'template-input';
      const sources =
        binding.type === 'candidate' ? binding.sources : Object.values(binding.variables);
      for (const source of sources) {
        if (source.type !== 'node_output') continue;
        const dependency = JSON.stringify([node.id, portKey, source.nodeId, source.portKey]);
        // 按完整端点去重，保留 Template 中所有 alias 及来源定义。
        if (dependencies.has(dependency)) continue;
        dependencies.add(dependency);
        // JSON tuple 避免端点中分隔符碰撞；仍避让外部 Draft 已有的领域 edge ID。
        let id = `${projection}:${dependency}`;
        while (usedIds.has(id)) id += ':';
        usedIds.add(id);
        projections.push({
          id,
          source: source.nodeId,
          sourceHandle: source.portKey,
          target: node.id,
          targetHandle: portKey,
          data: { kind: 'data', projection },
          ...workflowEdgeViewOptions({ kind: 'data', projection }),
          reconnectable: false,
          ...(projection === 'template-input' ? { deletable: false } : {}),
          ariaLabel:
            projection === 'candidate-input'
              ? '候选输入数据连接'
              : '模板输入数据连接，请在输入中删除变量',
        });
      }
    }
  }
  return [...workflow.edges.map(toReactFlowEdge), ...projections];
}
