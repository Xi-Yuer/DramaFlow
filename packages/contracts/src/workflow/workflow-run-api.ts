import { z } from 'zod';
import { runtimeValueMapSchema } from '../data/runtime-value.js';
import { workflowIdentifierSchema } from './metadata.js';
import { workflowRunSchema } from './workflow-run.js';

// HTTP 只选择不可变版本；执行身份、状态和 thread 由服务端确定。
export const startWorkflowRunRequestSchema = z
  .object({ workflowVersionId: workflowIdentifierSchema, inputs: runtimeValueMapSchema })
  .strict();

export const resumeWorkflowRunRequestSchema = z
  .object({ value: z.unknown().refine((value) => value !== undefined, '必须提供恢复值') })
  .strict();

export const workflowRunResponseSchema = workflowRunSchema.omit({
  projectId: true,
  threadId: true,
});

export type StartWorkflowRunRequest = z.infer<typeof startWorkflowRunRequestSchema>;
export type ResumeWorkflowRunRequest = z.infer<typeof resumeWorkflowRunRequestSchema>;
export type WorkflowRunResponse = z.infer<typeof workflowRunResponseSchema>;
