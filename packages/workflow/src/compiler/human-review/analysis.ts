import type { WorkflowDefinition } from '@dramaflow/contracts';
import { collectNodeDependencies } from '../dependency/dependency.compiler.js';
import type { BranchRegionAnalysis } from '../if/branch-regions.js';

// 只做能力门禁，不负责调度。分支区域仍由现有 If 分析证明。
export function findUnsupportedHumanReviewTopology(
  definition: WorkflowDefinition,
  reviewIds: ReadonlySet<string>,
  regions?: BranchRegionAnalysis,
): string | undefined {
  if (reviewIds.size === 0) return undefined;
  for (const id of reviewIds) if (regions?.memberships.get(id)?.length) return id;
  if (reviewIds.size < 2) return undefined;
  const parents = new Map<string, string[]>();
  for (const dependency of collectNodeDependencies(definition.edges, definition.nodes))
    parents.set(dependency.targetNodeId, dependency.sourceNodeIds);
  const ancestors = (id: string): Set<string> => {
    const seen = new Set<string>();
    const queue = [...(parents.get(id) ?? [])];
    for (let i = 0; i < queue.length; i++) {
      const parent = queue[i]!;
      if (seen.has(parent)) continue;
      seen.add(parent);
      queue.push(...(parents.get(parent) ?? []));
    }
    return seen;
  };
  const reviews = [...reviewIds].map((id) => ({ id, ancestors: ancestors(id) }));
  for (let i = 0; i < reviews.length; i++)
    for (const other of reviews.slice(i + 1)) {
      const review = reviews[i]!;
      if (!review.ancestors.has(other.id) && !other.ancestors.has(review.id)) return other.id;
    }
  return undefined;
}
