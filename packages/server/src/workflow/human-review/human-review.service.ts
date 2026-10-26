import { randomUUID } from 'node:crypto';
import {
  humanReviewInterruptPayloadV1Schema,
  pendingHumanReviewsResponseSchema,
  resumeWorkflowRunRequestSchema,
  targetedInterruptResumeValueSchema,
  workflowDefinitionSchema,
  workflowExecutionJobSchema,
  workflowIdentifierSchema,
  type ResumeWorkflowExecutionJob,
  type PendingHumanReview,
} from '@dramaflow/contracts';
import { INTERRUPT, ERROR } from '@langchain/langgraph-checkpoint';
import {
  workflowStateSchema,
  WorkflowRunNotWaitingError,
  WorkflowResumeAlreadySubmittedError,
} from '@dramaflow/workflow';
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@dramaflow/database';
import { z } from 'zod';
import { DatabaseService } from '../../database/database.service.js';
import { WorkflowCheckpointerService } from '../../checkpoint/workflow-checkpointer.service.js';

export class HumanReviewStateError extends ConflictException {
  constructor(
    code:
      | 'HUMAN_REVIEW_CAPABILITY_UNSUPPORTED'
      | 'HUMAN_REVIEW_INTERRUPT_INVALID'
      | 'HUMAN_REVIEW_INTERRUPT_UNSUPPORTED'
      | 'HUMAN_REVIEW_STALE',
  ) {
    const messages = {
      HUMAN_REVIEW_CAPABILITY_UNSUPPORTED: '当前仅支持单个待审批的 Human Review',
      HUMAN_REVIEW_INTERRUPT_INVALID: '当前待审批状态不符合 Human Review 协议',
      HUMAN_REVIEW_INTERRUPT_UNSUPPORTED: '当前等待任务不是受支持的 Human Review',
      HUMAN_REVIEW_STALE: '待审批状态已变化，请重新查询',
    };
    super({ code, message: messages[code] });
  }
}

@Injectable()
export class WorkflowHumanReviewService {
  constructor(
    private readonly database: DatabaseService,
    private readonly checkpoints: WorkflowCheckpointerService,
  ) {}

