import { z } from 'zod';
import type { CreateModelProvider } from '@dramaflow/contracts';

// 当前表单支持扁平标量对象。遇到不能表现的约束明确拒绝，不静默丢字段或执行远程 Schema。
const scalarSchema = z
  .object({
    type: z.enum(['string', 'number', 'integer', 'boolean']),
    title: z.string().optional(),
    description: z.string().optional(),
    default: z.union([z.string(), z.number(), z.boolean()]).optional(),
    enum: z
      .array(z.union([z.string(), z.number(), z.boolean()]))
      .min(1)
      .optional(),
    minLength: z.number().int().nonnegative().optional(),
    maxLength: z.number().int().nonnegative().optional(),
    minimum: z.number().optional(),
    maximum: z.number().optional(),
    exclusiveMinimum: z.number().optional(),
    exclusiveMaximum: z.number().optional(),
    multipleOf: z.number().positive().optional(),
    pattern: z.string().optional(),
    format: z.enum(['uri', 'email']).optional(),
  })
  .strict();
const objectSchema = z
  .object({
    $schema: z
      .enum([
        'https://json-schema.org/draft/2020-12/schema',
        'http://json-schema.org/draft-07/schema#',
        'http://json-schema.org/draft-04/schema#',
      ])
      .optional(),
    type: z.literal('object'),
    title: z.string().optional(),
    description: z.string().optional(),
    properties: z.record(z.string(), scalarSchema),
    required: z.array(z.string()).optional(),
    additionalProperties: z.literal(false),
  })
  .strict();
const labels: Record<string, string> = {
  baseURL: '服务地址',
  timeoutMs: '请求超时（毫秒）',
  temperature: '随机度（temperature）',
  maxOutputTokens: '最大输出 Token 数',
  apiKey: 'API Key',
};
export const fieldLabel = (key: string, title?: string) => title ?? labels[key] ?? key;
export const unsupportedSchemaMessage = '此接入方式的表单格式暂不受支持，请联系部署管理员';
export interface SchemaField extends z.infer<typeof scalarSchema> {
  key: string;
  label: string;
  required: boolean;
  validator: z.ZodType;
}
export interface SchemaFields {
  fields: SchemaField[];
  defaults: Record<string, string | number | boolean>;
  validate: (values: unknown) => CreateModelProvider['configuration'];
}
export function compileSchemaFields(input: unknown): SchemaFields {
  const parsed = objectSchema.safeParse(input);
  if (!parsed.success) throw new Error(unsupportedSchemaMessage);
  const schema = parsed.data;
  const required = new Set(schema.required ?? []);
  if (
    [...required].some((key) => !Object.hasOwn(schema.properties, key)) ||
    Object.keys(schema.properties).some((key) =>
      ['__proto__', 'prototype', 'constructor'].includes(key),
    )
  )
    throw new Error(unsupportedSchemaMessage);
  try {
    const validator = z.fromJSONSchema(schema);
    const fields = Object.entries(schema.properties).map(([key, property]) => {
      let fieldValidator = z.fromJSONSchema(property);
      if (!required.has(key)) fieldValidator = fieldValidator.optional();
      return {
        ...property,
        key,
        label: fieldLabel(key, property.title),
        required: required.has(key),
        validator: fieldValidator,
      };
    });
    const defaults = Object.fromEntries(
      fields
        .filter((field) => field.default !== undefined)
        .map((field) => [field.key, field.default!]),
    );
    return {
      fields,
      defaults,
      validate: (values) =>
        z.record(z.string(), z.json()).parse(validator.parse(cleanSchemaValues(fields, values))),
    };
  } catch {
    throw new Error(unsupportedSchemaMessage);
  }
}
export function cleanSchemaValues(fields: readonly SchemaField[], input: unknown) {
  const values = z.record(z.string(), z.unknown()).parse(input ?? {});
  // 只归一化空控件，不丢弃未知字段；完整 Schema 负责拒绝未知输入。
  return Object.fromEntries(
    Object.entries(values).filter(([key, value]) => {
      const field = fields.find((item) => item.key === key);
      return !(value === undefined || value === null || (value === '' && field && !field.required));
    }),
  );
}
export function trySchemaFields(input: unknown) {
  try {
    return { form: compileSchemaFields(input), error: null };
  } catch {
    return { form: null, error: unsupportedSchemaMessage };
  }
}
