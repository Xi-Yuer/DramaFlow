import { z } from 'zod';

export interface AnyDataType {
  kind: 'any';
}
export interface PrimitiveDataType {
  kind: 'primitive';
  name: 'string' | 'number' | 'boolean' | 'null';
}
export interface NamedDataType {
  kind: 'named';
  name: string;
}
export interface ArrayDataType {
  kind: 'array';
  itemType: DataType;
}
export interface ObjectDataType {
  kind: 'object';
  properties: Record<string, DataType>;
}
export interface UnionDataType {
  kind: 'union';
  types: DataType[];
}
export type DataType =
  AnyDataType | PrimitiveDataType | NamedDataType | ArrayDataType | ObjectDataType | UnionDataType;

export const dataTypeNameSchema = z
  .string()
  .max(160)
  .regex(/^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_]*)+$/, '类型名称须使用英文命名空间');
export const dataPropertyNameSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((key) => !['__proto__', 'constructor', 'prototype'].includes(key), '不能使用保留属性名');
export const dataTypeSchema: z.ZodType<DataType> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('any') }).strict(),
    z
      .object({
        kind: z.literal('primitive'),
        name: z.enum(['string', 'number', 'boolean', 'null']),
      })
      .strict(),
    z.object({ kind: z.literal('named'), name: dataTypeNameSchema }).strict(),
    z.object({ kind: z.literal('array'), itemType: dataTypeSchema }).strict(),
    z
      .object({
        kind: z.literal('object'),
        properties: z
          .unknown()
          .superRefine((value, context) => {
            if (value && typeof value === 'object') {
              for (const key of Object.keys(value)) {
                if (['__proto__', 'constructor', 'prototype'].includes(key))
                  context.addIssue({ code: 'custom', path: [key], message: '不能使用保留属性名' });
              }
            }
          })
          .pipe(z.record(dataPropertyNameSchema, dataTypeSchema)),
      })
      .strict(),
    z.object({ kind: z.literal('union'), types: z.array(dataTypeSchema).min(1) }).strict(),
  ]),
);

// 媒体业务值不能作为 JSON 集合元素持久化；内容引用必须在运行表示层保留。
export function containsMediaDataType(type: DataType): boolean {
  switch (type.kind) {
    case 'named':
      return type.name.startsWith('media.');
    case 'array':
      return containsMediaDataType(type.itemType);
    case 'object':
      return Object.values(type.properties).some(containsMediaDataType);
    case 'union':
      return type.types.some(containsMediaDataType);
    default:
      return false;
  }
}

// 空媒体数组（含嵌套空数组）没有媒体业务值，无需人为创建引用。
export function containsInlineMediaValue(type: DataType, value: unknown): boolean {
  if (!containsMediaDataType(type)) return false;
  if (type.kind === 'array' && Array.isArray(value))
    return value.some((item: unknown) => containsInlineMediaValue(type.itemType, item));
  return true;
}
