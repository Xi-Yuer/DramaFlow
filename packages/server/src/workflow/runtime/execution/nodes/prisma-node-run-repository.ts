import {
  nodeRunErrorSchema,
  nodeRunSchema,
  runtimeValueMapSchema,
  workflowDefinitionSchema,
  workflowIdentifierSchema,
  type NodeRun,
  type NodeRunError,
  type RuntimeValue,
} from '@dramaflow/contracts';
import { Prisma } from '@dramaflow/database';
import type {
  CreateNodeRunInput,
  GetNodeOccurrenceInput,
  HumanReviewNodeRunRepository,
  IterationRunRepository,
  CreateChildExecutionInput,
  CreateIterationItemRunInput,
} from '@dramaflow/workflow';
import { z } from 'zod';
import type { DatabaseService } from '../../../../database/database.service.js';
import { ChildExecutionRepository } from '../children/child-execution-repository.js';
import { assertChanged, runningNodeRun, type RepositoryScope } from '../repository-scope.js';
import { NodeOccurrenceRepository } from './node-occurrence-repository.js';

function snapshot(values: Record<string, RuntimeValue>): Prisma.InputJsonObject {
  return z.record(z.string(), z.json()).parse(runtimeValueMapSchema.parse(values));
}

// 只由授权工厂创建，NodeRun 与子执行共用同一个已验证的作用域。
export class PrismaNodeRunRepository
  implements HumanReviewNodeRunRepository, IterationRunRepository
{
  private readonly occurrences: NodeOccurrenceRepository;
  private readonly children: ChildExecutionRepository;

  constructor(
    private readonly db: DatabaseService,
    private readonly scope: RepositoryScope,
  ) {
    this.occurrences = new NodeOccurrenceRepository(db, scope);
    this.children = new ChildExecutionRepository(db, scope);
  }

  getOrCreateOccurrence(input: GetNodeOccurrenceInput) {
    return this.occurrences.getOrCreateOccurrence(input);
  }

  getOrCreateIterationItemRunning(input: CreateIterationItemRunInput) {
    return this.children.getOrCreateIterationItemRunning(input);
  }

  getOrCreateChildExecutionRunning(input: CreateChildExecutionInput) {
    return this.children.getOrCreateChildExecutionRunning(input);
  }

  getChildExecutionById(id: string) {
    return this.children.getChildExecutionById(id);
  }

  markChildExecutionCompleted(id: string) {
    return this.children.markChildExecutionCompleted(id);
  }

  markIterationItemCompleted(id: string) {
    return this.children.markIterationItemCompleted(id);
  }

  markChildExecutionFailed(id: string, error: NodeRunError) {
    return this.children.markChildExecutionFailed(id, error);
  }

  markIterationItemFailed(id: string, error: NodeRunError) {
    return this.children.markIterationItemFailed(id, error);
  }

  markChildExecutionAndParentFailed(id: string, error: NodeRunError) {
    return this.children.markChildExecutionAndParentFailed(id, error);
  }

  async createRunning(input: CreateNodeRunInput): Promise<NodeRun> {
    const { projectId, workflowRunId } = this.scope;
    return this.db.client.$transaction(
      async (tx) => {
        const { occurrence } = await this.occurrences.lockOccurrence(tx, input);
        // 仅在这一 occurrence 内分配；行锁随事务释放，不增加业务重试策略。
        const previous = await tx.nodeRun.aggregate({
          where: { occurrenceId: occurrence.id },
          _max: { attempt: true },
        });
        const row = await tx.nodeRun.create({
          data: {
            projectId,
            workflowRunId,
            nodeId: occurrence.nodeId,
            occurrenceId: occurrence.id,
            childExecutionId: input.childExecutionId,
            attempt: (previous._max.attempt ?? 0) + 1,
          },
        });
        return nodeRunSchema.parse({
          id: row.id,
          workflowRunId: row.workflowRunId,
          nodeId: row.nodeId,
          occurrenceId: occurrence.id,
          scopeKey: occurrence.scopeKey,
          ...(row.childExecutionId ? { childExecutionId: row.childExecutionId } : {}),
          attempt: row.attempt,
          status: row.status,
          startedAt: row.startedAt.toISOString(),
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  }

  async getOrCreateHumanReviewRunning(
    input: CreateNodeRunInput & { readonly workflowVersionId: string },
  ): Promise<NodeRun> {
    const { projectId, workflowRunId, ownerId } = this.scope;
    const nodeId = workflowIdentifierSchema.parse(input.nodeId);
    const workflowVersionId = workflowIdentifierSchema.parse(input.workflowVersionId);
    return this.db.client.$transaction(
      async (tx) => {
        // 与 Action attempt 分配锁同一 occurrence；重入不能换成其他 item 的记录。
        const { run, occurrence } = await this.occurrences.lockOccurrence(tx, input);
        if (run.status !== 'running' || run.workflowVersionId !== workflowVersionId)
          throw new Error('Human Review 必须属于当前已 claim 的固定版本运行');
        const version = await tx.workflowVersion.findFirst({
          where: {
            id: workflowVersionId,
            workflowId: run.workflowId,
            workflow: { projectId, project: { ownerId } },
          },
          select: { definition: true },
        });
        const node =
          version &&
          workflowDefinitionSchema
            .parse(version.definition)
            .nodes.find((node) => node.id === nodeId);
        if (!node || node.type !== 'flow.human_review' || node.typeVersion !== 1)
          throw new Error('固定运行版本中的节点不是 flow.human_review@1');
        // 当前仍由 Compiler gate 串行审核；审计复用只依赖明确 occurrence。
        // 不按 latest running 猜身份；任何终态或多 attempt 的旧记录均拒绝复用。
        const existing = await tx.nodeRun.findMany({
          where: { projectId, workflowRunId, occurrenceId: occurrence.id },
          take: 2,
        });
        const previous = existing[0];
        if (
          previous &&
          (existing.length !== 1 || previous.attempt !== 1 || previous.status !== 'running')
        )
          throw new Error('Human Review 已结束或存在不支持的 attempt 历史');
        const row =
          previous ??
          (await tx.nodeRun.create({
            data: {
              projectId,
              workflowRunId,
              nodeId,
              occurrenceId: occurrence.id,
              childExecutionId: input.childExecutionId,
              attempt: 1,
            },
          }));
        return nodeRunSchema.parse({
          id: row.id,
          workflowRunId: row.workflowRunId,
          nodeId: row.nodeId,
          occurrenceId: occurrence.id,
          scopeKey: occurrence.scopeKey,
          ...(row.childExecutionId ? { childExecutionId: row.childExecutionId } : {}),
          attempt: row.attempt,
          status: row.status,
          startedAt: row.startedAt.toISOString(),
          ...(row.inputs !== null ? { inputs: row.inputs } : {}),
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  }

  async updateInputs(nodeRunId: string, inputs: Record<string, RuntimeValue>): Promise<void> {
    const changed = await this.db.client.nodeRun.updateMany({
      where: { ...runningNodeRun(this.scope, nodeRunId), inputs: { equals: Prisma.DbNull } },
      data: { inputs: snapshot(inputs) },
    });
    assertChanged(changed.count);
  }

  async markCompleted(nodeRunId: string, outputs: Record<string, RuntimeValue>): Promise<void> {
    const changed = await this.db.client.nodeRun.updateMany({
      where: { ...runningNodeRun(this.scope, nodeRunId), inputs: { not: Prisma.DbNull } },
      data: {
        outputs: snapshot(outputs),
        status: 'completed',
        completedAt: new Date(),
      },
    });
    assertChanged(changed.count);
  }

  async markFailed(nodeRunId: string, error: NodeRunError): Promise<void> {
    const changed = await this.db.client.nodeRun.updateMany({
      where: runningNodeRun(this.scope, nodeRunId),
      data: {
        error: nodeRunErrorSchema.parse(error),
        status: 'failed',
        completedAt: new Date(),
      },
    });
    assertChanged(changed.count);
  }
}
