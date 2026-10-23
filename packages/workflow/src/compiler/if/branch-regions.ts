import type { NodeDependency } from '../dependency.compiler.js';

export interface SimpleIfRoute {
  nodeId: string;
  true: string;
  false: string;
}
export interface MergeBoundary {
  nodeId: string;
  openerNodeId: string;
}
export interface BranchRegion {
  ifNodeId: string;
  branch: 'true' | 'false';
  entryNodeId: string;
  nodeIds: ReadonlySet<string>;
  terminalNodeIds: readonly string[];
  guaranteedBefore: ReadonlySet<string>;
}
export interface BranchRegionAnalysis {
  regions: BranchRegion[];
  // 保留全部归属证据，不能把冲突节点任选归给一个 region。
  memberships: ReadonlyMap<string, readonly BranchRegion[]>;
  convergenceCandidates: readonly { nodeId: string; ifNodeId: string }[];
  intersections: readonly string[];
  ordinaryNodeIds: readonly string[];
}

// 只做静态可达性分析；调用方提供 collectNodeDependencies 的统一、去重结果。
// 命名条件出口由 routes 提供种子，不进入 ordinaryDependencies。
export function analyzeBranchRegions(
  nodeIds: readonly string[],
  routes: readonly SimpleIfRoute[],
  ordinaryDependencies: readonly NodeDependency[],
  mergeBoundaries: readonly MergeBoundary[] = [],
): BranchRegionAnalysis {
  const children = new Map<string, string[]>();
  const parents = new Map<string, readonly string[]>();
  for (const dependency of ordinaryDependencies) {
    parents.set(dependency.targetNodeId, dependency.sourceNodeIds);
    for (const source of dependency.sourceNodeIds) {
      const targets = children.get(source) ?? [];
      targets.push(dependency.targetNodeId);
      children.set(source, targets);
    }
  }
  function reachable(
    seeds: readonly string[],
    adjacency: ReadonlyMap<string, readonly string[]>,
    boundaryId?: string,
  ): Set<string> {
    const result = new Set<string>();
    const pending = [...seeds];
    for (let index = 0; index < pending.length; index++) {
      const id = pending[index]!;
      if (id === boundaryId || result.has(id)) continue;
      result.add(id);
      pending.push(...(adjacency.get(id) ?? []));
    }
    return result;
  }
  const regions: BranchRegion[] = [];
  const memberships = new Map<string, BranchRegion[]>(nodeIds.map((id) => [id, []]));
  for (const route of routes) {
    const guaranteedBefore = reachable(parents.get(route.nodeId) ?? [], parents);
    for (const branch of ['true', 'false'] as const) {
      const entryNodeId = route[branch];
      const boundary = mergeBoundaries.find((boundary) => boundary.openerNodeId === route.nodeId);
      const members = reachable([entryNodeId], children, boundary?.nodeId);
      const region: BranchRegion = {
        ifNodeId: route.nodeId,
        branch,
        entryNodeId,
        nodeIds: members,
        guaranteedBefore,
        terminalNodeIds: [...members].filter(
          (id) => !(children.get(id) ?? []).some((target) => members.has(target)),
        ),
      };
      regions.push(region);
      for (const id of members) memberships.get(id)?.push(region);
    }
  }
  const convergenceCandidates: { nodeId: string; ifNodeId: string }[] = [];
  const intersections: string[] = [];
  for (const [nodeId, regions] of memberships) {
    const owners = new Map<string, Set<string>>();
    for (const region of regions) {
      const branches = owners.get(region.ifNodeId) ?? new Set<string>();
      branches.add(region.branch);
      owners.set(region.ifNodeId, branches);
    }
    for (const [ifNodeId, branches] of owners)
      if (branches.size > 1) convergenceCandidates.push({ nodeId, ifNodeId });
    if (owners.size > 1) intersections.push(nodeId);
  }
  return {
    regions,
    memberships,
    convergenceCandidates,
    intersections,
    ordinaryNodeIds: nodeIds.filter((id) => !memberships.get(id)?.length),
  };
}
