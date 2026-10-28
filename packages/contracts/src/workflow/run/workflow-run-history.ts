import { z } from 'zod';
import { workflowIdentifierSchema } from '../metadata.js';
import { workflowRunResponseSchema } from './workflow-run-api.js';

const cursorToken = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9_-]+$/);
const cursorValue = z
  .object({ createdAt: z.iso.datetime({ precision: 3 }), id: workflowIdentifierSchema })
  .strict();
export const workflowRunHistoryQuerySchema = z.object({ cursor: cursorToken.optional() }).strict();
// 列表不读取输入输出，也不投影 thread / Outbox / checkpoint 身份。
export const workflowRunSummarySchema = workflowRunResponseSchema
  .pick({
    id: true,
    workflowId: true,
    workflowVersionId: true,
    status: true,
    createdAt: true,
    startedAt: true,
    completedAt: true,
    error: true,
  })
  .extend({ version: z.number().int().positive().nullable() });
export const workflowRunHistoryResponseSchema = z
  .object({ items: z.array(workflowRunSummarySchema), nextCursor: cursorToken.nullable() })
  .strict();
export type WorkflowRunSummary = z.infer<typeof workflowRunSummarySchema>;
export type WorkflowRunHistoryResponse = z.infer<typeof workflowRunHistoryResponseSchema>;
export function encodeWorkflowRunCursor(value: z.infer<typeof cursorValue>): string {
  const bytes = new TextEncoder().encode(JSON.stringify(cursorValue.parse(value)));
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}
export function decodeWorkflowRunCursor(token: string): z.infer<typeof cursorValue> {
  cursorToken.parse(token);
  let value: unknown;
  try {
    const base64 = token.replaceAll('-', '+').replaceAll('_', '/');
    value = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(
        Uint8Array.from(atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4)), (c) =>
          c.charCodeAt(0),
        ),
      ),
    );
  } catch {
    value = undefined;
  }
  return cursorValue.parse(value);
}
