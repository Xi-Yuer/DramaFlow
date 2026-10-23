import {
  isTypeAssignable,
  StringType,
  type NodeDefinition,
  type WorkflowDefinition,
} from '@dramaflow/contracts';
import { StateGraph } from '@langchain/langgraph';
import { NodeRegistry } from '../node/registry.js';
import type { NodeDeclaration, NodeType } from '../node/type.js';
import { DefaultDataStoragePolicyResolver } from '../runtime/values/data-storage-policy-resolver.js';
import { WorkflowStateAnnotation } from '../runtime/state.js';

export type WorkflowPublishIssueCode =
  | 'NODE_TYPE_UNAVAILABLE'
  | 'NODE_EXECUTION_KIND_UNSUPPORTED'
  | 'NODE_ID_INVALID'
  | 'NODE_CONFIG_INVALID'
  | 'INPUT_PORT_NOT_FOUND'
  | 'OUTPUT_PORT_NOT_FOUND'
  | 'INPUT_SOURCE_MISSING'
  | 'INPUT_SOURCE_OPTIONAL'
  | 'INPUT_VALUE_INVALID'
  | 'INPUT_TYPE_MISMATCH'
  | 'WORKFLOW_OUTPUT_TYPE_MISMATCH'
  | 'NAMED_CONTROL_PORT_UNSUPPORTED'
  | 'CONTROL_OUTPUT_PORT_REQUIRED'
  | 'CONTROL_OUTPUT_BRANCH_MISSING'
  | 'ASSET_BINDING_UNSUPPORTED'
  | 'OUTPUT_STORAGE_UNSUPPORTED';

export class WorkflowPublishValidationError extends Error {
  constructor(
    readonly code: WorkflowPublishIssueCode,
    readonly nodeId: string,
    readonly portKey?: string,
  ) {
    super(
      code === 'NODE_EXECUTION_KIND_UNSUPPORTED'
        ? '当前 Compiler 尚不支持该节点执行种类，不能发布执行'
        : '工作流不满足静态发布条件',
    );
    this.name = 'WorkflowPublishValidationError';
  }
}

export interface ValidatedDefinitionNode {
  readonly node: NodeDefinition;
  readonly nodeType: NodeDeclaration;
  readonly config: unknown;
}

export interface ValidatedPublishNode extends ValidatedDefinitionNode {
  readonly nodeType: NodeType;
}

function isSupportedIf(nodeType: NodeDeclaration): boolean {
  const { manifest } = nodeType;
  return (
    manifest.type === 'flow.if' && manifest.version === 1 && manifest.executionKind === 'control'
  );
}

function invalid(code: WorkflowPublishIssueCode, nodeId: string, portKey?: string): never {
  throw new WorkflowPublishValidationError(code, nodeId, portKey);
}

// 仅调用官方 addNode 的命名检查，不 compile / invoke；绝不提供运行时替身或业务结果。
function staticOnlyNode(): never {
  throw new Error('发布校验不能执行节点');
}

// 调用方先用正式 Definition Schema 校验引用、来源冲突和联合 DAG。
// 这里只检查 Registry / Schema 静态语义，不代表允许生产发布；生产调用下方门禁入口。
// 资源归属仍由应用层在发布事务内检查。
export function validateWorkflowDefinitionSemantics(
  definition: WorkflowDefinition,
  registry: NodeRegistry,
): ValidatedDefinitionNode[] {
  const names = new StateGraph(WorkflowStateAnnotation);
  const storage = new DefaultDataStoragePolicyResolver();
  const entries = definition.nodes.map((node): ValidatedDefinitionNode => {
    let declaration;
    try {
      declaration = registry.get(node.type, node.typeVersion);
    } catch {
      return invalid('NODE_TYPE_UNAVAILABLE', node.id);
    }
    if (
      !isSupportedIf(declaration) &&
      (declaration.manifest.executionKind !== 'action' || !declaration.execute)
    )
      return invalid('NODE_EXECUTION_KIND_UNSUPPORTED', node.id);
    const nodeType = declaration;
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
  const workflowInputs = new Map(definition.inputs.map((input) => [input.name, input]));

  for (const edge of definition.edges) {
    if (edge.kind === 'control') {
      const source = nodes.get(edge.source.nodeId)!;
      // 当前仅声明控制出口；目标命名控制输入没有对应协议，不放行。
      if (edge.target.portKey !== undefined)
        invalid('NAMED_CONTROL_PORT_UNSUPPORTED', edge.target.nodeId, edge.target.portKey);
      if (edge.source.portKey !== undefined) {
        if (
          !source.nodeType.manifest.controlOutputs?.some((port) => port.key === edge.source.portKey)
        )
          invalid('NAMED_CONTROL_PORT_UNSUPPORTED', source.node.id, edge.source.portKey);
      } else if (isSupportedIf(source.nodeType)) {
        invalid('CONTROL_OUTPUT_PORT_REQUIRED', source.node.id);
      }
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
    if (!isSupportedIf(nodeType)) continue;
    for (const branch of ['true', 'false']) {
      if (
        !definition.edges.some(
          (edge) =>
            edge.kind === 'control' &&
            edge.source.nodeId === node.id &&
            edge.source.portKey === branch,
        )
      )
        invalid('CONTROL_OUTPUT_BRANCH_MISSING', node.id, branch);
    }
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
      else if (binding.type === 'workflow_input') {
        dynamic = true;
        const source = workflowInputs.get(binding.key)!;
        if (
          source.required === false &&
          (port.required === true || !nodeType.inputSchema.shape[key]!.safeParse(undefined).success)
        )
          invalid('INPUT_SOURCE_OPTIONAL', node.id, key);
        if (!isTypeAssignable(source.type, port.dataType))
          invalid('INPUT_TYPE_MISMATCH', node.id, key);
      } else if (binding.type === 'template') {
        dynamic = true;
        if (!isTypeAssignable(StringType, port.dataType))
          invalid('INPUT_TYPE_MISMATCH', node.id, key);
        for (const source of Object.values(binding.variables)) {
          if (source.type === 'workflow_input') {
            const input = workflowInputs.get(source.key);
            if (input?.required === false) invalid('INPUT_SOURCE_OPTIONAL', node.id, key);
            if (!input || !isTypeAssignable(input.type, StringType))
              invalid('INPUT_TYPE_MISMATCH', node.id, key);
            continue;
          }
          const sourceNode = nodes.get(source.nodeId);
          if (!sourceNode) invalid('NODE_TYPE_UNAVAILABLE', source.nodeId);
          const output = sourceNode.nodeType.manifest.outputs.find(
            (outputPort) => outputPort.key === source.portKey,
          );
          if (!output) invalid('OUTPUT_PORT_NOT_FOUND', sourceNode.node.id, source.portKey);
          if (!isTypeAssignable(output.dataType, StringType))
            invalid('INPUT_TYPE_MISMATCH', node.id, key);
        }
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

// 生产发布必须经过此入口。静态语义合法不等于当前 Compiler 已支持执行。
// 阶段性门禁涵盖全部 If 拓扑和分支最终输出，不向 Contract 注入永久限制。
export function validateWorkflowForPublish(
  definition: WorkflowDefinition,
  registry: NodeRegistry,
): ValidatedPublishNode[] {
  const entries = validateWorkflowDefinitionSemantics(definition, registry);
  return entries.map((entry) => {
    if (entry.nodeType.manifest.executionKind !== 'action')
      invalid('NODE_EXECUTION_KIND_UNSUPPORTED', entry.node.id);
    return { ...entry, nodeType: registry.getAction(entry.node.type, entry.node.typeVersion) };
  });
}
