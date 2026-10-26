import {
  nodeRunSchema,
  workflowInvocationKeySchema,
  workflowIdentifierSchema,
  workflowRunResponseSchema,
  type NodeRun,
  type WorkflowRunResponse,
} from '@dramaflow/contracts';
import { Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { DatabaseService } from '../../database/database.service.js';

const workflowNodeRunsResponseSchema = z.object({ items: z.array(nodeRunSchema) }).strict();

// 已授权运行的只读投影。不创建运行、不写 Outbox、不入队。
@Injectable()
export class WorkflowRunQueryService {
  constructor(private readonly database: DatabaseService) {}

  async getRun(ownerId: string, runId: string): Promise<WorkflowRunResponse> {
    const run = await this.authorizedRun(ownerId, runId);
    return workflowRunResponseSchema.parse({
      id: run.id,
      workflowId: run.workflowId,
      workflowVersionId: run.workflowVersionId,
      invocationKey: run.invocationKey,
      status: run.status,
      inputs: run.inputs,
      createdAt: run.createdAt.toISOString(),
      ...(run.outputs !== null ? { outputs: run.outputs } : {}),
      ...(run.error !== null ? { error: run.error } : {}),
      ...(run.startedAt !== null ? { startedAt: run.startedAt.toISOString() } : {}),
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
        iterationItemRunId: true,
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
        ...(row.iterationItemRunId ? { iterationItemRunId: row.iterationItemRunId } : {}),
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
      },
    });
    if (!run) throw new NotFoundException('运行不存在或无权访问');
    return run;
  }
}
