import type {
  DataEdgeDefinition,
  InputPortDefinition,
  NodeDefinition,
  NodeOutputMap,
  NodeTypeManifest,
  RuntimeValue,
  StaticInputBinding,
  WorkflowEdge,
} from '@dramaflow/contracts';
import {
  BindingResolutionError,
  type BindingResolutionErrorDetails,
} from './binding-resolution-error.js';
import type { WorkflowState } from './state.js';

export interface BindingResolverContext {
  readonly node: NodeDefinition;
  // 由上层按 node.type / typeVersion 取得并完成边界校验的同版本 Manifest。
  readonly nodeType: NodeTypeManifest;
  readonly edges: readonly WorkflowEdge[];
  readonly state: WorkflowState;
}

export interface BindingResolver {
  resolveInputs(context: BindingResolverContext): Promise<Record<string, RuntimeValue>>;
}

function edgeDetails(edge: DataEdgeDefinition): BindingResolutionErrorDetails {
  return {
    nodeId: edge.target.nodeId,
    inputKey: edge.target.portKey,
    edgeId: edge.id,
    sourceNodeId: edge.source.nodeId,
    sourcePortKey: edge.source.portKey,
  };
}

export function resolveDataEdgeInputs(
  nodeId: string,
  edges: readonly WorkflowEdge[],
  outputs: NodeOutputMap,
): Record<string, RuntimeValue> {
  const incoming = new Map<string, DataEdgeDefinition>();
  for (const edge of edges) {
    if (edge.kind !== 'data' || edge.target.nodeId !== nodeId) continue;
    if (incoming.has(edge.target.portKey)) {
      throw new BindingResolutionError(
        'INPUT_SOURCE_CONFLICT',
        `输入端口 ${nodeId}.${edge.target.portKey} 连接了多条数据边`,
        edgeDetails(edge),
      );
    }
    incoming.set(edge.target.portKey, edge);
  }

  return Object.fromEntries(
    Array.from(incoming, ([inputKey, edge]) => {
      const sourceOutputs = Object.hasOwn(outputs, edge.source.nodeId)
        ? outputs[edge.source.nodeId]
        : undefined;
      const value =
        sourceOutputs && Object.hasOwn(sourceOutputs, edge.source.portKey)
          ? sourceOutputs[edge.source.portKey]
          : undefined;
      if (value === undefined) {
        throw new BindingResolutionError(
          'SOURCE_NODE_OUTPUT_MISSING',
          `上游节点 ${edge.source.nodeId} 未产生输出 ${edge.source.portKey}`,
          edgeDetails(edge),
        );
      }
      // 只保留原 RuntimeValue，不 decode reference、不复制或改写上游结果。
      return [inputKey, value];
    }),
  );
}

function requireInputPort(
  ports: ReadonlyMap<string, InputPortDefinition>,
  details: BindingResolutionErrorDetails,
): InputPortDefinition {
  const port = ports.get(details.inputKey);
  if (!port) {
    throw new BindingResolutionError(
      'INPUT_PORT_NOT_FOUND',
      `节点 ${details.nodeId} 未声明输入端口 ${details.inputKey}`,
      details,
    );
  }
  return port;
}

function resolveStaticBinding(
  binding: StaticInputBinding,
  port: InputPortDefinition,
  context: BindingResolverContext,
): RuntimeValue {
  switch (binding.type) {
    case 'constant':
      return { storage: 'inline', type: port.dataType, value: binding.value };
    case 'workflow_input': {
      const value = Object.hasOwn(context.state.inputs, binding.key)
        ? context.state.inputs[binding.key]
        : undefined;
      if (value === undefined) {
        throw new BindingResolutionError(
          'WORKFLOW_INPUT_MISSING',
          `工作流输入 ${binding.key} 不存在`,
          { nodeId: context.node.id, inputKey: port.key, workflowInputKey: binding.key },
        );
      }
      // 工作流输入可能已是引用；保留原 RuntimeValue 及其实际类型和承载方式。
      return value;
    }
    case 'asset':
      return {
        storage: 'reference',
        type: port.dataType,
        reference: { kind: 'asset', id: binding.assetId, versionId: binding.versionId },
      };
  }
}

export function createBindingResolver(): BindingResolver {
  return {
    async resolveInputs(context) {
      const { node, nodeType, edges, state } = context;
      const ports = new Map(nodeType.inputs.map((port) => [port.key, port]));
      // 在查找输出和转换静态绑定前检查冲突与目标端口，不定义来源覆盖优先级。
      for (const edge of edges) {
        if (edge.kind !== 'data' || edge.target.nodeId !== node.id) continue;
        if (Object.hasOwn(node.inputs, edge.target.portKey)) {
          throw new BindingResolutionError(
            'INPUT_SOURCE_CONFLICT',
            `输入端口 ${node.id}.${edge.target.portKey} 同时存在静态绑定和数据边`,
            edgeDetails(edge),
          );
        }
        requireInputPort(ports, edgeDetails(edge));
      }

      const staticInputs = Object.entries(node.inputs).map(([inputKey, binding]) => ({
        inputKey,
        binding,
        port: requireInputPort(ports, { nodeId: node.id, inputKey }),
      }));
      const inputs = Object.entries(resolveDataEdgeInputs(node.id, edges, state.outputs));
      for (const { inputKey, binding, port } of staticInputs) {
        inputs.push([inputKey, resolveStaticBinding(binding, port, context)]);
      }
      return Object.fromEntries(inputs);
    },
  };
}
