import { z } from 'zod';
import { dataTypeSchema } from '../data/type.js';
import { contentIdentifierSchema } from '../data/reference.js';
import { artifactStorageSchema } from './artifact.js';
export const assetSourceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('upload') }).strict(),
  z.object({ type: z.literal('artifact'), artifactId: contentIdentifierSchema }).strict(),
  z
    .object({
      type: z.literal('external'),
      provider: z.string().min(1).max(80),
      externalId: contentIdentifierSchema.optional(),
    })
    .strict(),
]);
export const assetDataSchema = z.discriminatedUnion('storage', [
  z.object({ storage: z.literal('inline'), value: z.json() }).strict(),
  z.object({ storage: z.literal('reference'), location: artifactStorageSchema }).strict(),
]);
export const assetSchema = z
  .object({
    id: contentIdentifierSchema,
    versionId: contentIdentifierSchema,
    projectId: contentIdentifierSchema,
    type: dataTypeSchema,
    name: z.string().trim().min(1).max(200),
    source: assetSourceSchema,
    data: assetDataSchema,
    metadata: z.record(z.string(), z.json()).optional(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
export type AssetSource = z.infer<typeof assetSourceSchema>;
export type AssetData = z.infer<typeof assetDataSchema>;
export type Asset = z.infer<typeof assetSchema>;
