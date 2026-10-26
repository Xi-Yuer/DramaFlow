import type { SubWorkflowNodeCompilationStrategy } from '../subworkflow/strategy.js';
import {
  nestedGraphSlots,
  type GraphDefinition,
  type NodeDefinition,
  type GraphDefinitionPath,
  type NestedGraphSlot,
} from '@dramaflow/contracts';
import type { GraphDefinitionLocation } from '../../runtime/execution/execution-scope.js';
import type { NodeRegistry } from '../../node/registry/registry.js';
import type { NodeDeclaration } from '../../node/registry/type.js';
import type { ActionNodeCompilationStrategy } from '../strategy.js';
import type { IfNodeCompilationStrategy } from '../if/strategy.js';
import type { HumanReviewNodeCompilationStrategy } from '../human-review/strategy.js';
import type { IterationNodeCompilationStrategy } from '../iteration/strategy.js';
import { WorkflowPublishValidationError } from '../../definition/publish/validate-publish.js';
import {
  validateWorkflowDefinitionSemantics,
  assertGraphExecutionCapabilities,
} from '../execution-capabilities.js';
import { analyzeSimpleIfExecution, type SimpleIfExecutionAnalysis } from '../if/analysis.js';
import { findUnsupportedHumanReviewTopology } from '../human-review/analysis.js';
import { analyzeStaticDagExecution } from '../dependency/action-dag-execution-analysis.js';

// 复用已有 Location 与静态 path 类型，仅收窄当前正式 graph slots。
export type GraphCompilationLocation = GraphDefinitionLocation & { path: GraphDefinitionPath };

export interface GraphBoundaryShape {
  entry?: boolean;
  completion?: boolean;
}
export interface GraphStrategyStructure {
  wrapperNodes: number;
  childBoundaries: Partial<Record<NestedGraphSlot['graphKey'], GraphBoundaryShape>>;
}
interface StructuralStrategy {
  graphStructure?(node: NodeDefinition): GraphStrategyStructure;
}
export interface GraphCompilationStrategies {
  action: ActionNodeCompilationStrategy & StructuralStrategy;
  if: IfNodeCompilationStrategy & StructuralStrategy;
  review: HumanReviewNodeCompilationStrategy & StructuralStrategy;
  iteration: IterationNodeCompilationStrategy & StructuralStrategy;
  subworkflow?: SubWorkflowNodeCompilationStrategy & StructuralStrategy;
}
export type GraphStrategyKind = keyof GraphCompilationStrategies;
export interface GraphCompilationEntry {
  node: NodeDefinition;
  declaration: NodeDeclaration;
  strategy: GraphStrategyKind;
  structure?: GraphStrategyStructure;
}
export interface GraphCompilationBudget {
  localRecursionLimit: number;
  recursionLimit: number;
}
export interface GraphCompilationPlan {
  definition: GraphDefinition;
  definitionLocation: GraphCompilationLocation;
  entries: readonly GraphCompilationEntry[];
  strategies: GraphCompilationStrategies;
  boundary: GraphBoundaryShape;
  ifAnalysis?: SimpleIfExecutionAnalysis;
  children: readonly { ownerNodeId: string; graphKey: string; plan: GraphCompilationPlan }[];
  budget: GraphCompilationBudget;
  requirements: { values: boolean; executor: boolean; reviewRuns: boolean; iterationRuns: boolean; childGraphRuns:boolean };
}

// 只追加已有静态 slot；不把运行 scope、index 或引擎身份变成定义地址。
export function childGraphDefinitionLocation(
  location: GraphCompilationLocation,
  node: NodeDefinition,
  graphKey: string,
): GraphCompilationLocation {
  const slot = nestedGraphSlots(node).find((slot) => slot.graphKey === graphKey);
  if (!slot) throw new Error('静态子图槽位不存在');
  return {
    workflowVersionId: location.workflowVersionId,
    path: [...location.path, { nodeId: node.id, graphKey: slot.graphKey }],
  };
}

// 原生子图独立计算 supersteps；继承同一上限时取各层最大值，不相加 item 次数。
export function graphCompilationBudget(
  localLimit: number,
  boundary: GraphBoundaryShape,
  children: readonly GraphCompilationBudget[] = [],
  wrapperLimit = 0,
): GraphCompilationBudget {
  const localRecursionLimit = localLimit + Number(!!boundary.entry) + Number(!!boundary.completion);
  return {
    localRecursionLimit,
    recursionLimit: children.reduce(
      (limit, child) => Math.max(limit, child.recursionLimit),
      Math.max(localRecursionLimit, wrapperLimit),
    ),
  };
}

export interface GraphCompilationInput {
  definition: GraphDefinition;
  definitionLocation: GraphCompilationLocation;
  registry: NodeRegistry;
  strategies: GraphCompilationStrategies;
  boundary?: GraphBoundaryShape;
  capability?: 'workflow' | 'iteration_body_v1' | 'subworkflow_graph_v1';
}

