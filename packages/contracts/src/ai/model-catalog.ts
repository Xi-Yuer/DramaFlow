import { z } from 'zod';
import { providerDefinitionIdSchema } from './provider-catalog.js';

export const modelCatalogModelIdSchema = z.string().trim().min(1).max(200);
export const modelCatalogItemSchema = z
  .object({
    id: modelCatalogModelIdSchema,
    displayName: z.string().min(1).max(80),
    providerDefinitionId: providerDefinitionIdSchema,
    capabilities: z
      .array(
        z
          .object({
            type: z.string().min(1).max(100),
            name: z.string().min(1).max(100),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export const modelCatalogSchema = z.object({ items: z.array(modelCatalogItemSchema) }).strict();
export const modelCatalogQuerySchema = z
  .object({ capability: z.string().min(1).max(100).optional() })
  .strict();
export type ModelCatalogItem = z.infer<typeof modelCatalogItemSchema>;
