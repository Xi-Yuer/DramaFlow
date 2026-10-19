import { z } from 'zod';
import { dataTypeSchema } from './type.js';
import { dataReferenceSchema } from './reference.js';
export const inlineRuntimeValueSchema = z
  .object({ storage: z.literal('inline'), type: dataTypeSchema, value: z.json() })
  .strict();
export const referenceRuntimeValueSchema = z
  .object({ storage: z.literal('reference'), type: dataTypeSchema, reference: dataReferenceSchema })
  .strict();
export const runtimeValueSchema = z.discriminatedUnion('storage', [
  inlineRuntimeValueSchema,
  referenceRuntimeValueSchema,
]);
export const runtimeValueMapSchema = z.record(z.string(), runtimeValueSchema);
export const nodeOutputMapSchema = z.record(z.string(), runtimeValueMapSchema);
export type InlineRuntimeValue = z.infer<typeof inlineRuntimeValueSchema>;
export type ReferenceRuntimeValue = z.infer<typeof referenceRuntimeValueSchema>;
export type RuntimeValue = z.infer<typeof runtimeValueSchema>;
export type NodeOutputMap = z.infer<typeof nodeOutputMapSchema>;
