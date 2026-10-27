import type { Prisma } from '@dramaflow/database';
import { providerSelect } from '../providers/provider-record.js';

export const modelSelect = {
  id: true,
  ownerId: true,
  providerId: true,
  capability: true,
  model: true,
  settings: true,
  enabled: true,
  createdAt: true,
  provider: { select: providerSelect },
} satisfies Prisma.ModelConfigurationSelect;
export type ModelRow = Prisma.ModelConfigurationGetPayload<{ select: typeof modelSelect }>;
