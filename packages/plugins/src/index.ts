import type { ModelProvider } from './sdk.js';
import type { ModelCapability } from './manifest.js';
import { ProviderError } from './sdk.js';
import { openaiProvider } from './providers/openai/index.js';
import { compatibleProvider } from './providers/openai-compatible/index.js';

export * from './sdk.js';
export * from './manifest.js';

const trustedProviders = [openaiProvider, compatibleProvider];

export function getProvider(pluginId: string, pluginVersion: string): ModelProvider {
  const provider = trustedProviders.find(
    (candidate) =>
      candidate.manifest.id === pluginId && candidate.manifest.version === pluginVersion,
  );
  if (!provider)
    throw new ProviderError(
      'UNSUPPORTED_CAPABILITY',
      `未安装受信任插件 ${pluginId}@${pluginVersion}`,
    );
  return provider;
}

export function assertProviderCapability(
  provider: ModelProvider,
  capability: ModelCapability,
): void {
  if (!provider.manifest.capabilities.includes(capability))
    throw new ProviderError(
      'UNSUPPORTED_CAPABILITY',
      `插件 ${provider.manifest.id} 不支持 ${capability}`,
    );
}
