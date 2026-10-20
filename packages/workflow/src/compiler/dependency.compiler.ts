/**
 * 已由调用方确认的普通确定性执行依赖，不是原始 Data / Control Edge。
 * 条件路由及其候选分支、Send、Batch 不得作为此处的确定性依赖传入。
 * 本层只聚合依赖，不分析节点、端口或分支可达性。
 */
export interface DeterministicDependency {
  sourceNodeId: string;
  targetNodeId: string;
}

export interface NodeDependency {
  targetNodeId: string;
  sourceNodeIds: string[];
}

export interface DependencyCompilationContext {
  dependencies: readonly DeterministicDependency[];
  addEdge(sourceNodeId: string | string[], targetNodeId: string): void;
}

export class DependencyCompiler {
  aggregate(dependencies: readonly DeterministicDependency[]): NodeDependency[] {
    const sourcesByTarget = new Map<string, Set<string>>();
    for (const { sourceNodeId, targetNodeId } of dependencies) {
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

  compile(context: DependencyCompilationContext): void {
    for (const { targetNodeId, sourceNodeIds } of this.aggregate(context.dependencies)) {
      // aggregate 只为实际出现的依赖创建分组，因此每组至少有一个上游。
      const source = sourceNodeIds.length === 1 ? sourceNodeIds[0]! : sourceNodeIds;
      context.addEdge(source, targetNodeId);
    }
  }
}
