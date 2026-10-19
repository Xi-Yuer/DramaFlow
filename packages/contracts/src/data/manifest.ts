import { z } from 'zod';
import { dataTypeNameSchema } from './type.js';
export const dataStoragePolicySchema = z.enum(['inline', 'reference', 'auto']);
export const dataTypeManifestSchema = z
  .object({
    name: dataTypeNameSchema,
    displayName: z.string().trim().min(1).max(80),
    category: z.string().trim().min(1).max(80),
    storage: dataStoragePolicySchema,
  })
  .strict();
export type DataStoragePolicy = z.infer<typeof dataStoragePolicySchema>;
export type DataTypeManifest = z.infer<typeof dataTypeManifestSchema>;
