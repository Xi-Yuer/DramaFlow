import {
  isTypeAssignable,
  StringType,
  type NodeTypeManifest,
  type WorkflowDefinition,
} from '@dramaflow/contracts';
import { findResolvedNodePorts } from '../../ports/resolve-workflow-node-ports';
import type { AvailableOutput } from './types';

// 自身以及沿边、候选或模板引用能够到达的节点都是下游。其余节点都可以成为新的上游，不会形成环。
export function downstreamNodeIds(
  definition: Pick<WorkflowDefinition, 'nodes' | 'edges'>,
  nodeId: string,
) {
  const outgoing = new Map<string, Set<string>>();
  const add = (source: string, target: string) => {
    const targets = outgoing.get(source) ?? new Set<string>();
    targets.add(target);
    outgoing.set(source, targets);
  };
  for (const edge of definition.edges) add(edge.source.nodeId, edge.target.nodeId);
  for (const node of definition.nodes) {
    for (const binding of Object.values(node.inputs)) {
      if (binding.type === 'candidate') {
        for (const source of binding.sources) add(source.nodeId, node.id);
      }
      if (binding.type !== 'template') continue;
      for (const source of Object.values(binding.variables)) {
        if (source.type === 'node_output') add(source.nodeId, node.id);
      }
    }
  }
  const downstream = new Set<string>([nodeId]);
  const pending = [nodeId];
  for (let index = 0; index < pending.length; index += 1) {
    const current = pending[index];
    if (!current) continue;
    for (const target of outgoing.get(current) ?? []) {
      if (downstream.has(target)) continue;
      downstream.add(target);
      pending.push(target);
    }
  }
  return downstream;
}

export function availableStringOutputs(
  definition: Pick<WorkflowDefinition, 'nodes' | 'edges'>,
  nodeId: string,
  manifests: readonly NodeTypeManifest[],
): AvailableOutput[] {
  const blocked = downstreamNodeIds(definition, nodeId);
  const outputs: AvailableOutput[] = [];
  for (const node of definition.nodes) {
    if (blocked.has(node.id)) continue;
    const ports = findResolvedNodePorts(node, manifests);
    if (!ports) continue;
    for (const port of ports.outputs) {
      if (!isTypeAssignable(port.dataType, StringType)) continue;
      outputs.push({
        nodeId: node.id,
        nodeName: node.name,
        portKey: port.key,
        portName: port.name,
      });
    }
  }
  return outputs;
}

export function sourceLabel(nodeName: string, portName: string) {
  return `${nodeName} · ${portName}`;
}

export function describeNodeOutput(
  definition: Pick<WorkflowDefinition, 'nodes'>,
  manifests: readonly NodeTypeManifest[],
  source: { nodeId: string; portKey: string },
) {
  const node = definition.nodes.find((item) => item.id === source.nodeId);
  const port = findResolvedNodePorts(node, manifests)?.outputs.find(
    (item) => item.key === source.portKey,
  );
  return {
    nodeName: node?.name ?? source.nodeId,
    portName: port?.name ?? source.portKey,
  };
}
