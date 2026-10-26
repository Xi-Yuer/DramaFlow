import { z } from 'zod';
import { runtimeValueSchema } from '../../data/runtime-value.js';
import { workflowIdentifierSchema } from '../metadata.js';

// V1 对应 flow.human_review@1；不向 decision 增加传输身份或重复决策字段。
export const humanReviewInputV1Schema = z.object({ content: z.string() }).strict();
export const humanReviewConfigV1Schema = z.object({ instruction: z.string().optional() }).strict();
export const humanReviewDecisionV1Schema = z
  .object({ action: z.enum(['approve', 'reject']), feedback: z.string().optional() })
  .strict();
export const humanReviewOutputV1Schema = z
  .object({
    content: z.string(),
    action: humanReviewDecisionV1Schema.shape.action,
    feedback: z.string(),
  })
  .strict();

// 共享结构保留 RuntimeValue（含 reference）；V1 业务构造仅接受文本并生成 inline string。
// interruptId 属于 LangGraph 外层身份，运行 / thread / NodeRun 身份不进入此 payload。
export const humanReviewInterruptPayloadV1Schema = z
  .object({
    kind: z.literal('human_review'),
    schemaVersion: z.literal(1),
    nodeId: workflowIdentifierSchema,
    content: runtimeValueSchema,
    instruction: z.string().optional(),
  })
  .strict();

export type HumanReviewInputV1 = z.infer<typeof humanReviewInputV1Schema>;
export type HumanReviewConfigV1 = z.infer<typeof humanReviewConfigV1Schema>;
export type HumanReviewDecisionV1 = z.infer<typeof humanReviewDecisionV1Schema>;
export type HumanReviewOutputV1 = z.infer<typeof humanReviewOutputV1Schema>;
export type HumanReviewInterruptPayloadV1 = z.infer<typeof humanReviewInterruptPayloadV1Schema>;
