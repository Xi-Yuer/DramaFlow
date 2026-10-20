import type {
  DataEdgeDefinition,
  NodeDefinition,
  NodeOutputMap,
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
  readonly edges: readonly WorkflowEdge[];
  readonly state: WorkflowState;
}

export interface BindingResolver {
  resolveInputs(context: BindingResolverContext): Promise<Record<string, RuntimeValue>>;
}

export interface StaticBindingResolverContext extends BindingResolverContext {
  readonly inputKey: string;
}

// 三类静态 Binding 的转换由显式注入的实现负责；本层不推断类型或查找资产最新版。
export interface StaticBindingResolver {
  resolveValue(
    binding: StaticInputBinding,
    context: StaticBindingResolverContext,
  ): Promise<RuntimeValue>;
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

export function createBindingResolver(staticBindings: StaticBindingResolver): BindingResolver {
  return {
    async resolveInputs(context) {
      const { node, edges, state } = context;
      // 在查找输出和调用静态解析服务之前检查冲突，不定义来源覆盖优先级。
      for (const edge of edges) {
        if (
          edge.kind === 'data' &&
          edge.target.nodeId === node.id &&
          Object.hasOwn(node.inputs, edge.target.portKey)
        ) {
          throw new BindingResolutionError(
            'INPUT_SOURCE_CONFLICT',
            `输入端口 ${node.id}.${edge.target.portKey} 同时存在静态绑定和数据边`,
            edgeDetails(edge),
          );
        }
      }

      const inputs = Object.entries(resolveDataEdgeInputs(node.id, edges, state.outputs));
      for (const [inputKey, binding] of Object.entries(node.inputs)) {
        const value = await staticBindings.resolveValue(binding, { ...context, inputKey });
        inputs.push([inputKey, value]);
      }
      return Object.fromEntries(inputs);
    },
  };
}
