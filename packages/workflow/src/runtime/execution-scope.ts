import { createHash } from 'node:crypto';
import {
  executionScopeKeySchema,
  workflowIdentifierSchema,
  workflowPortNameSchema,
} from '@dramaflow/contracts';
import { z } from 'zod';

// 内部调用描述，不进入 Workflow Contract。新增 kind 必须同时定义规范编码。
const owner = {
  ownerOccurrenceId: workflowIdentifierSchema,
  slot: workflowPortNameSchema,
};
export const childScopeSegmentSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...owner,
      kind: z.literal('iteration_item'),
      ownerNodeRunId: workflowIdentifierSchema.optional(),
      index: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    })
    .strict(),
  z
    .object({ ...owner, kind: z.literal('subworkflow_call'), callKey: workflowIdentifierSchema })
    .strict(),
]);
export type ChildScopeSegment = z.infer<typeof childScopeSegmentSchema>;

export function deriveChildScope(parentScope: string, input: ChildScopeSegment): string {
  const parent = executionScopeKeySchema.parse(parentScope);
  const segment = childScopeSegmentSchema.parse(input);
  const identity = segment.kind === 'iteration_item' ? segment.index : segment.callKey;
  const canonical = JSON.stringify([
    'scope-v1',
    parent,
    segment.kind,
    segment.ownerOccurrenceId,
    segment.slot,
    identity,
    ...(segment.kind === 'iteration_item' && segment.ownerNodeRunId
      ? [segment.ownerNodeRunId]
      : []),
  ]);
  return `scope:v1:${createHash('sha256').update(canonical).digest('hex')}`;
}

// 定位不可变定义中的图，与运行调用身份无关；这里只校验定位，不解析版本。
export const graphDefinitionLocationSchema = z
  .object({
    workflowVersionId: workflowIdentifierSchema,
    path: z.array(
      z.object({ nodeId: workflowIdentifierSchema, graphKey: workflowPortNameSchema }).strict(),
    ),
  })
  .strict();
export type GraphDefinitionLocation = z.infer<typeof graphDefinitionLocationSchema>;
