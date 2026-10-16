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

export function toCanvasEdges(definition: WorkflowDefinition): Edge[] {
  return definition.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
  }));
}

/** 只保留协议字段。React Flow 的选中、测量和端口句柄不进入项目草稿。 */
export function toWorkflow(
  nodes: CanvasNode[],
  edges: Edge[],
  bindings: WorkflowDefinition['bindings'],
): WorkflowDefinition {
  const ids = new Set(nodes.map((node) => node.id));
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
    edges: edges
      .filter((edge) => ids.has(edge.source) && ids.has(edge.target))
      .map((edge) => ({ id: edge.id, source: edge.source, target: edge.target })),
    bindings: bindings.filter(
      (binding) => ids.has(binding.source.nodeId) && ids.has(binding.target.nodeId),
    ),
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
  bindings: WorkflowDefinition['bindings'],
  viewport: { x: number; y: number; zoom: number },
) {
  const definition = toWorkflow(nodes, edges, bindings);
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

/** 预览一条执行连线。数据端口尚未接入，连线只表示执行顺序。 */
export function connectionIssue(
  definition: WorkflowDefinition,
  catalog: NodeDefinition[],
  connection: { source: string | null; target: string | null },
) {
  if (!connection.source || !connection.target) return '请连接到另一个节点';
  if (connection.source === connection.target) return '节点不能连接自己';
  const used = new Set(definition.edges.map((edge) => edge.id));
  let id = 'preview';
  let sequence = 0;
  while (used.has(id)) {
    sequence += 1;
    id = `preview${sequence}`;
  }
  const issue = validateWorkflow(
    {
      ...definition,
      edges: [...definition.edges, { id, source: connection.source, target: connection.target }],
    },
    catalog,
  ).find((item) => item.code === 'cycle' || item.code === 'duplicate_edge');
  return issue?.message ?? null;
}
