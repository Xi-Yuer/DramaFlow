import type { Edge, Node } from '@xyflow/react';
import {
  validateWorkflow,
  type JsonObject,
  type NodeDefinition,
  type WorkflowDefinition,
} from '@dramaflow/contracts';

export type CanvasNodeData = {
  [key: string]: unknown;
  nodeType: string;
  version: number;
  title: string;
  config: JsonObject;
};
export type CanvasNode = Node<CanvasNodeData, 'canvas'>;

const POSITION_LIMIT = 100_000;

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(max, Math.max(min, value));
}

export function toCanvasNodes(definition: WorkflowDefinition): CanvasNode[] {
  return definition.nodes.map((node) => ({
    id: node.id,
    type: 'canvas',
    position: node.position,
    data: {
      nodeType: node.type,
      version: node.version,
      title: node.title,
      config: node.config,
    },
  }));
}

export const execSourceHandle = '__exec_out';
export const execTargetHandle = '__exec_in';

function nodeDefinition(
  catalog: NodeDefinition[],
  node: CanvasNode | WorkflowDefinition['nodes'][number],
) {
  const type = 'data' in node ? node.data.nodeType : node.type;
  const version = 'data' in node ? node.data.version : node.version;
  return catalog.find((item) => item.type === type && item.version === version);
}

function findPort(
  definition: NodeDefinition | undefined,
  handle: string | null | undefined,
  direction: 'input' | 'output',
) {
  if (!definition || !handle || handle === execSourceHandle || handle === execTargetHandle)
    return undefined;
  const ports = direction === 'input' ? definition.inputs : definition.outputs;
  return ports.find((port) => port.id === handle);
}

export function toCanvasEdges(definition: WorkflowDefinition): Edge[] {
  const covered = new Set(
    definition.bindings.map((binding) => `${binding.source.nodeId}:${binding.target.nodeId}`),
  );
  const edges: Edge[] = definition.bindings.map((binding, index) => ({
    id: `bind${index}${binding.source.port}${binding.target.port}`.slice(0, 80),
    source: binding.source.nodeId,
    target: binding.target.nodeId,
    sourceHandle: binding.source.port,
    targetHandle: binding.target.port,
  }));
  for (const edge of definition.edges) {
    if (covered.has(`${edge.source}:${edge.target}`)) continue;
    edges.push({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      sourceHandle: execSourceHandle,
      targetHandle: execTargetHandle,
    });
  }
  return edges;
}

/** 端口连线同时写成数据绑定和一条执行边；同一对节点只保留一条执行边。 */
export function toWorkflow(
  nodes: CanvasNode[],
  edges: Edge[],
  catalog: NodeDefinition[],
): WorkflowDefinition {
  const ids = new Set(nodes.map((node) => node.id));
  const execution = new Map<string, WorkflowDefinition['edges'][number]>();
  const bindings: WorkflowDefinition['bindings'] = [];
  for (const edge of edges) {
    if (!ids.has(edge.source) || !ids.has(edge.target)) continue;
    const pair = `${edge.source}:${edge.target}`;
    if (!execution.has(pair))
      execution.set(pair, { id: edge.id, source: edge.source, target: edge.target });
    const source = nodes.find((node) => node.id === edge.source);
    const target = nodes.find((node) => node.id === edge.target);
    const output = source
      ? findPort(nodeDefinition(catalog, source), edge.sourceHandle, 'output')
      : undefined;
    const input = target
      ? findPort(nodeDefinition(catalog, target), edge.targetHandle, 'input')
      : undefined;
    if (output && input)
      bindings.push({
        source: { nodeId: edge.source, port: output.id },
        target: { nodeId: edge.target, port: input.id },
      });
  }
  return {
    schemaVersion: 1,
    nodes: nodes.map((node) => ({
      id: node.id,
      type: node.data.nodeType,
      version: node.data.version,
      title: node.data.title.trim(),
      position: {
        x: clamp(node.position.x, -POSITION_LIMIT, POSITION_LIMIT),
        y: clamp(node.position.y, -POSITION_LIMIT, POSITION_LIMIT),
      },
      config: node.data.config,
    })),
    edges: [...execution.values()],
    bindings,
  };
}

