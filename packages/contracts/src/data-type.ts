import { z } from 'zod';
import { workflowIdentifierSchema } from './workflow.js';

// 只描述可序列化的端口类型，不代替执行侧 Zod 值契约或资产引用协议。
export type DataType =
  | { kind: 'any' }
  | { kind: 'json' }
  | { kind: 'file' }
  | { kind: 'string' }
  | { kind: 'number' }
  | { kind: 'boolean' }
  | { kind: 'image' }
  | { kind: 'video' }
  | { kind: 'audio' }
  | { kind: 'domain'; name: string }
  | { kind: 'array'; item: DataType };

export const dataTypeSchema: z.ZodType<DataType> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('any') }).strict(),
    z.object({ kind: z.literal('json') }).strict(),
    z.object({ kind: z.literal('file') }).strict(),
    z.object({ kind: z.literal('string') }).strict(),
    z.object({ kind: z.literal('number') }).strict(),
    z.object({ kind: z.literal('boolean') }).strict(),
    z.object({ kind: z.literal('image') }).strict(),
    z.object({ kind: z.literal('video') }).strict(),
    z.object({ kind: z.literal('audio') }).strict(),
    z.object({ kind: z.literal('domain'), name: workflowIdentifierSchema }).strict(),
    z.object({ kind: z.literal('array'), item: dataTypeSchema }).strict(),
  ]),
);
