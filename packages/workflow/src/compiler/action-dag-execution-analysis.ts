import type { WorkflowDefinition } from '@dramaflow/contracts';
import { collectNodeDependencies } from './dependency.compiler.js';

export interface ActionDagExecutionAnalysis {
  maxDepth: number;
  recursionLimit: number;
}

/**
 * 当前 Action DAG 编译策略的首次正常执行预算；调用方须先确认全部节点为 Action。
 * 使用联合依赖的拓扑层级，不按节点数计费，也不定义未来 execution kinds 的语义。
 */
export function analyzeActionDagExecution(
  definition: WorkflowDefinition,
): ActionDagExecutionAnalysis {
  const levels = new Map(definition.nodes.map((node) => [node.id, 1]));
  const remaining = new Map(definition.nodes.map((node) => [node.id, 0]));
  const downstream = new Map<string, string[]>();
  for (const dependency of collectNodeDependencies(definition.edges, definition.nodes)) {
    if (!remaining.has(dependency.targetNodeId)) throw new Error('Action DAG 依赖目标不存在');
    remaining.set(dependency.targetNodeId, dependency.sourceNodeIds.length);
    for (const source of dependency.sourceNodeIds) {
      if (!remaining.has(source)) throw new Error('Action DAG 依赖来源不存在');
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
  if (ready.length !== definition.nodes.length) throw new Error('Action DAG 必须无环且节点唯一');
  return { maxDepth, recursionLimit: maxDepth + 1 };
}
