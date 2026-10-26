import {
  graphDefinitionSchema,
  nestedGraphSlots,
  type GraphDefinition,
} from '@dramaflow/contracts';
import {
  validateGraphDefinitionSemantics,
  type GraphValidationContext,
  type ValidatedDefinitionNode,
  type ValidatedPublishNode,
  WorkflowPublishValidationError,
} from '../definition/publish/validate-publish.js';
import { isHumanReviewNodeManifest } from '../node/builtin/human-review.js';
import { NodeRegistry } from '../node/registry/registry.js';
import type { NodeDeclaration } from '../node/registry/type.js';
import { findUnsupportedHumanReviewTopology } from './human-review/analysis.js';
import { analyzeSimpleIfExecution, SimpleIfCapabilityError } from './if/analysis.js';

function isSupportedIf(nodeType: NodeDeclaration): boolean {
  const { manifest } = nodeType;
  return (
    manifest.type === 'flow.if' && manifest.version === 1 && manifest.executionKind === 'control'
  );
}

// Candidate 先于节点种类拒绝：普通 Action DAG 中两个来源都会执行，不能留到运行期再报歧义。
function assertSubworkflowGraphBoundary(
  definition: GraphDefinition,
  registry: NodeRegistry,
  context: GraphValidationContext,
): void {
  if (context.capability !== 'subworkflow_graph_v1') return;
  for (const node of definition.nodes)
    for (const [key, binding] of Object.entries(node.inputs))
      if (binding.type === 'candidate')
        throw new WorkflowPublishValidationError(
          'SUBWORKFLOW_GRAPH_CANDIDATE_UNSUPPORTED',
          node.id,
          key,
          context.definitionPath,
        );
  for (const output of definition.outputs)
    if (output.sources !== undefined)
      throw new WorkflowPublishValidationError(
        'SUBWORKFLOW_GRAPH_CANDIDATE_UNSUPPORTED',
        output.name,
        undefined,
        context.definitionPath,
      );
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
      declaration.manifest.executionKind !== 'action' ||
      !declaration.execute ||
      (declaration.manifest.controlOutputs?.length ?? 0) > 0
    )
      throw new WorkflowPublishValidationError(
        'SUBWORKFLOW_GRAPH_CAPABILITY_UNSUPPORTED',
        node.id,
        undefined,
        context.definitionPath,
      );
  }
}

// 执行准入单独检查；静态遍历完整不代表 Compiler 已能执行。
function assertGraphExecutionKinds(
  definition: GraphDefinition,
  registry: NodeRegistry,
  context: GraphValidationContext = { definitionPath: [], capability: 'workflow' },
): void {
  assertSubworkflowGraphBoundary(definition, registry, context);
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
    for (const slot of nestedGraphSlots(node))
      assertGraphExecutionKinds(slot.graph, registry, {
        definitionPath: [...context.definitionPath, { nodeId: node.id, graphKey: slot.graphKey }],
        capability: slot.graphKey === 'body' ? 'iteration_body_v1' : 'subworkflow_graph_v1',
      });
  }
}

export function assertGraphPublishTopology(
  definition: GraphDefinition,
  registry: NodeRegistry,
  context: GraphValidationContext = { definitionPath: [], capability: 'workflow' },
): void {
  assertSubworkflowGraphBoundary(definition, registry, context);
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
        capability: slot.graphKey === 'body' ? 'iteration_body_v1' : 'subworkflow_graph_v1',
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
        capability: slot.graphKey === 'body' ? 'iteration_body_v1' : 'subworkflow_graph_v1',
      });
  return entries;
}

export const validateWorkflowForPublish = validateGraphForPublish;
