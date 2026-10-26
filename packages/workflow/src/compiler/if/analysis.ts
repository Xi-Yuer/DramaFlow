import type { WorkflowDefinition } from '@dramaflow/contracts';
import {
  ifCapabilityMessage,
  type IfCapabilityIssueCode,
} from '../../definition/publish/publish-issue.js';
import { collectNodeDependencies, type NodeDependency } from '../dependency/dependency.compiler.js';
import {
  analyzeConvergenceDependencies,
  inferConvergenceBoundaries,
  type IfConvergence,
} from './convergence.js';
import {
  analyzeBranchRegions,
  type BranchRegionAnalysis,
  type SimpleIfRoute,
} from './branch-regions.js';

export type { SimpleIfRoute } from './branch-regions.js';
export type { IfCapabilityIssueCode };
export class SimpleIfCapabilityError extends Error {
  constructor(
    readonly code: IfCapabilityIssueCode,
    readonly nodeId: string,
  ) {
    super(ifCapabilityMessage(code));
    this.name = 'SimpleIfCapabilityError';
  }
}
export interface IfTopologyAnalysis {
  routes: SimpleIfRoute[];
  branchRegions: BranchRegionAnalysis;
  ordinaryDependencies: NodeDependency[];
  convergences: IfConvergence[];
}
export interface SimpleIfExecutionAnalysis extends IfTopologyAnalysis {
  staticDependencies: NodeDependency[];
  roots: string[];
  leaves: string[];
  maxDepth: number;
  recursionLimit: number;
}

// 仅适用于已通过 Definition / Manifest 静态校验与 execution kind 门禁的图。
// Human Review 只能在分支区域外串行执行，由单独能力门禁确认。
// 这是当前 Compiler 的能力边界，不是永久 Workflow Contract 或自定义调度器。
export function analyzeIfTopology(
  definition: WorkflowDefinition,
  ifNodeIds: ReadonlySet<string>,
): IfTopologyAnalysis {
  const reject = (nodeId: string): never => {
    throw new SimpleIfCapabilityError('IF_TOPOLOGY_UNSUPPORTED', nodeId);
  };
  const routes: SimpleIfRoute[] = [];
  for (const nodeId of ifNodeIds) {
    const outgoing = definition.edges.filter((edge) => edge.source.nodeId === nodeId);
    const yes = outgoing.filter(
      (edge) =>
        edge.kind === 'control' &&
        edge.source.portKey === 'true' &&
        edge.target.portKey === undefined,
    );
    const no = outgoing.filter(
      (edge) =>
        edge.kind === 'control' &&
        edge.source.portKey === 'false' &&
        edge.target.portKey === undefined,
    );
    if (outgoing.length !== 2 || yes.length !== 1 || no.length !== 1) reject(nodeId);
    const route = { nodeId, true: yes[0]!.target.nodeId, false: no[0]!.target.nodeId };
    routes.push(route);
  }
  const ordinaryEdges = definition.edges.filter((edge) => !ifNodeIds.has(edge.source.nodeId));
  const ordinaryDependencies = collectNodeDependencies(ordinaryEdges, definition.nodes);
  const evidence = analyzeBranchRegions(
    definition.nodes.map((node) => node.id),
    routes,
    ordinaryDependencies,
  );
  const fail = (code: IfCapabilityIssueCode, nodeId: string): never => {
    throw new SimpleIfCapabilityError(code, nodeId);
  };
  const boundaries = inferConvergenceBoundaries(routes, ordinaryDependencies, evidence, fail);
  const branchRegions = boundaries.size
    ? analyzeBranchRegions(
        definition.nodes.map((node) => node.id),
        routes,
        ordinaryDependencies,
        boundaries,
      )
    : evidence;
  for (const id of ifNodeIds)
    if (branchRegions.memberships.get(id)?.length)
      throw new SimpleIfCapabilityError('IF_NESTED_UNSUPPORTED', id);
  if (branchRegions.convergenceCandidates.length)
    throw new SimpleIfCapabilityError(
      'IF_CONVERGENCE_UNSUPPORTED',
      branchRegions.convergenceCandidates[0]!.nodeId,
    );
  if (branchRegions.intersections.length)
    throw new SimpleIfCapabilityError(
      'IF_REGION_INTERSECTION_UNSUPPORTED',
      branchRegions.intersections[0]!,
    );
  const convergences = analyzeConvergenceDependencies(
    definition,
    ordinaryDependencies,
    boundaries,
    branchRegions,
    fail,
  );
  const parents = new Map(
    ordinaryDependencies.map((dependency) => [dependency.targetNodeId, dependency.sourceNodeIds]),
  );
  for (const region of branchRegions.regions)
    for (const id of region.nodeIds) {
      const upstream = parents.get(id) ?? [];
      if (
        upstream.some(
          (source) => !region.nodeIds.has(source) && !region.guaranteedBefore.has(source),
        ) ||
        (id !== region.entryNodeId && !upstream.some((source) => region.nodeIds.has(source)))
      )
        throw new SimpleIfCapabilityError('IF_BRANCH_DEPENDENCY_UNSUPPORTED', id);
    }
  // Definition 已无环，region 内只包含 Action；每个 successor 保留本分支依赖，
  // 全部其他依赖已由 If 前置保证。由 entry 沿 DAG 归纳，选中分支的所有成员必执行。
  for (const output of definition.outputs) {
    if (output.sources !== undefined) {
      const candidates = output.sources;
      const first = candidates[0] && branchRegions.memberships.get(candidates[0].nodeId)?.[0];
      const second = candidates[1] && branchRegions.memberships.get(candidates[1].nodeId)?.[0];
      if (
        candidates.length === 2 &&
        first &&
        second &&
        first.ifNodeId === second.ifNodeId &&
        first.branch !== second.branch
      )
        continue;
      throw new SimpleIfCapabilityError(
        'CONDITIONAL_WORKFLOW_OUTPUT_UNSUPPORTED',
        candidates[0]?.nodeId ?? 'workflow',
      );
    }
    if (branchRegions.memberships.get(output.source.nodeId)?.length)
      throw new SimpleIfCapabilityError(
        'CONDITIONAL_WORKFLOW_OUTPUT_UNSUPPORTED',
        output.source.nodeId,
      );
  }
  return { routes, branchRegions, ordinaryDependencies, convergences };
}

