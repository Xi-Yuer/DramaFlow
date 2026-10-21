import { z } from 'zod';
import {
  createModelProviderSchema,
  createModelConfigurationSchema,
  modelProviderSchema,
  modelConfigurationSchema,
} from './model-provider.js';

const jsonSchema = z.record(z.string(), z.json());
export const providerPluginDescriptionSchema = z
  .object({
    id: z.string().min(1).max(100),
    version: z.number().int().positive(),
    name: z.string().min(1).max(100),
    description: z.string().max(1000).optional(),
    configurationSchema: jsonSchema,
    // 凭证仅公开字段及长度约束，不公开默认值、示例或其他可能包含秘密的 Schema 内容。
    credentialFields: z.array(
      z
        .object({
          key: z.string().min(1),
          required: z.boolean(),
          minLength: z.number().int().nonnegative().optional(),
          maxLength: z.number().int().nonnegative().optional(),
        })
        .strict(),
    ),
    capabilities: z.array(
      z
        .object({
          type: z.string().min(1).max(100),
          name: z.string().min(1).max(100),
          description: z.string().max(1000).optional(),
          modelSettingsSchema: jsonSchema,
        })
        .strict(),
    ),
  })
  .strict();
export const providerPluginCatalogSchema = z
  .object({ items: z.array(providerPluginDescriptionSchema) })
  .strict();
export const createProjectProviderRequestSchema = createModelProviderSchema.omit({
  projectId: true,
});
export const createProjectModelRequestSchema = createModelConfigurationSchema.omit({
  projectId: true,
});
export const setModelResourceEnabledRequestSchema = z.object({ enabled: z.boolean() }).strict();
export const replaceProviderCredentialsRequestSchema = z
  .object({
    credentials: createModelProviderSchema.shape.credentials,
  })
  .strict();
export const modelManagementListQuerySchema = z.object({ cursor: z.uuid().optional() }).strict();
export const modelAvailabilitySchema = z
  .object({
    selectable: z.boolean(),
    unavailableReason: z
      .enum([
        'MODEL_DISABLED',
        'PROVIDER_DISABLED',
        'PLUGIN_UNAVAILABLE',
        'CAPABILITY_UNAVAILABLE',
        'CONFIGURATION_INVALID',
      ])
      .nullable(),
  })
  .strict()
  .refine(
    (value) => value.selectable === (value.unavailableReason === null),
    '可选状态与原因不一致',
  );
export const managedModelConfigurationSchema = modelConfigurationSchema
  .extend({
    availability: modelAvailabilitySchema,
  })
  .strict();
export const modelProviderListSchema = z
  .object({
    items: z.array(modelProviderSchema),
    nextCursor: z.uuid().nullable(),
  })
  .strict();
export const modelConfigurationListSchema = z
  .object({
    items: z.array(managedModelConfigurationSchema),
    nextCursor: z.uuid().nullable(),
  })
  .strict();
export type ProviderPluginDescription = z.infer<typeof providerPluginDescriptionSchema>;
export type ModelAvailability = z.infer<typeof modelAvailabilitySchema>;
export type ManagedModelConfiguration = z.infer<typeof managedModelConfigurationSchema>;