  // Run 行锁覆盖 checkpoint 读取 / intent 查询，避免跨 waiting 周期拼装产品对象。
  private async locked<T>(
    ownerId: string,
    rawId: string,
    read: (
      tx: Prisma.TransactionClient,
      run: Prisma.WorkflowRunGetPayload<Record<string, never>>,
    ) => Promise<T>,
  ): Promise<T> {
    const runId = workflowIdentifierSchema.parse(rawId);
    return this.database.client.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT r."id" FROM "workflow_run" r JOIN "canvas_project" p ON p."id" = r."projectId" WHERE r."id" = ${runId} AND p."ownerId" = ${ownerId} FOR UPDATE OF r`;
        const run = await tx.workflowRun.findFirst({ where: { id: runId, project: { ownerId } } });
        if (!run) throw new NotFoundException('运行不存在或无权访问');
        return read(tx, run);
      },
      { timeout: 15000 },
    );
  }

  private async current(
    tx: Prisma.TransactionClient,
    run: Prisma.WorkflowRunGetPayload<Record<string, never>>,
    ownerId: string,
  ): Promise<Omit<PendingHumanReview, 'submissionStatus'>> {
    const version = await tx.workflowVersion.findFirst({
      where: {
        id: run.workflowVersionId,
        workflowId: run.workflowId,
        workflow: { projectId: run.projectId, project: { ownerId } },
      },
      select: { definition: true },
    });
    if (!version) throw new HumanReviewStateError('HUMAN_REVIEW_INTERRUPT_INVALID');
    // 通过官方 Saver 读取 head tuple；不编译 / invoke Graph，不自行读取 checkpoint SQL 表。
    const tuple = await this.checkpoints.saver.getTuple({
      configurable: { thread_id: run.threadId, checkpoint_ns: '' },
    });
    const identity = workflowStateSchema.shape.run.safeParse(tuple?.checkpoint.channel_values.run);
    if (
      !tuple ||
      !identity.success ||
      tuple.config.configurable?.thread_id !== run.threadId ||
      (tuple.config.configurable?.checkpoint_ns ?? '') !== '' ||
      tuple.pendingWrites?.some(([, channel]) => channel === ERROR) ||
      identity.data.workflowRunId !== run.id ||
      identity.data.workflowVersionId !== run.workflowVersionId ||
      identity.data.projectId !== run.projectId ||
      identity.data.workflowId !== run.workflowId
    )
      throw new HumanReviewStateError('HUMAN_REVIEW_INTERRUPT_INVALID');
    // INTERRUPT 是 LangGraph 的导出常量；pending writes / task identity 只在此适配层消费。
    const native: { id: string; value: unknown }[] = [];
    for (const [, channel, value] of tuple.pendingWrites ?? [])
      if (channel === INTERRUPT) {
        // LangGraph 1.5.0 每个 INTERRUPT pending write 保存一个 Interrupt 对象。
        const parsed = z
          .object({ id: z.string().min(1), value: z.unknown() })
          .passthrough()
          .safeParse(value);
        if (!parsed.success) throw new HumanReviewStateError('HUMAN_REVIEW_INTERRUPT_INVALID');
        native.push(parsed.data);
      }
    if (native.length > 1) throw new HumanReviewStateError('HUMAN_REVIEW_CAPABILITY_UNSUPPORTED');
    const interrupt = native[0];
    if (!interrupt) throw new HumanReviewStateError('HUMAN_REVIEW_INTERRUPT_INVALID');
    const kind = z.object({ kind: z.literal('human_review') }).safeParse(interrupt.value);
    if (!kind.success) throw new HumanReviewStateError('HUMAN_REVIEW_INTERRUPT_UNSUPPORTED');
    const payload = humanReviewInterruptPayloadV1Schema.safeParse(interrupt.value);
    if (
      !payload.success ||
      payload.data.content.storage !== 'inline' ||
      typeof payload.data.content.value !== 'string' ||
      payload.data.content.type.kind !== 'primitive' ||
      payload.data.content.type.name !== 'string'
    )
      throw new HumanReviewStateError('HUMAN_REVIEW_INTERRUPT_INVALID');
    const definition = workflowDefinitionSchema.safeParse(version.definition);
    const node =
      definition.success && definition.data.nodes.find((node) => node.id === payload.data.nodeId);
    if (!node || node.type !== 'flow.human_review' || node.typeVersion !== 1)
      throw new HumanReviewStateError('HUMAN_REVIEW_INTERRUPT_INVALID');
    return {
      interruptId: interrupt.id,
      waitingRevision: run.waitingRevision,
      node: { id: node.id, name: node.name },
      content: payload.data.content.value,
      ...(payload.data.instruction !== undefined ? { instruction: payload.data.instruction } : {}),
    };
  }

  async pending(ownerId: string, runId: string) {
    return this.locked(ownerId, runId, async (tx, run) => {
      if (run.status !== 'waiting') return pendingHumanReviewsResponseSchema.parse({ items: [] });
      const review = await this.current(tx, run, ownerId);
      const intent = await tx.workflowExecutionOutbox.findUnique({
        where: {
          workflowRunId_kind_waitingRevision: {
            workflowRunId: run.id,
            kind: 'resume',
            waitingRevision: run.waitingRevision,
          },
        },
        select: { id: true },
      });
      // 已持久化的意图不能覆盖，包括投递失败 / recovery_required；客户端不能盲目重试。
      return pendingHumanReviewsResponseSchema.parse({
        items: [{ ...review, submissionStatus: intent ? 'submitted' : 'pending' }],
      });
    });
  }

  async submit(
    ownerId: string,
    runId: string,
    input: unknown,
  ): Promise<ResumeWorkflowExecutionJob> {
    const request = resumeWorkflowRunRequestSchema.parse(input);
    return this.locked(ownerId, runId, async (tx, run) => {
      if (run.status !== 'waiting') throw new WorkflowRunNotWaitingError(run.id);
      if (run.waitingRevision !== request.expectedWaitingRevision)
        throw new HumanReviewStateError('HUMAN_REVIEW_STALE');
      const current = await this.current(tx, run, ownerId);
      if (current.interruptId !== request.interruptId)
        throw new HumanReviewStateError('HUMAN_REVIEW_STALE');
      const existing = await tx.workflowExecutionOutbox.findUnique({
        where: {
          workflowRunId_kind_waitingRevision: {
            workflowRunId: run.id,
            kind: 'resume',
            waitingRevision: run.waitingRevision,
          },
        },
        select: { id: true },
      });
      if (existing) throw new WorkflowResumeAlreadySubmittedError();
      const executionId = randomUUID();
      const value = targetedInterruptResumeValueSchema.parse({
        kind: 'targeted_interrupt',
        interruptId: current.interruptId,
        value: request.value,
      });
      const job: ResumeWorkflowExecutionJob = {
        kind: 'resume',
        workflowRunId: run.id,
        executionId,
        value,
      };
      await tx.workflowExecutionOutbox.create({
        data: {
          id: executionId,
          kind: 'resume',
          workflowRunId: run.id,
          waitingRevision: run.waitingRevision,
          payload: z.record(z.string(), z.json()).parse(workflowExecutionJobSchema.parse(job)),
        },
      });
      return job;
    });
  }
}
