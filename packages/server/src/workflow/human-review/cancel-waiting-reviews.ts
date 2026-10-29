import {
  nestedGraphSlots,
  workflowDefinitionSchema,
  type GraphDefinition,
} from '@dramaflow/contracts';
import type { Prisma } from '@dramaflow/database';

interface WaitingRun {
  id: string;
  projectId: string;
  workflowId: string;
  workflowVersionId: string;
}

interface ExecutionGraph {
  graph: GraphDefinition;
  nodes: readonly string[];
  children: readonly string[];
}

// 调用方须持有已授权 Run 行锁，并已确认 waiting 或 invocation 已取消退出。
// resume 在 Review 重新登记 owner 前即 abort 时，也需结束上一次 waiting 留下的审计。
export async function cancelWaitingReviews(
  tx: Prisma.TransactionClient,
  run: WaitingRun,
  completedAt: Date,
): Promise<void> {
  const scope = { workflowRunId: run.id, projectId: run.projectId };
  const running = await tx.nodeRun.findMany({
    where: { ...scope, status: 'running' },
    select: { id: true, nodeId: true, childExecutionId: true },
  });
  if (!running.length) return;
  const version = await tx.workflowVersion.findFirstOrThrow({
    where: {
      id: run.workflowVersionId,
      workflowId: run.workflowId,
      workflow: { projectId: run.projectId },
    },
    select: { definition: true },
  });
  const root = workflowDefinitionSchema.parse(version.definition);
  const graphs = new Map<string, ExecutionGraph>();
  const visiting = new Set<string>();
  async function executionGraph(childId: string | null): Promise<ExecutionGraph> {
    if (childId === null) return { graph: root, nodes: [], children: [] };
    const cached = graphs.get(childId);
    if (cached) return cached;
    if (visiting.has(childId)) throw new Error('等待审核的执行父链存在循环');
    visiting.add(childId);
    const child = await tx.childExecution.findFirstOrThrow({
      where: { ...scope, id: childId },
      select: { parentNodeRunId: true },
    });
    const owner = await tx.nodeRun.findFirstOrThrow({
      where: { ...scope, id: child.parentNodeRunId },
      select: { id: true, nodeId: true, childExecutionId: true },
    });
    const parent = await executionGraph(owner.childExecutionId);
    const definition = parent.graph.nodes.find((node) => node.id === owner.nodeId);
    const slots = definition ? nestedGraphSlots(definition) : [];
    // 当前 Composite 只有一个 slot；未来 multi-slot 必须有明确关联，不能猜测。
    if (slots.length !== 1) throw new Error('等待审核的所属 Definition Graph 无法唯一确定');
    const value = {
      graph: slots[0]!.graph,
      nodes: [...parent.nodes, owner.id],
      children: [...parent.children, childId],
    };
    graphs.set(childId, value);
    visiting.delete(childId);
    return value;
  }

  const nodes = new Set<string>();
  const children = new Set<string>();
  for (const audit of running) {
    const location = await executionGraph(audit.childExecutionId);
    const definition = location.graph.nodes.find((node) => node.id === audit.nodeId);
    if (definition?.type !== 'flow.human_review' || definition.typeVersion !== 1) continue;
    nodes.add(audit.id);
    for (const id of location.nodes) nodes.add(id);
    for (const id of location.children) children.add(id);
  }
  // 不生成 decision / feedback，不结束 sibling；终态事实由条件更新与 DB 约束保护。
  if (nodes.size)
    await tx.nodeRun.updateMany({
      where: { ...scope, id: { in: [...nodes] }, status: 'running' },
      data: { status: 'cancelled', completedAt },
    });
  if (children.size)
    await tx.childExecution.updateMany({
      where: { ...scope, id: { in: [...children] }, status: 'running' },
      data: { status: 'cancelled', completedAt },
    });
}
