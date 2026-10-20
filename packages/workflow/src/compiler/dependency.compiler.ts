import type { WorkflowEdge } from '@dramaflow/contracts';

export interface NodeDependency {
  targetNodeId: string;
  sourceNodeIds: string[];
}

export interface DependencyCompilationContext {
  edges: readonly WorkflowEdge[];
  addEdge(sourceNodeId: string | string[], targetNodeId: string): void;
}

/**
 * 当前 Data / Control Edge 均产生确定性执行依赖，只读取两端 nodeId。
 * 保留原始边及 portKey，输入取值由 BindingResolver / NodeExecutor 负责。
 * If / Switch / Conditional Edge / Send / Batch 的候选分支不适用此规则。
 */
export function collectNodeDependencies(edges: readonly WorkflowEdge[]): NodeDependency[] {
  const sourcesByTarget = new Map<string, Set<string>>();
  for (const edge of edges) {
    const sourceNodeId = edge.source.nodeId;
    const targetNodeId = edge.target.nodeId;
    let sources = sourcesByTarget.get(targetNodeId);
    if (!sources) {
      sources = new Set<string>();
      sourcesByTarget.set(targetNodeId, sources);
    }
    sources.add(sourceNodeId);
  }
  return Array.from(sourcesByTarget, ([targetNodeId, sources]) => ({
    targetNodeId,
    sourceNodeIds: [...sources],
  }));
}

export class DependencyCompiler {
  compile(context: DependencyCompilationContext): void {
    for (const { targetNodeId, sourceNodeIds } of collectNodeDependencies(context.edges)) {
      // collectNodeDependencies 只为实际出现的边创建分组，因此每组至少有一个上游。
      const source = sourceNodeIds.length === 1 ? sourceNodeIds[0]! : sourceNodeIds;
      context.addEdge(source, targetNodeId);
    }
  }
}
