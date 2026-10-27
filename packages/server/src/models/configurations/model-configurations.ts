import {
  createModelConfigurationSchema,
  modelConfigurationSchema,
  managedModelConfigurationSchema,
  modelConfigurationListSchema,
  modelManagementListQuerySchema,
  setModelResourceEnabledRequestSchema,
  type CreateModelConfiguration,
  type ModelConfiguration,
} from '@dramaflow/contracts';
import type { PluginRegistry } from '@dramaflow/plugins';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import type { DatabaseService } from '../../database/database.service.js';
import { providerSelect } from '../providers/provider-record.js';
import { ModelConfigurationError } from '../shared/model-configuration-error.js';
import { jsonObject } from '../shared/model-json.js';
import { pageAfter } from '../shared/model-pagination.js';
import { modelAvailability } from './model-availability.js';
import { modelSelect, type ModelRow } from './model-record.js';

export class ModelConfigurations {
  constructor(
    private readonly db: DatabaseService,
    private readonly plugins: PluginRegistry,
  ) {}

  async createModelConfiguration(
    ownerId: string,
    input: CreateModelConfiguration,
  ): Promise<ModelConfiguration> {
    const parsed = createModelConfigurationSchema.safeParse(input);
    if (!parsed.success) throw new ModelConfigurationError('MODEL_CONFIGURATION_INVALID');
    const value = parsed.data;
    const provider = await this.db.client.modelProvider.findFirst({
      where: {
        id: value.providerId,
        ownerId,
      },
      select: providerSelect,
    });
    if (!provider) throw new NotFoundException('Provider 不存在或无权访问');
    if (!provider.enabled) throw new ModelConfigurationError('MODEL_PROVIDER_UNAVAILABLE');
    let settings: z.infer<typeof jsonObject>;
    try {
      const plugin = this.plugins.getConfigurable(provider.pluginId, provider.pluginVersion);
      jsonObject.parse(plugin.configSchema.parse(provider.configuration));
      settings = jsonObject.parse(
        this.plugins
          .getCapability(provider.pluginId, provider.pluginVersion, value.capability)
          .modelSettingsSchema.parse(value.settings),
      );
    } catch {
      throw new ModelConfigurationError('MODEL_CONFIGURATION_INVALID');
    }
    const row = await this.db.client.modelConfiguration.create({
      data: { ...value, ownerId, settings },
    });
    return modelConfigurationSchema.parse({ ...row, createdAt: row.createdAt.toISOString() });
  }

  async getModelConfiguration(ownerId: string, id: string): Promise<ModelConfiguration | null> {
    const row = await this.db.client.modelConfiguration.findFirst({
      where: {
        id: z.uuid().parse(id),
        ownerId,
      },
    });
    return row
      ? modelConfigurationSchema.parse({ ...row, createdAt: row.createdAt.toISOString() })
      : null;
  }

  private managedModelDto(row: ModelRow) {
    return managedModelConfigurationSchema.parse({
      id: row.id,
      ownerId: row.ownerId,
      providerId: row.providerId,
      capability: row.capability,
      model: row.model,
      settings: row.settings,
      enabled: row.enabled,
      createdAt: row.createdAt.toISOString(),
      availability: modelAvailability(row, this.plugins),
    });
  }

  async getManagedModelConfiguration(ownerId: string, id: string) {
    const row = await this.db.client.modelConfiguration.findFirst({
      where: { id: z.uuid().parse(id), ownerId },
      select: modelSelect,
    });
    if (!row) throw new NotFoundException('模型配置不存在或无权访问');
    return this.managedModelDto(row);
  }

  async listModelConfigurations(ownerId: string, query: unknown) {
    const { cursor } = modelManagementListQuerySchema.parse(query);
    const where = { ownerId };
    const after = cursor
      ? await this.db.client.modelConfiguration.findFirst({
          where: { ...where, id: cursor },
          select: { id: true, createdAt: true },
        })
      : null;
    if (cursor && !after) throw new BadRequestException('分页游标无效');
    const rows = await this.db.client.modelConfiguration.findMany({
      where: { ...where, ...pageAfter(after) },
      select: modelSelect,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 51,
    });
    return modelConfigurationListSchema.parse({
      items: rows.slice(0, 50).map((row) => this.managedModelDto(row)),
      nextCursor: rows.length > 50 ? rows[49]!.id : null,
    });
  }

  async setModelEnabled(ownerId: string, id: string, enabled: boolean) {
    const value = setModelResourceEnabledRequestSchema.parse({ enabled });
    const changed = await this.db.client.modelConfiguration.updateMany({
      where: { id: z.uuid().parse(id), ownerId },
      data: value,
    });
    if (changed.count !== 1) throw new NotFoundException('模型配置不存在或无权访问');
    return this.getManagedModelConfiguration(ownerId, id);
  }
}
