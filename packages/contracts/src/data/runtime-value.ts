import { z } from 'zod';
import { containsInlineMediaValue, dataTypeSchema, type ArrayDataType } from './type.js';
import { isTypeAssignable } from './compatibility.js';
import { dataReferenceSchema } from './reference.js';
export const inlineRuntimeValueSchema = z
  .object({ storage: z.literal('inline'), type: dataTypeSchema, value: z.json() })
  .strict();
export const referenceRuntimeValueSchema = z
  .object({ storage: z.literal('reference'), type: dataTypeSchema, reference: dataReferenceSchema })
  .strict();
export type InlineRuntimeValue = z.infer<typeof inlineRuntimeValueSchema>;
export type ReferenceRuntimeValue = z.infer<typeof referenceRuntimeValueSchema>;

// elements 是运行表示，绝不是 Array<T> 的业务 JSON；可递归保留引用及元素实际类型。
export interface CollectionRuntimeValue {
  storage: 'collection';
  type: ArrayDataType;
  elements: RuntimeValue[];
}
export type RuntimeValue = InlineRuntimeValue | ReferenceRuntimeValue | CollectionRuntimeValue;
export const collectionRuntimeValueSchema: z.ZodType<CollectionRuntimeValue> = z.lazy(() =>
  z
    .object({
      storage: z.literal('collection'),
      type: z.object({ kind: z.literal('array'), itemType: dataTypeSchema }).strict(),
      elements: z.array(runtimeValueSchema),
    })
    .strict()
    .superRefine((value, context) => {
      value.elements.forEach((element, index) => {
        if (element.storage === 'inline' && containsInlineMediaValue(element.type, element.value))
          context.addIssue({
            code: 'custom',
            path: ['elements', index],
            message: '媒体集合元素必须保留内容引用',
          });
        if (!isTypeAssignable(element.type, value.type.itemType))
          context.addIssue({
            code: 'custom',
            path: ['elements', index, 'type'],
            message: '集合元素类型与 itemType 不兼容',
          });
      });
    }),
);
export const runtimeValueSchema: z.ZodType<RuntimeValue> = z.lazy(() =>
  z.union([inlineRuntimeValueSchema, referenceRuntimeValueSchema, collectionRuntimeValueSchema]),
);
export const runtimeValueMapSchema = z.record(z.string(), runtimeValueSchema);
export const nodeOutputMapSchema = z.record(z.string(), runtimeValueMapSchema);
export type NodeOutputMap = z.infer<typeof nodeOutputMapSchema>;
