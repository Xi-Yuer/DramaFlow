import {
  isTypeAssignable,
  type NodeTypeManifest,
  type WorkflowDefinition,
} from '@dramaflow/contracts';
import type { Node, XYPosition } from '@xyflow/react';
import { z } from 'zod';
import { workflowEdgeViewOptions } from '../canvas/rendering/edge-presentation';
import type { WorkflowEdge, WorkflowEdgeData } from '../canvas/react-flow-adapter';
import { parseWorkflowHandle } from '../canvas/adapter/workflow-handles';
import { resolveWorkflowNodePorts } from '../ports/resolve-workflow-node-ports';

export const BODY_INPUT_NODE_TYPE = 'workflowBodyInputs';

export type WorkflowBodyInputNode = Node<
  {
    inputs: WorkflowDefinition['inputs'];
    scope?: 'root' | 'body';
    onConfigure?: () => void;
    disabled?: boolean;
  },
  typeof BODY_INPUT_NODE_TYPE
>;

function unusedId(base: string, used: ReadonlySet<string>) {
  let id = base;
  while (used.has(id)) id += '_';
  return id;
}

// 只生成视图。边界节点和投影线都不进入 GraphDefinition。
export function projectBodyInputBoundary(
  definition: WorkflowDefinition,
  position?: XYPosition,
  options: Omit<WorkflowBodyInputNode['data'], 'inputs'> = {},
) {
  const id = unusedId('ui:body-inputs', new Set(definition.nodes.map((node) => node.id)));
  const node: WorkflowBodyInputNode = {
    id,
    type: BODY_INPUT_NODE_TYPE,
    deletable: false,
    position: position ?? {
      x: definition.nodes.length
        ? Math.min(...definition.nodes.map((item) => item.ui.position.x)) - 380
        : 40,
      y: definition.nodes.length
        ? Math.min(...definition.nodes.map((item) => item.ui.position.y))
        : 80,
    },
    data: { inputs: definition.inputs, ...options },
  };
  const usedEdges = new Set(definition.edges.map((edge) => edge.id));
  const edges: WorkflowEdge[] = [];
  for (const graphNode of definition.nodes) {
    for (const [portKey, binding] of Object.entries(graphNode.inputs)) {
      if (binding.type !== 'workflow_input') continue;
      if (!definition.inputs.some((input) => input.name === binding.key)) continue;
      let edgeId = `ui:body-input:${JSON.stringify([binding.key, graphNode.id, portKey])}`;
      while (usedEdges.has(edgeId)) edgeId += ':';
      usedEdges.add(edgeId);
      const data: WorkflowEdgeData = { kind: 'data', projection: 'workflow-input' };
      edges.push({
        id: edgeId,
        source: id,
        sourceHandle: binding.key,
        target: graphNode.id,
        targetHandle: portKey,
        data,
        ...workflowEdgeViewOptions(data),
        deletable: true,
        reconnectable: false,
        ariaLabel: options.scope === 'root' ? '工作流输入投影' : 'Body 输入投影',
      });
    }
  }
  return { node, edges };
}

export function isBodyInputConnection(
  definition: WorkflowDefinition,
  manifests: readonly NodeTypeManifest[],
  connection: {
    source?: string | null;
    sourceHandle?: string | null;
    target?: string | null;
    targetHandle?: string | null;
  },
  boundaryId: string,
) {
  if (connection.source !== boundaryId) return false;
  if (!connection.sourceHandle || !connection.target || !connection.targetHandle) return false;
  if (connection.target === boundaryId) return false;
  const input = definition.inputs.find((item) => item.name === connection.sourceHandle);
  const node = definition.nodes.find((item) => item.id === connection.target);
  if (!input || !node) return false;
  const manifest = manifests.find(
    (item) => item.type === node.type && item.version === node.typeVersion,
  );
  if (!manifest) return false;
  try {
    const handle = parseWorkflowHandle(connection.targetHandle, 'target');
    if (handle.kind !== 'data') return false;
    const port = resolveWorkflowNodePorts(node, manifest).inputs.find(
      (item) => item.key === handle.portKey,
    );
    return !!port && isTypeAssignable(input.type, port.dataType);
  } catch (error) {
    if (error instanceof z.ZodError) return false;
    throw error;
  }
}
