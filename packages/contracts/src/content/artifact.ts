import { z } from 'zod';
import { dataTypeSchema } from '../data/type.js';
import { contentIdentifierSchema } from '../data/reference.js';
export const artifactStorageSchema = z
  .object({
    provider: z.string().trim().min(1).max(80),
    key: z.string().min(1).max(1024),
    mimeType: z.string().min(1).max(200).optional(),
    size: z.number().int().nonnegative().optional(),
    checksum: z.string().min(1).max(200).optional(),
  })
  .strict();
export const artifactSchema = z
  .object({
    id: contentIdentifierSchema,
    projectId: contentIdentifierSchema,
    workflowRunId: contentIdentifierSchema,
    nodeRunId: contentIdentifierSchema.optional(),
    type: dataTypeSchema,
    storage: artifactStorageSchema,
    metadata: z.record(z.string(), z.json()).optional(),
    createdAt: z.iso.datetime(),
  })
  .strict();
export type ArtifactStorage = z.infer<typeof artifactStorageSchema>;
export type Artifact = z.infer<typeof artifactSchema>;
