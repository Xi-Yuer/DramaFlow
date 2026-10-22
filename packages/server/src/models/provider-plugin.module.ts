import {
  OpenAICompatiblePlugin,
  PluginRegistry,
  TextGenerationPlugin,
  createOfficialModelCatalog,
  createOfficialProviderCatalog,
} from '@dramaflow/plugins';
import type { ModelCatalog, ProviderCatalog } from '@dramaflow/plugins';
import { Module } from '@nestjs/common';

// 仅注册构建时受信任代码；增加 Plugin 不需要修改 Compiler / Executor。
export function createProviderPluginRegistry(): PluginRegistry {
  return new PluginRegistry([new OpenAICompatiblePlugin(), new TextGenerationPlugin()]);
}

export function createProviderCatalog(
  plugins: PluginRegistry = createProviderPluginRegistry(),
): ProviderCatalog {
  return createOfficialProviderCatalog(plugins);
}

export function createModelCatalog(providers: ProviderCatalog): ModelCatalog {
  return createOfficialModelCatalog(providers);
}

@Module({
  providers: [{ provide: PluginRegistry, useFactory: createProviderPluginRegistry }],
  exports: [PluginRegistry],
})
export class ProviderPluginModule {}
