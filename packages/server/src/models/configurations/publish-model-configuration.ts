import { createModelConfigurationSchema } from '@dramaflow/contracts';
import type { Prisma } from '@dramaflow/database';
import type { PluginRegistry } from '@dramaflow/plugins';
import { z } from 'zod';
import { ModelConfigurationError } from '../shared/model-configuration-error.js';
import { jsonObject } from '../shared/model-json.js';

// 只读取非秘密配置，使用调用方发布事务的连接；不解密、不调用能力或探活。
export async function assertPublishableConfiguration(
  plugins: PluginRegistry,
  tx: Prisma.TransactionClient,
  ownerId: string,
  id: string,
  capability: string,
): Promise<void> {
  const rows = await tx.$queryRaw<
    {
      enabled: boolean;
      capability: string;
      model: string;
      settings: unknown;
      providerEnabled: boolean;
      pluginId: string;
      pluginVersion: number;
      configuration: unknown;
    }[]
  >`
      SELECT m."enabled", m."capability", m."model", m."settings",
             p."enabled" AS "providerEnabled", p."pluginId", p."pluginVersion", p."configuration"
      FROM "model_configuration" m
      JOIN "model_provider" p ON p."id" = m."providerId" AND p."ownerId" = m."ownerId"
      WHERE m."id" = ${z.uuid().parse(id)}::uuid AND m."ownerId" = ${ownerId}
      FOR SHARE OF m, p
    `;
  const model = rows[0];
  if (!model || !model.enabled || model.capability !== capability)
    throw new ModelConfigurationError('MODEL_CONFIGURATION_UNAVAILABLE');
  if (!model.providerEnabled) throw new ModelConfigurationError('MODEL_PROVIDER_UNAVAILABLE');
  try {
    const plugin = plugins.get(model.pluginId, model.pluginVersion);
    const implementation = plugins.getCapability(model.pluginId, model.pluginVersion, capability);
    jsonObject.parse(plugin.configSchema.parse(model.configuration));
    jsonObject.parse(implementation.modelSettingsSchema.parse(model.settings));
    createModelConfigurationSchema.shape.model.parse(model.model);
  } catch {
    throw new ModelConfigurationError('MODEL_CONFIGURATION_INVALID');
  }
}
