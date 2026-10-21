import { z } from 'zod';

const jsonObjectSchema = z.record(z.string(), z.json());
export const createModelProviderSchema = z
  .object({
    projectId: z.uuid(),
    name: z.string().trim().min(1).max(80),
    pluginId: z.string().min(1).max(100),
    pluginVersion: z.number().int().positive(),
    configuration: jsonObjectSchema,
    credentials: z.record(z.string(), z.string()),
  })
  .strict();
export const modelProviderSchema = createModelProviderSchema
  .omit({ credentials: true })
  .extend({
    id: z.uuid(),
    enabled: z.boolean(),
    createdAt: z.iso.datetime(),
  })
  .strict();
export const createModelConfigurationSchema = z
  .object({
    projectId: z.uuid(),
    providerId: z.uuid(),
    capability: z.string().min(1).max(100),
    model: z.string().trim().min(1).max(200),
    settings: jsonObjectSchema,
  })
  .strict();
export const modelConfigurationSchema = createModelConfigurationSchema
  .extend({
    id: z.uuid(),
    enabled: z.boolean(),
    createdAt: z.iso.datetime(),
  })
  .strict();
export type CreateModelProvider = z.infer<typeof createModelProviderSchema>;
export type ModelProvider = z.infer<typeof modelProviderSchema>;
export type CreateModelConfiguration = z.infer<typeof createModelConfigurationSchema>;
export type ModelConfiguration = z.infer<typeof modelConfigurationSchema>;
