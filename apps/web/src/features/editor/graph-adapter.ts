import type { Edge, Node, Connection } from '@xyflow/react';
import { resolveNodeDefinition } from './node-ports';
import type {
  NodeDefinition,
  NodeResult,
  WorkflowDefinition,
  WorkflowNode,
} from '@dramaflow/contracts';

export type WorkflowCanvasNode = Node<
  { node: WorkflowNode; definition: NodeDefinition | undefined; result?: NodeResult },
  'workflow'
>;

export function toCanvas(
  definition: WorkflowDefinition,
  catalog: NodeDefinition[],
  selectedNodeId: string | null,
  results: Record<string, NodeResult> = {},
): { nodes: WorkflowCanvasNode[]; edges: Edge[] } {
  return {
    nodes: definition.nodes.map((node) => ({
      id: node.id,
      type: 'workflow',
      position: node.position,
      selected: node.id === selectedNodeId,
      data: {
        node,
        definition: resolveNodeDefinition(node, catalog, definition),
        result: results[node.id],
      },
    })),
    edges: [
      ...definition.controlEdges.map((edge) => ({
        id: `control:${edge.id}`,
        source: edge.source,
        target: edge.target,
        sourceHandle: `control:${edge.sourcePort}`,
        targetHandle: 'control:in',
        style: { stroke: '#8eaf78', strokeWidth: 1.5 },
        label: edge.sourcePort === 'out' ? undefined : edge.sourcePort,
        labelStyle: { fill: '#a3c08e', fontSize: 10 },
        labelBgStyle: { fill: '#15241c' },
        type: 'smoothstep',
      })),
      ...definition.bindings.flatMap((binding) =>
        binding.source.kind === 'node'
          ? [
              {
                id: `binding:${binding.nodeId}:${binding.port}`,
                source: binding.source.nodeId,
                target: binding.nodeId,
                sourceHandle: `data:${binding.source.port}`,
                targetHandle: `data:${binding.port}`,
                style: { stroke: '#729fc0', strokeWidth: 1.2, strokeDasharray: '5 5' },
                type: 'smoothstep',
              },
            ]
          : [],
      ),
    ],
  };
}

export function createsCycle(
  definition: WorkflowDefinition,
  source: string,
  target: string,
): boolean {
  if (source === target) return true;
  const next = new Map<string, string[]>();
  for (const edge of definition.controlEdges)
    next.set(edge.source, [...(next.get(edge.source) ?? []), edge.target]);
  for (const binding of definition.bindings)
    if (binding.source.kind === 'node')
      next.set(binding.source.nodeId, [...(next.get(binding.source.nodeId) ?? []), binding.nodeId]);
  const pending = [target];
  const visited = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (id === source) return true;
    if (visited.has(id)) continue;
    visited.add(id);
    pending.push(...(next.get(id) ?? []));
  }
  return false;
}

export function connectionError(
  connection: Connection,
  definition: WorkflowDefinition,
  catalog: NodeDefinition[],
): string | null {
  const sourceKind = connection.sourceHandle?.split(':')[0];
  const targetKind = connection.targetHandle?.split(':')[0];
  if (sourceKind !== targetKind) return '执行端口只能连接执行端口；数据端口只能连接数据端口。';
  if (createsCycle(definition, connection.source, connection.target))
    return '此连线会形成循环；当前版本支持无环工作流。';
  if (sourceKind === 'data') {
    const sourceNode = definition.nodes.find((node) => node.id === connection.source);
    const targetNode = definition.nodes.find((node) => node.id === connection.target);
    const sourcePort = catalog
      .find((entry) => entry.type === sourceNode?.type)
      ?.outputs.find((port) => port.name === connection.sourceHandle?.slice(5));
    const targetPort = catalog
      .find((entry) => entry.type === targetNode?.type)
      ?.inputs.find((port) => port.name === connection.targetHandle?.slice(5));
    if (
      sourcePort &&
      targetPort &&
      sourcePort.dataType !== targetPort.dataType &&
      sourcePort.dataType !== 'any' &&
      targetPort.dataType !== 'any' &&
      sourcePort.dataType !== 'json' &&
      targetPort.dataType !== 'json'
    )
      return '数据端口类型不兼容，请使用绑定面板显式选择数据路径。';
  }
  return null;
}
