import { Module } from '@nestjs/common';
import {
  ModelCatalog,
  PluginRegistry,
  ProviderCatalog,
  createOfficialModelCatalog,
  createOfficialProviderCatalog,
} from '@dramaflow/plugins';
import { DatabaseModule } from '../database/database.service.js';
import { SecretsModule } from '../secrets/secrets.module.js';
import { ProviderPluginModule } from './provider-plugin.module.js';
import { ModelProviderService } from './model-provider.service.js';
import { WorkflowCapabilitiesFactory } from './workflow-capabilities.factory.js';

@Module({
  imports: [DatabaseModule, SecretsModule, ProviderPluginModule],
  providers: [
    {
      provide: ProviderCatalog,
      useFactory: (plugins: PluginRegistry) => createOfficialProviderCatalog(plugins),
      inject: [PluginRegistry],
    },
    {
      provide: ModelCatalog,
      useFactory: (providers: ProviderCatalog) => createOfficialModelCatalog(providers),
      inject: [ProviderCatalog],
    },
    ModelProviderService,
    WorkflowCapabilitiesFactory,
  ],
  exports: [
    ModelProviderService,
    WorkflowCapabilitiesFactory,
    ProviderPluginModule,
    ProviderCatalog,
  ],
})
export class ModelProviderModule {}
