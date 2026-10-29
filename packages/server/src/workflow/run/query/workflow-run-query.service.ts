import {
  nodeRunSchema,
  workflowRunHistoryQuerySchema,
  workflowRunHistoryResponseSchema,
  encodeWorkflowRunCursor,
  decodeWorkflowRunCursor,
  workflowInvocationKeySchema,
  workflowIdentifierSchema,
  workflowRunResponseSchema,
  type NodeRun,
  type WorkflowRunResponse,
} from '@dramaflow/contracts';
import { Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { DatabaseService } from '../../../database/database.service.js';
import { cancellationProjection } from '../cancellation/current-execution.js';

const workflowNodeRunsResponseSchema = z.object({ items: z.array(nodeRunSchema) }).strict();

// 已授权运行的只读投影。不创建运行、不写 Outbox、不入队。
@Injectable()
export class WorkflowRunQueryService {
  constructor(private readonly database: DatabaseService) {}

  async listRuns(ownerId: string, rawProjectId: string, rawWorkflowId: string, query: unknown) {
    const projectId = z.uuid().parse(rawProjectId);
    const workflowId = workflowIdentifierSchema.parse(rawWorkflowId);
    const { cursor: token } = workflowRunHistoryQuerySchema.parse(query);
    const cursor = token ? decodeWorkflowRunCursor(token) : undefined;
    const workflow = await this.database.client.workflow.findFirst({
      where: { id: workflowId, projectId, project: { ownerId } },
      select: { id: true },
    });
    if (!workflow) throw new NotFoundException('工作流不存在或无权访问');
    const rows = await this.database.client.workflowRun.findMany({
      where: {
        workflowId,
        projectId,
        project: { ownerId },
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: new Date(cursor.createdAt) } },
                { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 21,
      select: {
        id: true,
        workflowId: true,
        workflowVersionId: true,
        status: true,
        createdAt: true,
        startedAt: true,
        completedAt: true,
        error: true,
        cancellationRequestedAt: true,
        waitingRevision: true,
        executions: { select: { kind: true, waitingRevision: true, status: true } },
      },
    });
    const page = rows.slice(0, 20);
    const versions = page.length
      ? await this.database.client.workflowVersion.findMany({
          where: {
            id: { in: [...new Set(page.map((row) => row.workflowVersionId))] },
            workflowId,
            workflow: { projectId, project: { ownerId } },
          },
          select: { id: true, version: true },
        })
      : [];
    const versionNumbers = new Map(versions.map((version) => [version.id, version.version]));
    const last = page.at(-1);
    return workflowRunHistoryResponseSchema.parse({
      items: page.map((row) => ({
        id: row.id,
        workflowId: row.workflowId,
        workflowVersionId: row.workflowVersionId,
        version: versionNumbers.get(row.workflowVersionId) ?? null,
        status: row.status,
        cancellation: cancellationProjection(row),
        createdAt: row.createdAt.toISOString(),
        ...(row.startedAt ? { startedAt: row.startedAt.toISOString() } : {}),
        ...(row.completedAt ? { completedAt: row.completedAt.toISOString() } : {}),
        ...(row.error !== null ? { error: row.error } : {}),
      })),
      nextCursor:
        rows.length > 20 && last
          ? encodeWorkflowRunCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
          : null,
    });
  }

  async getRun(ownerId: string, runId: string): Promise<WorkflowRunResponse> {
    const run = await this.authorizedRun(ownerId, runId);
    return workflowRunResponseSchema.parse({
      id: run.id,
      workflowId: run.workflowId,
      workflowVersionId: run.workflowVersionId,
      invocationKey: run.invocationKey,
      status: run.status,
      cancellation: cancellationProjection(run),
      inputs: run.inputs,
      createdAt: run.createdAt.toISOString(),
      ...(run.outputs !== null ? { outputs: run.outputs } : {}),
      ...(run.error !== null ? { error: run.error } : {}),
      ...(run.startedAt !== null ? { startedAt: run.startedAt.toISOString() } : {}),
      ...(run.cancellationRequestedAt != null
        ? { cancellationRequestedAt: run.cancellationRequestedAt.toISOString() }
        : {}),
      ...(run.completedAt !== null ? { completedAt: run.completedAt.toISOString() } : {}),
    });
  }

  async listNodeRuns(ownerId: string, runId: string): Promise<{ items: NodeRun[] }> {
    const run = await this.authorizedRun(ownerId, runId);
    const rows = await this.database.client.nodeRun.findMany({
      where: {
        workflowRunId: run.id,
        projectId: run.projectId,
        project: { ownerId },
      },
      orderBy: [{ startedAt: 'asc' }, { attempt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        workflowRunId: true,
        nodeId: true,
        occurrenceId: true,
        childExecutionId: true,
        occurrence: { select: { scopeKey: true } },
        attempt: true,
        status: true,
        inputs: true,
        outputs: true,
        error: true,
        startedAt: true,
        completedAt: true,
      },
    });
    return workflowNodeRunsResponseSchema.parse({
      items: rows.map((row) => ({
        id: row.id,
        workflowRunId: row.workflowRunId,
        nodeId: row.nodeId,
        occurrenceId: row.occurrenceId,
        scopeKey: row.occurrence.scopeKey,
        ...(row.childExecutionId ? { childExecutionId: row.childExecutionId } : {}),
        attempt: row.attempt,
        status: row.status,
        ...(row.inputs !== null ? { inputs: row.inputs } : {}),
        ...(row.outputs !== null ? { outputs: row.outputs } : {}),
        ...(row.error !== null ? { error: row.error } : {}),
        startedAt: row.startedAt.toISOString(),
        ...(row.completedAt !== null ? { completedAt: row.completedAt.toISOString() } : {}),
      })),
    });
  }

  async findInvocationRunId(
    ownerId: string,
    rawWorkflowId: string,
    rawKey: string,
  ): Promise<string | null> {
    const workflowId = workflowIdentifierSchema.parse(rawWorkflowId);
    const invocationKey = workflowInvocationKeySchema.parse(rawKey);
    const workflow = await this.database.client.workflow.findFirst({
      where: { id: workflowId, project: { ownerId } },
      select: { projectId: true },
    });
    if (!workflow) throw new NotFoundException('工作流不存在或无权访问');
    const run = await this.database.client.workflowRun.findFirst({
      where: {
        workflowId,
        invocationKey,
        projectId: workflow.projectId,
        project: { ownerId },
      },
      select: { id: true },
    });
    return run?.id ?? null;
  }

  private async authorizedRun(ownerId: string, runId: string) {
    const run = await this.database.client.workflowRun.findFirst({
      where: { id: runId, project: { ownerId } },
      select: {
        id: true,
        projectId: true,
        workflowId: true,
        workflowVersionId: true,
        invocationKey: true,
        status: true,
        inputs: true,
        outputs: true,
        error: true,
        createdAt: true,
        startedAt: true,
        completedAt: true,
        cancellationRequestedAt: true,
        waitingRevision: true,
        executions: { select: { kind: true, waitingRevision: true, status: true } },
      },
    });
    if (!run) throw new NotFoundException('运行不存在或无权访问');
    return run;
  }
}
