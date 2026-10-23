import { z } from 'zod';
import { runtimeValueMapSchema } from '../data/runtime-value.js';
import { workflowIdentifierSchema } from './metadata.js';
import { humanReviewDecisionV1Schema } from './human-review.js';
import { workflowInvocationKeySchema, workflowRunSchema } from './workflow-run.js';

// HTTP 只选择不可变版本；执行身份、状态和 thread 由服务端确定。
export const startWorkflowRunRequestSchema = z
  .object({
    workflowVersionId: workflowIdentifierSchema,
    invocationKey: workflowInvocationKeySchema,
    inputs: runtimeValueMapSchema,
  })
  .strict();

export const resumeWorkflowRunRequestSchema = z
  .object({
    interruptId: z.string().min(1),
    expectedWaitingRevision: z.number().int().positive(),
    value: humanReviewDecisionV1Schema,
  })
  .strict();

export const workflowRunResponseSchema = workflowRunSchema.omit({
  projectId: true,
  threadId: true,
});

export const workflowInvocationLookupResponseSchema = z
  .object({ run: workflowRunResponseSchema.nullable() })
  .strict();

export type StartWorkflowRunRequest = z.infer<typeof startWorkflowRunRequestSchema>;
export type ResumeWorkflowRunRequest = z.infer<typeof resumeWorkflowRunRequestSchema>;
export type WorkflowRunResponse = z.infer<typeof workflowRunResponseSchema>;

// interruptId 是 opaque concurrency token；不携带 thread、task 或 checkpoint 数据。
export const pendingHumanReviewSchema = z
  .object({
    interruptId: z.string().min(1),
    waitingRevision: z.number().int().positive(),
    node: z.object({ id: workflowIdentifierSchema, name: z.string() }).strict(),
    content: z.string(),
    instruction: z.string().optional(),
    submissionStatus: z.enum(['pending', 'submitted']),
  })
  .strict();
export const pendingHumanReviewsResponseSchema = z
  .object({ items: z.array(pendingHumanReviewSchema) })
  .strict();
export type PendingHumanReview = z.infer<typeof pendingHumanReviewSchema>;
export type PendingHumanReviewsResponse = z.infer<typeof pendingHumanReviewsResponseSchema>;
