import { z } from 'zod';

const jsonSchema = z.record(z.string(), z.json());
const jsonObjectSchema = z.record(z.string(), z.json());

export const providerDefinitionIdSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z][a-z0-9_]*$/);
export const providerCredentialFieldSchema = z
  .object({
    key: z.string().min(1),
    required: z.boolean(),
    minLength: z.number().int().nonnegative().optional(),
    maxLength: z.number().int().nonnegative().optional(),
  })
  .strict();
export const providerCatalogItemSchema = z
  .object({
    id: providerDefinitionIdSchema,
    displayName: z.string().min(1).max(80),
    available: z.boolean(),
    capabilities: z.array(
      z
        .object({
          type: z.string().min(1).max(100),
          name: z.string().min(1).max(100),
        })
        .strict(),
    ),
    credentialFields: z.array(providerCredentialFieldSchema),
    configurationSchema: jsonSchema,
  })
  .strict();
export const providerCatalogSchema = z
  .object({ items: z.array(providerCatalogItemSchema) })
  .strict();
export const createCatalogProviderSchema = z
  .object({
    projectId: z.uuid(),
    name: z.string().trim().min(1).max(80),
    providerDefinitionId: providerDefinitionIdSchema,
    credentials: z.record(z.string(), z.string()),
    configuration: jsonObjectSchema.optional(),
  })
  .strict();
export const createProjectCatalogProviderRequestSchema = createCatalogProviderSchema.omit({
  projectId: true,
});
export type ProviderCatalogItem = z.infer<typeof providerCatalogItemSchema>;
export type CreateCatalogProvider = z.infer<typeof createCatalogProviderSchema>;
