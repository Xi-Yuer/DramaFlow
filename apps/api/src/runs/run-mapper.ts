import {
  jsonObjectSchema,
  type HumanTask,
  type JsonObject,
  type NodeResult,
  type RunEvent,
  type RunEventType,
  type WorkflowRun,
} from '@dramaflow/contracts';
import type { Prisma } from '@dramaflow/database';

export type RunRow = Prisma.RunGetPayload<{ include: { attempts: true } }>;
export function mapRun(row: RunRow): WorkflowRun {
  const results: Record<string, NodeResult> = {};
  for (const attempt of row.attempts)
    if (attempt.output)
      results[attempt.nodeId] = attempt.output as unknown as NodeResult;
  return {
    id: row.id,
    workflowId: row.workflowId,
    workflowVersionId: row.versionId,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    parentRunId: row.parentRunId,
    input: jsonObjectSchema.parse(row.inputs),
    nodeResults: results,
    outputCollections: (row.output ?? {}) as Record<string, JsonObject>,
    error: row.error as WorkflowRun['error'],
    invalidatedNodeIds: row.invalidatedNodeIds as string[],
  };
}
export function mapEvent(
  row: Prisma.RunEventGetPayload<Record<string, never>>,
): RunEvent {
  return {
    id: row.id.toString(),
    runId: row.runId,
    sequence: Number(row.id),
    type: row.type as RunEventType,
    ...(row.nodeId ? { nodeId: row.nodeId } : {}),
    data: jsonObjectSchema.parse(row.data),
    createdAt: row.createdAt.toISOString(),
  };
}
export function mapTask(
  row: Prisma.HumanTaskGetPayload<{ include: { run: true } }>,
): HumanTask {
  const response = row.response ? jsonObjectSchema.parse(row.response) : null;
  const status =
    row.run.status === 'canceled'
      ? 'canceled'
      : response
        ? response.decision === 'reject'
          ? 'rejected'
          : 'approved'
        : 'pending';
  return {
    id: row.id,
    runId: row.runId,
    nodeId: row.nodeId,
    interruptId: row.interruptId,
    status,
    input: jsonObjectSchema.parse(row.payload),
    response,
    createdAt: row.createdAt.toISOString(),
  };
}
