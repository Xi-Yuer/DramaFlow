import {
  isTypeAssignable,
  isSubworkflowNodeManifest,
  nestedGraphSlots,
  type GraphDefinitionPath,
  graphDefinitionSchema,
  workflowOutputSources,
  StringType,
  type NodeDefinition,
  type GraphDefinition,
} from '@dramaflow/contracts';
import { StateGraph } from '@langchain/langgraph';
import { NodeRegistry } from '../node/registry.js';
import type { NodeDeclaration } from '../node/type.js';
import { DefaultDataStoragePolicyResolver } from '../runtime/values/data-storage-policy-resolver.js';
import {
  analyzeSimpleIfExecution,
  SimpleIfCapabilityError,
  ifCapabilityMessage,
  type IfCapabilityIssueCode,
} from '../compiler/if/analysis.js';
import { isHumanReviewNodeManifest } from '../node/human-review.js';
import { findUnsupportedHumanReviewTopology } from '../compiler/human-review/analysis.js';
import { isIterationNodeManifest } from '../node/iteration.js';
import {
  resolveNodePorts,
  validateIterationInputMapping,
  CompositeDefinitionError,
  type ResolvedNodePorts,
} from '@dramaflow/contracts';
import { WorkflowInvocationContractValidator } from './validate-invocation.js';
import { WorkflowStateAnnotation } from '../runtime/state.js';

export type WorkflowPublishIssueCode =
  | CompositeDefinitionError['code']
  | 'ITERATION_BODY_CAPABILITY_UNSUPPORTED'
  | 'ITERATION_BODY_EMPTY'
  | 'HUMAN_REVIEW_TOPOLOGY_UNSUPPORTED'
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
  | 'OUTPUT_STORAGE_UNSUPPORTED'
  | IfCapabilityIssueCode;

export class WorkflowPublishValidationError extends Error {
  constructor(
    readonly code: WorkflowPublishIssueCode,
    readonly nodeId: string,
    readonly portKey?: string,
    readonly definitionPath?: GraphDefinitionPath,
  ) {
    super(
      ifCapabilityMessage(code) ??
        (code === 'ITERATION_BODY_CAPABILITY_UNSUPPORTED'
          ? 'Iteration v1 body 仅允许普通 Action，尚不支持 control / interaction / composite'
          : code === 'ITERATION_BODY_EMPTY'
            ? 'Iteration body 至少需要一个 Action 节点'
            : undefined) ??
        (code === 'HUMAN_REVIEW_TOPOLOGY_UNSUPPORTED'
          ? '当前 Human Review 仅支持分支区域外的串行审核，不支持并行待审批'
          : code === 'NODE_EXECUTION_KIND_UNSUPPORTED'
            ? '当前 Compiler 尚不支持该节点执行种类'
            : '工作流不满足静态发布条件'),
    );
    this.name = 'WorkflowPublishValidationError';
  }
}

export interface ValidatedDefinitionNode {
  readonly node: NodeDefinition;
  readonly nodeType: NodeDeclaration;
  readonly config: unknown;
  readonly ports: ResolvedNodePorts;
  readonly definitionPath?: GraphDefinitionPath;
}

export type ValidatedPublishNode = ValidatedDefinitionNode;

