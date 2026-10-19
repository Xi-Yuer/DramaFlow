import { z } from 'zod';
import { workflowIdentifierSchema } from './workflow/metadata.js';

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

function matches(source: DataType, target: DataType): boolean {
  // 只有目标端口声明 any 时才接受其他类型。any 来源不能静默接到图片、视频等具体端口。
  if (target.kind === 'any') return true;
  if (source.kind === 'any') return false;
  if (source.kind === 'array') {
    return target.kind === 'array' && matches(source.item, target.item);
  }
  if (source.kind === 'domain') {
    return target.kind === 'domain' && source.name === target.name;
  }
  return source.kind === target.kind;
}

// 只做显式类型的结构匹配，不做值校验、媒体转换或隐式类型提升。
export function isDataTypeAssignable(source: DataType, target: DataType): boolean {
  return matches(dataTypeSchema.parse(source), dataTypeSchema.parse(target));
}
