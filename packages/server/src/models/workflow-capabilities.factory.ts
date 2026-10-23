import { capabilityInvocationSchema } from '@dramaflow/contracts';
import { PluginRegistry } from '@dramaflow/plugins';
import type { CapabilityInvoker } from '@dramaflow/workflow';
import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
import { SecretsService } from '../secrets/secrets.service.js';
import { ModelConfigurationError } from './model-provider.service.js';

@Injectable()
export class WorkflowCapabilitiesFactory {
  constructor(
    private readonly db: DatabaseService,
    private readonly secrets: SecretsService,
    private readonly plugins: PluginRegistry,
  ) {}

  forRun(ownerId: string, projectId: string, workflowRunId: string): CapabilityInvoker {
    return {
      invoke: async (capability, rawInput) => {
        const request = capabilityInvocationSchema.safeParse(rawInput);
        if (!request.success) throw new ModelConfigurationError('MODEL_CONFIGURATION_INVALID');
        const run = await this.db.client.workflowRun.findFirst({
          where: {
            id: workflowRunId,
            projectId,
            project: { ownerId },
            status: 'running',
          },
          select: { id: true },
        });
        if (!run) throw new ModelConfigurationError('MODEL_CONFIGURATION_UNAVAILABLE');
        const model = await this.db.client.modelConfiguration.findFirst({
          where: {
            id: request.data.modelConfigurationId,
            ownerId,
            enabled: true,
            capability,
          },
          include: { provider: true },
        });
        if (!model) throw new ModelConfigurationError('MODEL_CONFIGURATION_UNAVAILABLE');
        if (!model.provider.enabled || model.provider.ownerId !== ownerId)
          throw new ModelConfigurationError('MODEL_PROVIDER_UNAVAILABLE');
        let credentials: unknown;
        try {
          credentials = JSON.parse(
            this.secrets.decrypt(model.provider.encryptedCredentials, ownerId),
          );
        } catch {
          throw new ModelConfigurationError('MODEL_CREDENTIALS_UNAVAILABLE');
        }
        return this.plugins.invoke({
          pluginId: model.provider.pluginId,
          pluginVersion: model.provider.pluginVersion,
          capability,
          input: request.data.input,
          configuration: model.provider.configuration,
          credentials,
          model: model.model,
          settings: model.settings,
        });
      },
    };
  }
}