interface GraphValidationContext {
  readonly definitionPath: GraphDefinitionPath;
  readonly capability: 'workflow' | 'iteration_body_v1';
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

// 正式 Definition Schema 统一校验引用、来源冲突和联合 DAG。
// 这里只检查 Registry / Schema 静态语义，不代表允许生产发布；生产调用下方门禁入口。
// 资源归属仍由应用层在发布事务内检查。
export function validateGraphDefinitionSemantics(
  definition: GraphDefinition,
  registry: NodeRegistry,
  context: GraphValidationContext = { definitionPath: [], capability: 'workflow' },
): ValidatedDefinitionNode[] {
  definition = graphDefinitionSchema.parse(definition);
  const { definitionPath } = context;
  const descendants: ValidatedDefinitionNode[] = [];
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
      !isIterationNodeManifest(declaration.manifest) &&
      !isSubworkflowNodeManifest(declaration.manifest) &&
      !isSupportedIf(declaration) &&
      !isHumanReviewNodeManifest(declaration.manifest) &&
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
    let ports: ResolvedNodePorts;
    try {
      ports = resolveNodePorts(node, nodeType.manifest);
      if (isIterationNodeManifest(nodeType.manifest)) validateIterationInputMapping(node, ports);
    } catch (error) {
      if (error instanceof CompositeDefinitionError)
        return invalid(error.code, node.id, error.portKey);
      throw error;
    }
    for (const slot of nestedGraphSlots(node)) {
      if (slot.graphKey === 'body' && slot.graph.nodes.length === 0)
        invalid('ITERATION_BODY_EMPTY', node.id);
      const childPath = [...definitionPath, { nodeId: node.id, graphKey: slot.graphKey }];
      try {
        descendants.push(
          ...validateGraphDefinitionSemantics(slot.graph, registry, {
            definitionPath: childPath,
            capability: 'workflow',
          }),
        );
      } catch (error) {
        if (error instanceof WorkflowPublishValidationError && !error.definitionPath)
          throw new WorkflowPublishValidationError(
            error.code,
            error.nodeId,
            error.portKey,
            childPath,
          );
        throw error;
      }
    }
    return {
      node,
      nodeType,
      config: config.data,
      ports,
      ...(definitionPath.length ? { definitionPath } : {}),
    };
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
    const output = source.ports.outputs.find((port) => port.key === edge.source.portKey);
    const input = target.ports.inputs.find((port) => port.key === edge.target.portKey);
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

  for (const { node, nodeType, ports: resolved } of entries) {
    const composite =
      isIterationNodeManifest(nodeType.manifest) || isSubworkflowNodeManifest(nodeType.manifest);
    const acceptsMissing = (key: string) =>
      composite
        ? resolved.inputs.find((port) => port.key === key)?.required === false
        : nodeType.inputSchema.shape[key]!.safeParse(undefined).success;
    const acceptsConstant = (key: string, value: unknown) => {
      if (!composite) return nodeType.inputSchema.shape[key]!.safeParse(value).success;
      const port = resolved.inputs.find((port) => port.key === key)!;
      // 空数组没有待验证的业务元素；显式 itemType 仍决定边界类型。
      if (port.dataType.kind === 'array' && Array.isArray(value) && value.length === 0) return true;
      try {
        new WorkflowInvocationContractValidator().validate(
          [{ name: key, type: port.dataType, required: true }],
          { [key]: { storage: 'inline', type: port.dataType, value } },
        );
        return true;
      } catch {
        return false;
      }
    };
    const ports = new Map(resolved.inputs.map((port) => [port.key, port]));
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
      else if (binding.type === 'candidate') {
        dynamic = true;
        for (const source of binding.sources) {
          const sourceNode = nodes.get(source.nodeId);
          if (!sourceNode) invalid('NODE_TYPE_UNAVAILABLE', source.nodeId);
          const output = sourceNode.ports.outputs.find(
            (outputPort) => outputPort.key === source.portKey,
          );
          if (!output) invalid('OUTPUT_PORT_NOT_FOUND', sourceNode.node.id, source.portKey);
          if (!isTypeAssignable(output.dataType, port.dataType))
            invalid('INPUT_TYPE_MISMATCH', node.id, key);
        }
      } else if (binding.type === 'workflow_input') {
        dynamic = true;
        const source = workflowInputs.get(binding.key)!;
        if (source.required === false && (port.required === true || !acceptsMissing(key)))
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
          const output = sourceNode.ports.outputs.find(
            (outputPort) => outputPort.key === source.portKey,
          );
          if (!output) invalid('OUTPUT_PORT_NOT_FOUND', sourceNode.node.id, source.portKey);
          if (!isTypeAssignable(output.dataType, StringType))
            invalid('INPUT_TYPE_MISMATCH', node.id, key);
        }
      } else {
        if (!acceptsConstant(key, binding.value)) invalid('INPUT_VALUE_INVALID', node.id, key);
        constants[key] = binding.value;
      }
    }
    for (const port of ports.values()) {
      if (
        !Object.hasOwn(node.inputs, port.key) &&
        !connected.has(port.key) &&
        !acceptsMissing(port.key)
      )
        invalid('INPUT_SOURCE_MISSING', node.id, port.key);
    }
    // 全部实际输入在发布时已知时，连同跨字段 refine / 默认值按 Runtime 同一 Schema 校验。
    if (!composite && !dynamic && !nodeType.inputSchema.safeParse(constants).success)
      invalid('INPUT_VALUE_INVALID', node.id);
  }

  for (const output of definition.outputs) {
    for (const candidate of workflowOutputSources(output)) {
      const source = nodes.get(candidate.nodeId)!;
      const port = source.ports.outputs.find((port) => port.key === candidate.outputKey);
      if (!port) invalid('OUTPUT_PORT_NOT_FOUND', source.node.id, candidate.outputKey);
      if (!isTypeAssignable(port.dataType, output.type))
        invalid('WORKFLOW_OUTPUT_TYPE_MISMATCH', source.node.id, candidate.outputKey);
    }
  }
  return [...entries, ...descendants];
}