export function clampViewport(viewport: { x: number; y: number; zoom: number }) {
  return {
    x: clamp(viewport.x, -1_000_000, 1_000_000),
    y: clamp(viewport.y, -1_000_000, 1_000_000),
    zoom: clamp(viewport.zoom, 0.1, 3),
  };
}

export function draftSignature(
  name: string,
  nodes: CanvasNode[],
  edges: Edge[],
  catalog: NodeDefinition[],
  viewport: { x: number; y: number; zoom: number },
) {
  const definition = toWorkflow(nodes, edges, catalog);
  const view = clampViewport(viewport);
  return JSON.stringify({
    name: name.trim(),
    nodes: definition.nodes
      .map((node) => ({
        ...node,
        position: {
          x: Number(node.position.x.toFixed(2)),
          y: Number(node.position.y.toFixed(2)),
        },
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...definition.edges].sort((a, b) => a.id.localeCompare(b.id)),
    bindings: definition.bindings,
    viewport: {
      x: Number(view.x.toFixed(2)),
      y: Number(view.y.toFixed(2)),
      zoom: Number(view.zoom.toFixed(3)),
    },
  });
}

/** 预览连线。数据端口会额外检查绑定，同一对节点的执行边可以复用。 */
export function connectionIssue(
  definition: WorkflowDefinition,
  catalog: NodeDefinition[],
  connection: {
    source: string | null;
    target: string | null;
    sourceHandle?: string | null;
    targetHandle?: string | null;
  },
) {
  if (!connection.source || !connection.target) return '请连接到另一个节点';
  if (connection.source === connection.target) return '节点不能连接自己';
  const sourceNode = definition.nodes.find((node) => node.id === connection.source);
  const targetNode = definition.nodes.find((node) => node.id === connection.target);
  const sourceDefinition = sourceNode ? nodeDefinition(catalog, sourceNode) : undefined;
  const targetDefinition = targetNode ? nodeDefinition(catalog, targetNode) : undefined;
  const output = findPort(sourceDefinition, connection.sourceHandle, 'output');
  const input = findPort(targetDefinition, connection.targetHandle, 'input');
  const sourceHasPorts = (sourceDefinition?.outputs.length ?? 0) > 0;
  const targetHasPorts = (targetDefinition?.inputs.length ?? 0) > 0;
  if (
    sourceHasPorts
      ? !output
      : connection.sourceHandle != null && connection.sourceHandle !== execSourceHandle
  )
    return '请连接到对应的数据端口';
  if (
    targetHasPorts
      ? !input
      : connection.targetHandle != null && connection.targetHandle !== execTargetHandle
  )
    return '请连接到对应的数据端口';
  if (Boolean(output) !== Boolean(input)) return '请连接到对应的数据端口';
  const used = new Set(definition.edges.map((edge) => edge.id));
  let id = 'preview';
  let sequence = 0;
  while (used.has(id)) {
    sequence += 1;
    id = `preview${sequence}`;
  }
  const pairExists = definition.edges.some(
    (edge) => edge.source === connection.source && edge.target === connection.target,
  );
  const issue = validateWorkflow(
    {
      ...definition,
      edges: pairExists
        ? definition.edges
        : [...definition.edges, { id, source: connection.source, target: connection.target }],
      bindings:
        output && input
          ? [
              ...definition.bindings,
              {
                source: { nodeId: connection.source, port: output.id },
                target: { nodeId: connection.target, port: input.id },
              },
            ]
          : definition.bindings,
    },
    catalog,
  ).find(
    (item) =>
      item.code === 'cycle' ||
      item.code === 'duplicate_edge' ||
      item.code === 'port_type' ||
      item.code === 'duplicate_binding' ||
      item.code === 'invalid_binding',
  );
  return issue?.message ?? null;
}
