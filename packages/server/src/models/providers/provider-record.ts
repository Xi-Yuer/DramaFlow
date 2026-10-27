import { modelProviderSchema, type ModelProvider } from '@dramaflow/contracts';
import type { Prisma } from '@dramaflow/database';

// 读取路径从数据库投影中排除密文，不依靠序列化时删除秘密字段。
export const providerSelect = {
  id: true,
  ownerId: true,
  name: true,
  pluginId: true,
  pluginVersion: true,
  configuration: true,
  providerDefinitionId: true,
  enabled: true,
  createdAt: true,
} satisfies Prisma.ModelProviderSelect;
type ProviderRow = Prisma.ModelProviderGetPayload<{ select: typeof providerSelect }>;
export function providerDto(row: ProviderRow): ModelProvider {
  return modelProviderSchema.parse({
    id: row.id,
    ownerId: row.ownerId,
    name: row.name,
    pluginId: row.pluginId,
    pluginVersion: row.pluginVersion,
    configuration: row.configuration,
    providerDefinitionId: row.providerDefinitionId,
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
  });
}
