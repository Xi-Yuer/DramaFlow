import { z } from 'zod';
import { capabilitySchema, jsonObjectSchema } from '@dramaflow/contracts';
import type { Capability, PluginManifest } from '@dramaflow/contracts';

export { capabilitySchema };
export type ModelCapability = Capability;
export type { PluginManifest };
export { validateManifestConnection, validateManifestParameters } from './manifest-validation.js';

export const textParametersSchema = z
  .object({
    temperature: z.number().min(0).max(2).optional(),
    maxOutputTokens: z.number().int().positive().max(131072).optional(),
    topP: z.number().min(0).max(1).optional(),
  })
  .strict();

export const imageParametersSchema = z
  .object({
    n: z.number().int().min(1).max(10).default(1),
    size: z
      .string()
      .regex(/^(auto|[1-9]\d{1,4}x[1-9]\d{1,4})$/)
      .optional(),
    quality: z.enum(['auto', 'low', 'medium', 'high', 'xhigh', 'max']).optional(),
    background: z.enum(['auto', 'opaque', 'transparent']).optional(),
    outputFormat: z.enum(['png', 'jpeg', 'webp']).default('png'),
  })
  .strict()
  .refine((value) => value.background !== 'transparent' || value.outputFormat !== 'jpeg', {
    message: '透明背景不支持 JPEG 输出',
    path: ['outputFormat'],
  });

const jsonSchema = (schema: z.ZodType) => jsonObjectSchema.parse(z.toJSONSchema(schema));
const imageParameterJsonSchema = {
  ...jsonSchema(imageParametersSchema),
  not: {
    type: 'object',
    properties: { background: { const: 'transparent' }, outputFormat: { const: 'jpeg' } },
    required: ['background', 'outputFormat'],
  },
};
const modelBudgetFields = {
  contextWindow: z
    .number()
    .int()
    .min(2048)
    .default(16384)
    .describe('平台配置的输入输出总预算；请按所选模型实际窗口校正，默认值不是厂商上限声明'),
  maxOutputTokens: z.number().int().positive().default(2048).describe('连接允许的最大输出预算'),
};
export const openaiConnectionSchema = z
  .object({ baseUrl: z.url().optional(), ...modelBudgetFields })
  .strict();
export const compatibleConnectionSchema = z
  .object({ baseUrl: z.url(), ...modelBudgetFields })
  .strict();

/** Browser-safe metadata only. Never import the server registry into a client component. */
export const openaiManifest: PluginManifest = {
  id: 'openai',
  version: '1.0.0',
  name: 'OpenAI',
  description: '通过 LangChain 调用文本模型，通过官方 SDK 生成图片。模型由使用者明确指定。',
  capabilities: ['text.generate', 'image.generate', 'chat'],
  models: [],
  connectionSchema: jsonSchema(openaiConnectionSchema),
  parametersSchema: {
    'text.generate': jsonSchema(textParametersSchema),
    chat: jsonSchema(textParametersSchema),
    'image.generate': imageParameterJsonSchema,
  },
  supports: {
    streaming: false,
    structuredOutput: false,
    async: false,
    cancellation: false,
    idempotency: false,
  },
};

export const compatibleManifest: PluginManifest = {
  id: 'openai-compatible',
  version: '1.0.0',
  name: 'OpenAI 兼容文本接口',
  description: '仅声明兼容 Chat Completions 的文本能力，不推断图片、工具或视频兼容性。',
  capabilities: ['text.generate', 'chat'],
  models: [],
  connectionSchema: jsonSchema(compatibleConnectionSchema),
  parametersSchema: {
    'text.generate': jsonSchema(textParametersSchema),
    chat: jsonSchema(textParametersSchema),
  },
  supports: {
    streaming: false,
    structuredOutput: false,
    async: false,
    cancellation: false,
    idempotency: false,
  },
};

export function listPluginManifests(): PluginManifest[] {
  return structuredClone([openaiManifest, compatibleManifest]);
}
