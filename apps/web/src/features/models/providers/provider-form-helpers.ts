import type { ModelProvider, ProviderPluginDescription } from '@dramaflow/contracts';

export const findPlugin = (
  plugins: ProviderPluginDescription[],
  provider: ModelProvider | undefined,
) =>
  plugins.find(
    (plugin) => plugin.id === provider?.pluginId && plugin.version === provider.pluginVersion,
  );
export const pluginKey = (plugin: ProviderPluginDescription) =>
  JSON.stringify([plugin.id, plugin.version]);
export const failure = (error: unknown) =>
  error instanceof Error ? error.message : '请求未完成，请刷新列表核对';
export function credentialSubmitLabel(
  fields: readonly { key: string }[],
  action: 'configure' | 'save',
) {
  const apiKey = fields.length === 1 && fields[0]?.key === 'apiKey';
  if (action === 'configure') return apiKey ? '配置 API Key' : '配置';
  return apiKey ? '保存 API Key' : '保存凭证';
}

export function blankConfiguration(schema: unknown) {
  if (!schema || typeof schema !== 'object' || !('properties' in schema)) return true;
  const properties = schema.properties;
  return !properties || (typeof properties === 'object' && Object.keys(properties).length === 0);
}
