import { z } from 'zod';
import { workflowIdentifierSchema } from '../metadata.js';

// 执行意图只携带业务身份；版本、thread 和 State 均由执行者从持久记录恢复。
export const workflowExecutionJobSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('start'), workflowRunId: workflowIdentifierSchema }).strict(),
  z
    .object({
      kind: z.literal('resume'),
      workflowRunId: workflowIdentifierSchema,
      executionId: workflowIdentifierSchema,
      value: z.unknown().refine((value): boolean => value !== undefined, '必须提供恢复值'),
    })
    .strict(),
]);
export type WorkflowExecutionJob = z.infer<typeof workflowExecutionJobSchema>;
export type StartWorkflowExecutionJob = Extract<WorkflowExecutionJob, { kind: 'start' }>;
export type ResumeWorkflowExecutionJob = Extract<WorkflowExecutionJob, { kind: 'resume' }>;

// Outbox.value 内部传输 envelope，不是 HTTP 请求或新增 Job 顶层字段。
// Runner 只消费传输目标，不解释 value 的业务内容。
export const targetedInterruptResumeValueSchema = z
  .object({
    kind: z.literal('targeted_interrupt'),
    interruptId: z.string().min(1),
    value: z.json(),
  })
  .strict();
