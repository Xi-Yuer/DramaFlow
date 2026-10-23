import type { NodeDependency } from '../dependency.compiler.js';
import type { BranchRegionAnalysis, MergeBoundary } from './branch-regions.js';

export interface AnalyzedMergeBoundary extends MergeBoundary {
  branchTerminals: { true: readonly string[]; false: readonly string[] };
}

// 只验证 / 描述边界，不生成 LangGraph 边，不赋予 Merge 任何执行能力。
export function analyzeMergeBoundaries(
  pairs: readonly MergeBoundary[],
  regions: BranchRegionAnalysis,
  dependencies: readonly NodeDependency[],
  reject: (
    code: 'MERGE_BYPASS_UNSUPPORTED' | 'MERGE_BRANCH_COVERAGE_INVALID',
    nodeId: string,
  ) => never,
): AnalyzedMergeBoundary[] {
  const parents = new Map(
    dependencies.map((dependency) => [dependency.targetNodeId, dependency.sourceNodeIds]),
  );
  const children = new Map<string, string[]>();
  for (const { targetNodeId, sourceNodeIds } of dependencies)
    for (const source of sourceNodeIds) {
      const targets = children.get(source) ?? [];
      targets.push(targetNodeId);
      children.set(source, targets);
    }
  return pairs.map((pair) => {
    const branches = regions.regions.filter((region) => region.ifNodeId === pair.openerNodeId);
    const yes = branches.find((region) => region.branch === 'true')!;
    const no = branches.find((region) => region.branch === 'false')!;
    // Data / Control / template 都从统一 dependency graph 检查。只要分支绕到
    // Merge 后的节点，该节点仍有 region membership，不能当作 unconditional。
    const pending = [...(children.get(pair.nodeId) ?? [])];
    const visited = new Set<string>();
    for (let index = 0; index < pending.length; index++) {
      const id = pending[index]!;
      if (visited.has(id)) continue;
      visited.add(id);
      if (yes.nodeIds.has(id) || no.nodeIds.has(id)) reject('MERGE_BYPASS_UNSUPPORTED', id);
      pending.push(...(children.get(id) ?? []));
    }
    // 每个 region 的所有末端都须直接接入，避免未覆盖的并行工作被提前越过。
    // Merge 不能混入普通祖先、其他控制区域或非末端的冗余激活来源。
    const expected = new Set([...yes.terminalNodeIds, ...no.terminalNodeIds]);
    const actual = parents.get(pair.nodeId) ?? [];
    if (
      !yes.nodeIds.size ||
      !no.nodeIds.size ||
      actual.length !== expected.size ||
      actual.some((source) => !expected.has(source)) ||
      [...expected].some((source) => !actual.includes(source))
    )
      reject('MERGE_BRANCH_COVERAGE_INVALID', pair.nodeId);
    return { ...pair, branchTerminals: { true: yes.terminalNodeIds, false: no.terminalNodeIds } };
  });
}