function resolveEntries(input: GraphCompilationInput): GraphCompilationEntry[] {
  const { definition, registry, strategies } = input;
  return definition.nodes.map((node): GraphCompilationEntry => {
    const declaration = registry.get(node.type, node.typeVersion);
    const strategy = (Object.keys(strategies) as GraphStrategyKind[]).find((key) =>
      strategies[key]?.supports(declaration.manifest),
    );
    if (!strategy)
      throw new WorkflowPublishValidationError(
        'NODE_EXECUTION_KIND_UNSUPPORTED',
        node.id,
        undefined,
        input.definitionLocation.path,
      );
    if (strategy === 'action') registry.getAction(node.type, node.typeVersion);
    return { node, declaration, strategy, structure: strategies[strategy]?.graphStructure?.(node) };
  });
}

// 仅分析已有策略的编译结构，不构造 Runtime；嵌套预算分析不等于生产准入。
export function analyzeGraphCompilation(input: GraphCompilationInput): GraphCompilationPlan {
  const { definition, definitionLocation, registry, strategies } = input;
  const boundary = input.boundary ?? {};
  const entries = resolveEntries(input);
  const ifNodes = new Set(
    entries.filter((entry) => entry.strategy === 'if').map((entry) => entry.node.id),
  );
  const reviewNodes = new Set(
    entries.filter((entry) => entry.strategy === 'review').map((entry) => entry.node.id),
  );
  const ifAnalysis =
    ifNodes.size ||
    definition.nodes.some((node) =>
      Object.values(node.inputs).some((binding) => binding.type === 'candidate'),
    ) ||
    definition.outputs.some((output) => output.sources !== undefined)
      ? analyzeSimpleIfExecution(definition, ifNodes)
      : undefined;
  const unsupportedReview = findUnsupportedHumanReviewTopology(
    definition,
    reviewNodes,
    ifAnalysis?.branchRegions,
  );
  if (unsupportedReview)
    throw new WorkflowPublishValidationError(
      'HUMAN_REVIEW_TOPOLOGY_UNSUPPORTED',
      unsupportedReview,
      undefined,
      definitionLocation.path,
    );
  const children: GraphCompilationPlan['children'] = entries.flatMap((entry) =>
    nestedGraphSlots(entry.node).map((slot) => {
      const childBoundary = entry.structure?.childBoundaries[slot.graphKey];
      if (!childBoundary) throw new Error('当前策略没有声明子图编译结构');
      return {
        ownerNodeId: entry.node.id,
        graphKey: slot.graphKey,
        plan: analyzeGraphCompilation({
          definition: slot.graph,
          definitionLocation: childGraphDefinitionLocation(
            definitionLocation,
            entry.node,
            slot.graphKey,
          ),
          registry,
          strategies,
          boundary: childBoundary,
        }),
      };
    }),
  );
  const budget = graphCompilationBudget(
    (ifAnalysis ?? analyzeStaticDagExecution(definition)).recursionLimit,
    boundary,
    children.map((child) => child.plan.budget),
    entries.reduce(
      (limit, entry) => Math.max(limit, entry.structure ? entry.structure.wrapperNodes + 1 : 0),
      0,
    ),
  );
  return {
    definition,
    definitionLocation,
    entries,
    strategies,
    boundary,
    ifAnalysis,
    children,
    budget,
    requirements: {
      values:
        ifAnalysis !== undefined ||
        reviewNodes.size > 0 ||
        entries.some((entry) => (entry.strategy === 'iteration' || entry.strategy === 'subworkflow')) ||
        children.some((child) => child.plan.requirements.values),
      executor:
        entries.some((entry) => entry.strategy === 'action' || entry.strategy === 'iteration') ||
        children.some((child) => child.plan.requirements.executor),
      reviewRuns:
        reviewNodes.size > 0 || children.some((child) => child.plan.requirements.reviewRuns),
      iterationRuns:
        entries.some((entry) => entry.strategy === 'iteration') ||
        children.some((child) => child.plan.requirements.iterationRuns),
      childGraphRuns:entries.some(entry=>entry.strategy==='subworkflow') || children.some(child=>child.plan.requirements.childGraphRuns),
    },
  };
}

// 生产 Compiler 在构造任何执行服务前使用此入口；不提供跳过门禁的产品选项。
export function prepareGraphCompilation(input: GraphCompilationInput): GraphCompilationPlan {
  const { definition, definitionLocation, registry } = input;
  const entries = resolveEntries(input);
  // 分发能力与产品准入分离；局部 body 仍受原 Action-only 门禁约束。
  if (input.capability === 'iteration_body_v1' || input.capability === 'subworkflow_graph_v1')
    assertGraphExecutionCapabilities(definition, registry, {
      definitionPath: definitionLocation.path,
      capability: input.capability,
    });
  if (
    entries.some((entry) => entry.strategy !== 'action') ||
    definition.nodes.some((node) =>
      Object.values(node.inputs).some((binding) => binding.type === 'candidate'),
    ) ||
    definition.outputs.some((output) => output.sources !== undefined) ||
    definition.edges.some(
      (edge) =>
        edge.kind === 'control' &&
        (edge.source.portKey !== undefined || edge.target.portKey !== undefined),
    )
  )
    validateWorkflowDefinitionSemantics(definition, registry);
  return analyzeGraphCompilation(input);
}
