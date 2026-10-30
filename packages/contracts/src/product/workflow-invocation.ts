import { z } from 'zod';
import { workflowIdentifierSchema } from '../workflow/metadata.js';
import { workflowInvocationKeySchema } from '../workflow/run/workflow-run.js';
import {
  startWorkflowRunRequestSchema,
  workflowRunResponseSchema,
} from '../workflow/run/workflow-run-api.js';

export const productWorkflowInvocationSchema = z
  .object({
    id: z.uuid(),
    projectId: z.uuid(),
    sourceVideoId: z.uuid(),
    sourceVideoName: z.string().trim().min(1).max(80),
    workflowRunId: workflowIdentifierSchema,
    invocationKey: workflowInvocationKeySchema,
    createdAt: z.iso.datetime(),
  })
  .strict();
export const startProductWorkflowInvocationSchema = startWorkflowRunRequestSchema;
export const productWorkflowInvocationResponseSchema = z
  .object({
    invocation: productWorkflowInvocationSchema,
    run: workflowRunResponseSchema,
  })
  .strict()
  .superRefine(({ invocation, run }, context) => {
    if (invocation.workflowRunId !== run.id || invocation.invocationKey !== run.invocationKey)
      context.addIssue({ code: 'custom', message: '产品调用与运行身份不一致' });
  });
export const productWorkflowInvocationLookupSchema = z
  .object({
    invocation: productWorkflowInvocationSchema.nullable(),
  })
  .strict();
const cursorToken = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/);
const cursorSchema = z
  .object({ id: z.uuid(), createdAt: z.iso.datetime({ precision: 3 }) })
  .strict();
export const productWorkflowInvocationListQuerySchema = z
  .object({ cursor: cursorToken.optional() })
  .strict();
export const productWorkflowInvocationListSchema = z
  .object({
    items: z.array(productWorkflowInvocationSchema),
    nextCursor: cursorToken.nullable(),
  })
  .strict();
export type ProductWorkflowInvocation = z.infer<typeof productWorkflowInvocationSchema>;
export function encodeProductInvocationCursor(cursor: z.infer<typeof cursorSchema>): string {
  return btoa(JSON.stringify(cursorSchema.parse(cursor)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}
export function decodeProductInvocationCursor(token: string): z.infer<typeof cursorSchema> {
  const value = cursorToken.parse(token).replaceAll('-', '+').replaceAll('_', '/');
  let parsed: unknown;
  try {
    parsed = JSON.parse(atob(value + '='.repeat((4 - (value.length % 4)) % 4)));
  } catch {
    parsed = undefined;
  }
  return cursorSchema.parse(parsed);
}