// 静态拓扑校验与执行投影分离；仅对已证明安全的汇聚目标产生 alternative completion groups。
export function analyzeSimpleIfExecution(
  definition: WorkflowDefinition,
  ifNodeIds: ReadonlySet<string>,
): SimpleIfExecutionAnalysis {
  const topology = analyzeIfTopology(definition, ifNodeIds);
  const { routes, ordinaryDependencies } = topology;
  const reject = (nodeId: string): never => {
    throw new SimpleIfCapabilityError('IF_TOPOLOGY_UNSUPPORTED', nodeId);
  };
  // entry 仅由 conditional route 触发；successor 的 ALL 依赖和原始 Binding 均保留。
  const entries = new Set(routes.flatMap((route) => [route.true, route.false]));
  const convergenceByTarget = new Map(topology.convergences.map((c) => [c.targetNodeId, c]));
  const staticDependencies = ordinaryDependencies.flatMap((dependency): NodeDependency[] => {
    if (entries.has(dependency.targetNodeId)) return [];
    const convergence = convergenceByTarget.get(dependency.targetNodeId);
    return convergence
      ? Object.values(convergence.completionGroups).map((sourceNodeIds) => ({
          targetNodeId: convergence.targetNodeId,
          sourceNodeIds,
        }))
      : [dependency];
  });
  const executionParents = new Map(definition.nodes.map((node) => [node.id, new Set<string>()]));
  for (const dependency of staticDependencies) {
    for (const source of dependency.sourceNodeIds)
      executionParents.get(dependency.targetNodeId)!.add(source);
  }
  for (const route of routes) {
    executionParents.get(route.true)!.add(route.nodeId);
    executionParents.get(route.false)!.add(route.nodeId);
  }
  const downstream = new Map<string, string[]>();
  const remaining = new Map<string, number>();
  for (const [target, sources] of executionParents) {
    remaining.set(target, sources.size);
    for (const source of sources) {
      const targets = downstream.get(source) ?? [];
      targets.push(target);
      downstream.set(source, targets);
    }
  }
  const roots = [...remaining].filter(([, count]) => count === 0).map(([id]) => id);
  const ready = [...roots];
  const levels = new Map(definition.nodes.map((node) => [node.id, 1]));
  let maxDepth = 0;
  for (let index = 0; index < ready.length; index++) {
    const source = ready[index]!;
    const level = levels.get(source)!;
    maxDepth = Math.max(maxDepth, level);
    for (const target of downstream.get(source) ?? []) {
      levels.set(target, Math.max(levels.get(target)!, level + 1));
      const count = remaining.get(target)! - 1;
      remaining.set(target, count);
      if (count === 0) ready.push(target);
    }
  }
  if (ready.length !== definition.nodes.length) reject(ready[0] ?? 'workflow');
  // 此拓扑每节点至多执行一次，If 路由写入属于 If 本身的 superstep；两支取潜在最长路径。
  // 再加一次终止检测，与纯 Action 分析独立维护并用真实 LangGraph 边界测试证明。
  return {
    ...topology,
    staticDependencies,
    roots,
    leaves: definition.nodes.filter((node) => !downstream.has(node.id)).map((node) => node.id),
    maxDepth,
    recursionLimit: maxDepth + 1,
  };
}
