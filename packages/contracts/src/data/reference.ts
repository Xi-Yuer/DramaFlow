import { z } from 'zod';
import { workflowIdentifierSchema } from '../workflow/metadata.js';
export const contentIdentifierSchema = workflowIdentifierSchema.max(200);
// Artifact ID 标识不可变产物；可编辑 Asset 的引用还必须固定到具体版本。
export const artifactReferenceSchema = z
  .object({ kind: z.literal('artifact'), id: contentIdentifierSchema })
  .strict();
export const assetReferenceSchema = z
  .object({
    kind: z.literal('asset'),
    id: contentIdentifierSchema,
    versionId: contentIdentifierSchema,
  })
  .strict();
export const dataReferenceSchema = z.discriminatedUnion('kind', [
  artifactReferenceSchema,
  assetReferenceSchema,
]);
export type ArtifactReference = z.infer<typeof artifactReferenceSchema>;
export type AssetReference = z.infer<typeof assetReferenceSchema>;
export type DataReference = z.infer<typeof dataReferenceSchema>;
