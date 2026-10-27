import { NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import type { PluginRegistry } from '@dramaflow/plugins';
import type { DatabaseService } from '../../database/database.service.js';
import type { SecretsService } from '../../secrets/secrets.service.js';
import { ModelConfigurationError } from '../shared/model-configuration-error.js';
import { providerSelect } from './provider-record.js';

export async function replaceProviderCredentials(
  db: DatabaseService,
  secrets: SecretsService,
  plugins: PluginRegistry,
  ownerId: string,
  providerId: string,
  credentials: Record<string, string>,
): Promise<void> {
  const provider = await db.client.modelProvider.findFirst({
    where: {
      id: z.uuid().parse(providerId),
      ownerId,
    },
    select: providerSelect,
  });
  if (!provider) throw new NotFoundException('Provider 不存在或无权访问');
  let parsed: Record<string, string>;
  try {
    parsed = z
      .record(z.string(), z.string())
      .parse(
        plugins.get(provider.pluginId, provider.pluginVersion).credentialsSchema.parse(credentials),
      );
  } catch {
    throw new ModelConfigurationError('MODEL_CREDENTIALS_UNAVAILABLE');
  }
  const changed = await db.client.modelProvider.updateMany({
    where: {
      id: provider.id,
      ownerId,
    },
    data: { encryptedCredentials: secrets.encrypt(JSON.stringify(parsed), ownerId) },
  });
  if (changed.count !== 1) throw new NotFoundException('Provider 不存在或无权访问');
}
