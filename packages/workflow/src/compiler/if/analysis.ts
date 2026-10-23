import type { WorkflowDefinition } from '@dramaflow/contracts';
import { collectNodeDependencies, type NodeDependency } from '../dependency.compiler.js';

export class SimpleIfCapabilityError extends Error {
  constructor(
    readonly code: 'IF_TOPOLOGY_UNSUPPORTED' | 'CONDITIONAL_WORKFLOW_OUTPUT_UNSUPPORTED',
    readonly nodeId: string,
  ) {
    super('当前 Compiler 只支持分支互不重叠、指向终端 Action 且输入已就绪的简单 If');
    this.name = 'SimpleIfCapabilityError';
  }
}
export interface SimpleIfRoute {
  nodeId: string;
  true: string;
  false: string;
}
export interface SimpleIfExecutionAnalysis {
  routes: SimpleIfRoute[];
  staticDependencies: NodeDependency[];
  roots: string[];
  leaves: string[];
  maxDepth: number;
  recursionLimit: number;
}

// 仅适用于已通过 Definition / Manifest 静态校验的 Action + flow.if@1 图。
// 这是当前 Compiler 的能力边界，不是永久 Workflow Contract 或自定义调度器。
export function analyzeSimpleIfExecution(
  definition: WorkflowDefinition,
  ifNodeIds: ReadonlySet<string>,
): SimpleIfExecutionAnalysis {
  const reject = (nodeId: string): never => {
    throw new SimpleIfCapabilityError('IF_TOPOLOGY_UNSUPPORTED', nodeId);
  };
  const branchOwners = new Map<string, string>();
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
    for (const target of [route.true, route.false]) {
      if (ifNodeIds.has(target) || branchOwners.has(target)) reject(target);
      branchOwners.set(target, nodeId);
    }
    routes.push(route);
  }
  const allDependencies = collectNodeDependencies(definition.edges, definition.nodes);
  // 分支只允许终端 Action：任何后继、互斥汇合、跨支依赖或 nested 均保守拒绝。
  for (const dependency of allDependencies) {
    for (const source of dependency.sourceNodeIds) if (branchOwners.has(source)) reject(source);
  }
  const ordinaryEdges = definition.edges.filter((edge) => !ifNodeIds.has(edge.source.nodeId));
  const ordinaryDependencies = collectNodeDependencies(ordinaryEdges, definition.nodes);
  const parents = new Map(
    ordinaryDependencies.map((dependency) => [dependency.targetNodeId, dependency.sourceNodeIds]),
  );
  for (const [target, owner] of branchOwners) {
    const ancestors = new Set<string>();
    const pending = [...(parents.get(owner) ?? [])];
    for (let index = 0; index < pending.length; index++) {
      const source = pending[index]!;
      if (ancestors.has(source)) continue;
      ancestors.add(source);
      pending.push(...(parents.get(source) ?? []));
    }
    // 路由激活时，Binding 的每一个静态来源都必须已由 If 的 ALL 前置完成。
    for (const source of parents.get(target) ?? []) if (!ancestors.has(source)) reject(target);
  }
  for (const output of definition.outputs) {
    if (branchOwners.has(output.source.nodeId))
      throw new SimpleIfCapabilityError(
        'CONDITIONAL_WORKFLOW_OUTPUT_UNSUPPORTED',
        output.source.nodeId,
      );
  }
  // 只移除分支节点的触发依赖；原始 edges / template 仍完整保留给 BindingResolver。
  const staticDependencies = ordinaryDependencies.filter(
    (dependency) => !branchOwners.has(dependency.targetNodeId),
  );
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
    routes,
    staticDependencies,
    roots,
    leaves: definition.nodes.filter((node) => !downstream.has(node.id)).map((node) => node.id),
    maxDepth,
    recursionLimit: maxDepth + 1,
  };
}
