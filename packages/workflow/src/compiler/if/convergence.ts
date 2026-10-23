import { templateNodeOutputDependencies, type WorkflowDefinition } from '@dramaflow/contracts';
import type { NodeDependency } from '../dependency.compiler.js';
import type { BranchRegionAnalysis, SimpleIfRoute } from './branch-regions.js';
import type { IfCapabilityIssueCode } from './analysis.js';

type Reject = (code: IfCapabilityIssueCode, nodeId: string) => never;
export interface IfConvergence {
  ifNodeId: string;
  targetNodeId: string;
  completionGroups: { true: string[]; false: string[] };
}

// 从原始双分支可达证据找第一个共同目标。暂仅接受一个完整关闭 region 的边界，
// 不把后继每个共同节点都当成新边界，也不任选多个前沿中的一个。
export function inferConvergenceBoundaries(
  routes: readonly SimpleIfRoute[],
  dependencies: readonly NodeDependency[],
  evidence: BranchRegionAnalysis,
  reject: Reject,
): ReadonlyMap<string, string> {
  const parents = new Map(dependencies.map((d) => [d.targetNodeId, d.sourceNodeIds]));
  const boundaries = new Map<string, string>();
  for (const route of routes) {
    const shared = new Set(
      evidence.convergenceCandidates
        .filter((c) => c.ifNodeId === route.nodeId)
        .map((c) => c.nodeId),
    );
    if (!shared.size) continue;
    const frontier = [...shared].filter(
      (id) => !(parents.get(id) ?? []).some((parent) => shared.has(parent)),
    );
    if (frontier.length !== 1) reject('IF_CONVERGENCE_UNSUPPORTED', frontier[0] ?? route.nodeId);
    const target = frontier[0]!;
    if (target === route.true || target === route.false)
      reject('IF_CONVERGENCE_UNSUPPORTED', target);
    if (routes.some((other) => other.nodeId === target)) reject('IF_NESTED_UNSUPPORTED', target);
    boundaries.set(route.nodeId, target);
  }
  return boundaries;
}

// 此处仅产生编译期 completion groups。互斥性来自同一个 If 的 one-hot route；
// 每个组包含本支完成要求 + 全部 ordinary 必需上游，不引入运行状态或调度器。
export function analyzeConvergenceDependencies(
  definition: WorkflowDefinition,
  dependencies: readonly NodeDependency[],
  boundaries: ReadonlyMap<string, string>,
  regions: BranchRegionAnalysis,
  reject: Reject,
): IfConvergence[] {
  const parents = new Map(dependencies.map((d) => [d.targetNodeId, d.sourceNodeIds]));
  const valueDependencies = [
    ...definition.edges
      .filter((edge) => edge.kind === 'data')
      .map((edge) => ({ sourceNodeId: edge.source.nodeId, targetNodeId: edge.target.nodeId })),
    ...templateNodeOutputDependencies(definition.nodes),
  ];
  return [...boundaries].map(([ifNodeId, targetNodeId]) => {
    if (regions.memberships.get(targetNodeId)?.length)
      reject('IF_REGION_INTERSECTION_UNSUPPORTED', targetNodeId);
    const yes = regions.regions.find(
      (region) => region.ifNodeId === ifNodeId && region.branch === 'true',
    )!;
    const no = regions.regions.find(
      (region) => region.ifNodeId === ifNodeId && region.branch === 'false',
    )!;
    const sources = parents.get(targetNodeId) ?? [];
    const trueSources = sources.filter((id) => yes.nodeIds.has(id));
    const falseSources = sources.filter((id) => no.nodeIds.has(id));
    if (
      !trueSources.length ||
      !falseSources.length ||
      yes.terminalNodeIds.some((id) => !trueSources.includes(id)) ||
      no.terminalNodeIds.some((id) => !falseSources.includes(id))
    )
      reject('IF_CONVERGENCE_UNSUPPORTED', targetNodeId);
    const common = sources.filter((id) => !yes.nodeIds.has(id) && !no.nodeIds.has(id));
    if (common.some((id) => regions.memberships.get(id)?.length))
      reject('IF_REGION_INTERSECTION_UNSUPPORTED', targetNodeId);
    // 只支持控制汇聚。分支值在另一条路径中可能缺失，不能靠 alternatives
    // 掩盖 Binding 的固定来源语义；ordinary 值仍照常由现有 BindingResolver 读取。
    if (
      valueDependencies.some(
        (d) =>
          d.targetNodeId === targetNodeId &&
          (yes.nodeIds.has(d.sourceNodeId) || no.nodeIds.has(d.sourceNodeId)),
      )
    )
      reject('IF_CONVERGENCE_INPUT_UNSUPPORTED', targetNodeId);
    return {
      ifNodeId,
      targetNodeId,
      completionGroups: {
        true: sources.filter((id) => !no.nodeIds.has(id)),
        false: sources.filter((id) => !yes.nodeIds.has(id)),
      },
    };
  });
}
