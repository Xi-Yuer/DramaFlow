import {
  templateNodeOutputDependencies,
  type NodeDefinition,
  type WorkflowEdge,
} from '@dramaflow/contracts';

export interface NodeDependency {
  targetNodeId: string;
  sourceNodeIds: string[];
}

export interface DependencyCompilationContext {
  edges: readonly WorkflowEdge[];
  nodes?: readonly Pick<NodeDefinition, 'id' | 'inputs'>[];
  // collector 的默认结果每目标一组 ALL；经过能力证明的编译投影可为同一目标
  // 提供多个互斥 completion groups，每条记录独立生成一条原生边 / barrier。
  dependencies?: readonly NodeDependency[];
  addEdge(sourceNodeId: string | string[], targetNodeId: string): void;
}

/**
 * Data / Control Edge 与 template 的 node_output 都产生确定性执行依赖，只读取 nodeId。
 * 先记录边，再追加模板来源，同一节点对去重并保留首次出现顺序。
 * 不读取端口、不构造输入。If / Switch / Conditional Edge / Send / Batch 不适用此规则。
 */
export function collectNodeDependencies(
  edges: readonly WorkflowEdge[],
  nodes: readonly Pick<NodeDefinition, 'id' | 'inputs'>[] = [],
): NodeDependency[] {
  const sourcesByTarget = new Map<string, Set<string>>();
  const addSource = (targetNodeId: string, sourceNodeId: string) => {
    let sources = sourcesByTarget.get(targetNodeId);
    if (!sources) {
      sources = new Set<string>();
      sourcesByTarget.set(targetNodeId, sources);
    }
    sources.add(sourceNodeId);
  };
  for (const edge of edges) addSource(edge.target.nodeId, edge.source.nodeId);
  for (const dependency of templateNodeOutputDependencies(nodes))
    addSource(dependency.targetNodeId, dependency.sourceNodeId);
  return Array.from(sourcesByTarget, ([targetNodeId, sources]) => ({
    targetNodeId,
    sourceNodeIds: [...sources],
  }));
}

export class DependencyCompiler {
  compile(context: DependencyCompilationContext): void {
    for (const { targetNodeId, sourceNodeIds } of context.dependencies ??
      collectNodeDependencies(context.edges, context.nodes ?? [])) {
      // collectNodeDependencies 只为实际出现的依赖创建分组，因此每组至少有一个上游。
      const source = sourceNodeIds.length === 1 ? sourceNodeIds[0]! : sourceNodeIds;
      context.addEdge(source, targetNodeId);
    }
  }
}
