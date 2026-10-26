import type { WorkflowDefinition } from '@dramaflow/contracts';
import { collectNodeDependencies } from './dependency.compiler.js';

export interface StaticDagExecutionAnalysis {
  maxDepth: number;
  recursionLimit: number;
}

/**
 * 静态 DAG 的单次调用预算；调用方须先确认 execution kind 和 interaction 拓扑受支持。
 * 使用联合依赖的拓扑层级，不按节点数计费，暂停不增加完成节点；resume 重入复用 checkpoint，按实际 supersteps 验证边界。
 */
export function analyzeStaticDagExecution(
  definition: WorkflowDefinition,
): StaticDagExecutionAnalysis {
  const levels = new Map(definition.nodes.map((node) => [node.id, 1]));
  const remaining = new Map(definition.nodes.map((node) => [node.id, 0]));
  const downstream = new Map<string, string[]>();
  for (const dependency of collectNodeDependencies(definition.edges, definition.nodes)) {
    if (!remaining.has(dependency.targetNodeId)) throw new Error('静态 DAG 依赖目标不存在');
    remaining.set(dependency.targetNodeId, dependency.sourceNodeIds.length);
    for (const source of dependency.sourceNodeIds) {
      if (!remaining.has(source)) throw new Error('静态 DAG 依赖来源不存在');
      const targets = downstream.get(source) ?? [];
      targets.push(dependency.targetNodeId);
      downstream.set(source, targets);
    }
  }
  const ready = [...remaining].filter(([, count]) => count === 0).map(([id]) => id);
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
  if (ready.length !== definition.nodes.length) throw new Error('静态 DAG 必须无环且节点唯一');
  return { maxDepth, recursionLimit: maxDepth + 1 };
}

export type ActionDagExecutionAnalysis = StaticDagExecutionAnalysis;

// 保留已有 Action 分析入口；两者使用同一联合依赖算法。
export const analyzeActionDagExecution = analyzeStaticDagExecution;
