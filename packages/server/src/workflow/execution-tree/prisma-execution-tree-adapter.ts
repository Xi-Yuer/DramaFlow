import {
  ROOT_EXECUTION_SCOPE_KEY,
  executionTreeEntrySchema,
  type ExecutionTreeEntry,
  type ExecutionTreeParentRef,
} from '@dramaflow/contracts';
import type { Prisma } from '@dramaflow/database';
import {
  ExecutionTreeQueryError,
  type ChildRef,
  type ExecutionTreeSource,
} from './execution-tree-query.js';

const nodeSelect = {
  id: true,
  projectId: true,
  workflowRunId: true,
  nodeId: true,
  occurrenceId: true,
  childExecutionId: true,
  attempt: true,
  status: true,
  error: true,
  startedAt: true,
  completedAt: true,
  occurrence: {
    select: { id: true, projectId: true, workflowRunId: true, nodeId: true, scopeKey: true },
  },
  childExecution: { select: { id: true, projectId: true, workflowRunId: true, scopeKey: true } },
} satisfies Prisma.NodeRunSelect;
const executionSelect = {
  id: true,
  projectId: true,
  workflowRunId: true,
  parentNodeRunId: true,
  parentNodeId: true,
  scopeKey: true,
  index: true,
  kind: true,
  invocationKey: true,
  metadata: true,
  status: true,
  error: true,
  createdAt: true,
  startedAt: true,
  completedAt: true,
  parentNodeRun: { select: { id: true, projectId: true, workflowRunId: true, nodeId: true } },
} satisfies Prisma.ChildExecutionSelect;
type NodeRow = Prisma.NodeRunGetPayload<{ select: typeof nodeSelect }>;
type ExecutionRow = Prisma.ChildExecutionGetPayload<{ select: typeof executionSelect }>;

// 唯一理解当前持久化子类型的查询适配器；不解析 scopeKey，不调用 Compiler / Runtime。
export class PrismaExecutionTreeAdapter implements ExecutionTreeSource {
  constructor(
    private readonly tx: Prisma.TransactionClient,
    private readonly scope: { projectId: string; workflowRunId: string },
  ) {}

  private belongs(row: { projectId: string; workflowRunId: string }) {
    if (row.projectId !== this.scope.projectId || row.workflowRunId !== this.scope.workflowRunId)
      throw new ExecutionTreeQueryError('INCONSISTENT');
  }
  private parse(entry: unknown): ExecutionTreeEntry {
    const parsed = executionTreeEntrySchema.safeParse(entry);
    if (!parsed.success) throw new ExecutionTreeQueryError('INCONSISTENT');
    return parsed.data;
  }
  private node(row: NodeRow): ExecutionTreeEntry {
    this.belongs(row);
    this.belongs(row.occurrence);
    if (row.occurrence.id !== row.occurrenceId || row.occurrence.nodeId !== row.nodeId)
      throw new ExecutionTreeQueryError('INCONSISTENT');
    const item = row.childExecution;
    let parent: ExecutionTreeParentRef;
    if (row.childExecutionId === null) {
      if (item !== null || row.occurrence.scopeKey !== ROOT_EXECUTION_SCOPE_KEY)
        throw new ExecutionTreeQueryError('INCONSISTENT');
      parent = { type: 'workflow_run', id: this.scope.workflowRunId };
    } else {
      if (!item || item.id !== row.childExecutionId || item.scopeKey !== row.occurrence.scopeKey)
        throw new ExecutionTreeQueryError('INCONSISTENT');
      this.belongs(item);
      parent = { type: 'child_execution', id: item.id };
    }
    return this.parse({
      type: 'node_run',
      id: row.id,
      nodeId: row.nodeId,
      occurrenceId: row.occurrenceId,
      parent,
      attempt: row.attempt,
      status: row.status,
      startedAt: row.startedAt.toISOString(),
      ...(row.completedAt ? { completedAt: row.completedAt.toISOString() } : {}),
      ...(row.error !== null ? { error: row.error } : {}),
    });
  }
  private execution(row: ExecutionRow): ExecutionTreeEntry {
    this.belongs(row);
    this.belongs(row.parentNodeRun);
    if (
      row.parentNodeRun.id !== row.parentNodeRunId ||
      row.parentNodeRun.nodeId !== row.parentNodeId ||
      row.scopeKey === ROOT_EXECUTION_SCOPE_KEY ||
      row.scopeKey.length === 0 ||
      (row.kind === 'iteration_item' &&
        (row.index === null ||
          !Number.isSafeInteger(row.index) ||
          row.index < 0 ||
          row.invocationKey !== `iteration-item:${row.index}`))
    )
      throw new ExecutionTreeQueryError('INCONSISTENT');
    if (
      row.kind === 'iteration_item' &&
      (row.metadata === null ||
        typeof row.metadata !== 'object' ||
        Array.isArray(row.metadata) ||
        row.metadata.index !== row.index)
    )
      throw new ExecutionTreeQueryError('INCONSISTENT');
    return this.parse({
      type: 'child_execution',
      id: row.id,
      kind: row.kind,
      parent: { type: 'node_run', id: row.parentNodeRunId },
      metadata: row.metadata,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
      startedAt: row.startedAt.toISOString(),
      ...(row.completedAt ? { completedAt: row.completedAt.toISOString() } : {}),
      ...(row.error !== null ? { error: row.error } : {}),
    });
  }
  async get(ref: ChildRef): Promise<ExecutionTreeEntry | null> {
    const where = { id: ref.id, ...this.scope };
    if (ref.type === 'node_run') {
      const row = await this.tx.nodeRun.findFirst({ where, select: nodeSelect });
      return row ? this.node(row) : null;
    }
    const row = await this.tx.childExecution.findFirst({ where, select: executionSelect });
    return row ? this.execution(row) : null;
  }
  async children(parent: ExecutionTreeParentRef, page: { take: number; afterId?: string }) {
    const pagination = {
      take: page.take,
      ...(page.afterId ? { cursor: { id: page.afterId }, skip: 1 } : {}),
    };
    if (parent.type === 'node_run') {
      const rows = await this.tx.childExecution.findMany({
        where: { ...this.scope, parentNodeRunId: parent.id },
        select: executionSelect,
        orderBy: [{ index: 'asc' }, { id: 'asc' }],
        ...pagination,
      });
      return rows.map((row) => this.execution(row));
    }
    const rows = await this.tx.nodeRun.findMany({
      where: {
        ...this.scope,
        childExecutionId: parent.type === 'workflow_run' ? null : parent.id,
      },
      select: nodeSelect,
      orderBy: [{ startedAt: 'asc' }, { attempt: 'asc' }, { id: 'asc' }],
      ...pagination,
    });
    return rows.map((row) => this.node(row));
  }
}
