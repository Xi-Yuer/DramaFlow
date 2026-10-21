import {
  isTypeAssignable,
  type NodeDefinition,
  type WorkflowDefinition,
} from '@dramaflow/contracts';
import { StateGraph } from '@langchain/langgraph';
import { NodeRegistry } from '../node/registry.js';
import type { NodeType } from '../node/type.js';
import { DefaultDataStoragePolicyResolver } from '../runtime/data-storage-policy-resolver.js';
import { WorkflowStateAnnotation } from '../runtime/state.js';

export type WorkflowPublishIssueCode =
  | 'NODE_TYPE_UNAVAILABLE'
  | 'NODE_EXECUTION_KIND_UNSUPPORTED'
  | 'NODE_ID_INVALID'
  | 'NODE_CONFIG_INVALID'
  | 'INPUT_PORT_NOT_FOUND'
  | 'OUTPUT_PORT_NOT_FOUND'
  | 'INPUT_SOURCE_MISSING'
  | 'INPUT_VALUE_INVALID'
  | 'INPUT_TYPE_MISMATCH'
  | 'WORKFLOW_OUTPUT_TYPE_MISMATCH'
  | 'NAMED_CONTROL_PORT_UNSUPPORTED'
  | 'ASSET_BINDING_UNSUPPORTED'
  | 'OUTPUT_STORAGE_UNSUPPORTED';

export class WorkflowPublishValidationError extends Error {
  constructor(
    readonly code: WorkflowPublishIssueCode,
    readonly nodeId: string,
    readonly portKey?: string,
  ) {
    super('工作流不满足当前 Action DAG 的静态发布条件');
    this.name = 'WorkflowPublishValidationError';
  }
}

export interface ValidatedPublishNode {
  readonly node: NodeDefinition;
  readonly nodeType: NodeType;
  readonly config: unknown;
}

function invalid(code: WorkflowPublishIssueCode, nodeId: string, portKey?: string): never {
  throw new WorkflowPublishValidationError(code, nodeId, portKey);
}

// 仅调用官方 addNode 的命名检查，不 compile / invoke；绝不提供运行时替身或业务结果。
function staticOnlyNode(): never {
  throw new Error('发布校验不能执行节点');
}

// 调用方先用正式 Definition Schema 校验引用、来源冲突和联合 DAG。
// 这里只补充依赖真实 Registry / Schema 的语义；资源归属由应用层在发布事务内检查。
export function validateWorkflowForPublish(
  definition: WorkflowDefinition,
  registry: NodeRegistry,
): ValidatedPublishNode[] {
  const names = new StateGraph(WorkflowStateAnnotation);
  const storage = new DefaultDataStoragePolicyResolver();
  const entries = definition.nodes.map((node): ValidatedPublishNode => {
    let declaration;
    try {
      declaration = registry.get(node.type, node.typeVersion);
    } catch {
      return invalid('NODE_TYPE_UNAVAILABLE', node.id);
    }
    if (declaration.manifest.executionKind !== 'action' || !declaration.execute)
      return invalid('NODE_EXECUTION_KIND_UNSUPPORTED', node.id);
    const nodeType = registry.getAction(node.type, node.typeVersion);
    try {
      names.addNode(node.id, staticOnlyNode);
    } catch {
      return invalid('NODE_ID_INVALID', node.id);
    }
    const config = nodeType.configSchema.strict().safeParse(node.config);
    if (!config.success) return invalid('NODE_CONFIG_INVALID', node.id);
    for (const output of nodeType.manifest.outputs) {
      if (output.storagePolicy === undefined || output.storagePolicy === 'auto') {
        try {
          storage.resolve(output.dataType, undefined);
        } catch {
          return invalid('OUTPUT_STORAGE_UNSUPPORTED', node.id, output.key);
        }
      }
    }
    return { node, nodeType, config: config.data };
  });
  const nodes = new Map(entries.map((entry) => [entry.node.id, entry]));
  const workflowInputs = new Map(definition.inputs.map((input) => [input.name, input.type]));

  for (const edge of definition.edges) {
    if (edge.kind === 'control') {
      if (edge.source.portKey !== undefined || edge.target.portKey !== undefined)
        invalid('NAMED_CONTROL_PORT_UNSUPPORTED', edge.target.nodeId);
      continue;
    }
    const source = nodes.get(edge.source.nodeId)!;
    const target = nodes.get(edge.target.nodeId)!;
    const output = source.nodeType.manifest.outputs.find(
      (port) => port.key === edge.source.portKey,
    );
    const input = target.nodeType.manifest.inputs.find((port) => port.key === edge.target.portKey);
    if (!output) invalid('OUTPUT_PORT_NOT_FOUND', source.node.id, edge.source.portKey);
    if (!input) invalid('INPUT_PORT_NOT_FOUND', target.node.id, edge.target.portKey);
    if (!isTypeAssignable(output.dataType, input.dataType))
      invalid('INPUT_TYPE_MISMATCH', target.node.id, input.key);
  }

  for (const { node, nodeType } of entries) {
    const ports = new Map(nodeType.manifest.inputs.map((port) => [port.key, port]));
    const connected = new Set(
      definition.edges
        .filter((edge) => edge.kind === 'data' && edge.target.nodeId === node.id)
        .map((edge) => edge.target.portKey),
    );
    const constants: Record<string, unknown> = {};
    let dynamic = connected.size > 0;
    for (const [key, binding] of Object.entries(node.inputs)) {
      const port = ports.get(key);
      if (!port) invalid('INPUT_PORT_NOT_FOUND', node.id, key);
      if (binding.type === 'asset') invalid('ASSET_BINDING_UNSUPPORTED', node.id, key);
      if (binding.type === 'workflow_input') {
        dynamic = true;
        const source = workflowInputs.get(binding.key)!;
        if (!isTypeAssignable(source, port.dataType)) invalid('INPUT_TYPE_MISMATCH', node.id, key);
      } else {
        if (!nodeType.inputSchema.shape[key]!.safeParse(binding.value).success)
          invalid('INPUT_VALUE_INVALID', node.id, key);
        constants[key] = binding.value;
      }
    }
    for (const port of ports.values()) {
      if (
        !Object.hasOwn(node.inputs, port.key) &&
        !connected.has(port.key) &&
        !nodeType.inputSchema.shape[port.key]!.safeParse(undefined).success
      )
        invalid('INPUT_SOURCE_MISSING', node.id, port.key);
    }
    // 全部实际输入在发布时已知时，连同跨字段 refine / 默认值按 Runtime 同一 Schema 校验。
    if (!dynamic && !nodeType.inputSchema.safeParse(constants).success)
      invalid('INPUT_VALUE_INVALID', node.id);
  }

  for (const output of definition.outputs) {
    const source = nodes.get(output.source.nodeId)!;
    const port = source.nodeType.manifest.outputs.find(
      (port) => port.key === output.source.outputKey,
    );
    if (!port) invalid('OUTPUT_PORT_NOT_FOUND', source.node.id, output.source.outputKey);
    if (!isTypeAssignable(port.dataType, output.type))
      invalid('WORKFLOW_OUTPUT_TYPE_MISMATCH', source.node.id, output.source.outputKey);
  }
  return entries;
}