// 执行准入单独检查；静态遍历完整不代表 Compiler 已能执行。
function assertGraphExecutionKinds(
  definition: GraphDefinition,
  registry: NodeRegistry,
  context: GraphValidationContext = { definitionPath: [], capability: 'workflow' },
): void {
  for (const node of definition.nodes) {
    let declaration: NodeDeclaration;
    try {
      declaration = registry.get(node.type, node.typeVersion);
    } catch {
      throw new WorkflowPublishValidationError(
        'NODE_TYPE_UNAVAILABLE',
        node.id,
        undefined,
        context.definitionPath,
      );
    }
    if (
      context.capability === 'iteration_body_v1' &&
      (declaration.manifest.executionKind !== 'action' ||
        !declaration.execute ||
        (declaration.manifest.controlOutputs?.length ?? 0) > 0)
    )
      throw new WorkflowPublishValidationError(
        'ITERATION_BODY_CAPABILITY_UNSUPPORTED',
        node.id,
        undefined,
        context.definitionPath,
      );
    if (isSubworkflowNodeManifest(declaration.manifest))
      throw new WorkflowPublishValidationError(
        'NODE_EXECUTION_KIND_UNSUPPORTED',
        node.id,
        undefined,
        context.definitionPath,
      );
    for (const slot of nestedGraphSlots(node))
      assertGraphExecutionKinds(slot.graph, registry, {
        definitionPath: [...context.definitionPath, { nodeId: node.id, graphKey: slot.graphKey }],
        capability: slot.graphKey === 'body' ? 'iteration_body_v1' : 'workflow',
      });
  }
}

export function assertGraphPublishTopology(
  definition: GraphDefinition,
  registry: NodeRegistry,
  context: GraphValidationContext = { definitionPath: [], capability: 'workflow' },
): void {
  const entries = definition.nodes.map((node) => ({
    node,
    nodeType: registry.get(node.type, node.typeVersion),
  }));
  const ifNodeIds = new Set(
    entries.filter((entry) => isSupportedIf(entry.nodeType)).map((entry) => entry.node.id),
  );
  let ifAnalysis: ReturnType<typeof analyzeSimpleIfExecution> | undefined;
  if (
    ifNodeIds.size ||
    definition.nodes.some((node) =>
      Object.values(node.inputs).some((binding) => binding.type === 'candidate'),
    ) ||
    definition.outputs.some((output) => output.sources !== undefined)
  ) {
    try {
      ifAnalysis = analyzeSimpleIfExecution(definition, ifNodeIds);
    } catch (error) {
      if (error instanceof SimpleIfCapabilityError)
        throw new WorkflowPublishValidationError(
          error.code,
          error.nodeId,
          undefined,
          context.definitionPath,
        );
      throw error;
    }
  }
  const unsupportedReview = findUnsupportedHumanReviewTopology(
    definition,
    new Set(
      entries
        .filter((entry) => isHumanReviewNodeManifest(entry.nodeType.manifest))
        .map((entry) => entry.node.id),
    ),
    ifAnalysis?.branchRegions,
  );
  if (unsupportedReview)
    throw new WorkflowPublishValidationError(
      'HUMAN_REVIEW_TOPOLOGY_UNSUPPORTED',
      unsupportedReview,
      undefined,
      context.definitionPath,
    );
  for (const node of definition.nodes)
    for (const slot of nestedGraphSlots(node))
      assertGraphPublishTopology(slot.graph, registry, {
        definitionPath: [...context.definitionPath, { nodeId: node.id, graphKey: slot.graphKey }],
        capability: slot.graphKey === 'body' ? 'iteration_body_v1' : 'workflow',
      });
}

// 拓扑、执行种类分别可复用；完整执行准入始终同时检查两者。
export function assertGraphExecutionCapabilities(
  definition: GraphDefinition,
  registry: NodeRegistry,
  context: GraphValidationContext = { definitionPath: [], capability: 'workflow' },
): void {
  assertGraphExecutionKinds(definition, registry, context);
  assertGraphPublishTopology(definition, registry, context);
}

// 正式 Publish / Compiler 的完整入口始终包含 execution capability gate。
export function validateGraphForPublish(
  definition: GraphDefinition,
  registry: NodeRegistry,
  context: GraphValidationContext = { definitionPath: [], capability: 'workflow' },
): ValidatedPublishNode[] {
  definition = graphDefinitionSchema.parse(definition);
  assertGraphExecutionKinds(definition, registry, context);
  const entries = validateGraphDefinitionSemantics(definition, registry, context);
  assertGraphExecutionCapabilities(definition, registry, context);
  return entries;
}

// 根 Workflow 与局部图共用静态协议；资源授权后仍必须执行 capability gate。
// 旧入口被 Compiler 使用，保留其执行准入及错误优先级。
export function validateWorkflowDefinitionSemantics(
  definition: GraphDefinition,
  registry: NodeRegistry,
): ValidatedDefinitionNode[] {
  definition = graphDefinitionSchema.parse(definition);
  assertGraphExecutionKinds(definition, registry);
  const entries = validateGraphDefinitionSemantics(definition, registry);
  // 旧入口对子图使用完整发布门禁；根图的拓扑分析仍由 Compiler 自身执行。
  for (const node of definition.nodes)
    for (const slot of nestedGraphSlots(node))
      assertGraphExecutionCapabilities(slot.graph, registry, {
        definitionPath: [{ nodeId: node.id, graphKey: slot.graphKey }],
        capability: slot.graphKey === 'body' ? 'iteration_body_v1' : 'workflow',
      });
  return entries;
}
export const validateWorkflowForPublish = validateGraphForPublish;
