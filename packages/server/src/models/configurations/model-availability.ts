import { createModelConfigurationSchema, type ModelAvailability } from '@dramaflow/contracts';
import type { PluginRegistry } from '@dramaflow/plugins';
import { jsonObject } from '../shared/model-json.js';
import type { ModelRow } from './model-record.js';

export function modelAvailability(row: ModelRow, plugins: PluginRegistry): ModelAvailability {
  const unavailable = (
    unavailableReason: ModelAvailability['unavailableReason'],
  ): ModelAvailability => ({ selectable: false, unavailableReason });
  if (!row.enabled) return unavailable('MODEL_DISABLED');
  if (!row.provider.enabled) return unavailable('PROVIDER_DISABLED');
  let plugin;
  try {
    plugin = plugins.get(row.provider.pluginId, row.provider.pluginVersion);
  } catch {
    return unavailable('PLUGIN_UNAVAILABLE');
  }
  const capability = plugin.capabilities.find((item) => item.type === row.capability);
  if (!capability) return unavailable('CAPABILITY_UNAVAILABLE');
  try {
    jsonObject.parse(plugin.configSchema.parse(row.provider.configuration));
    jsonObject.parse(capability.modelSettingsSchema.parse(row.settings));
    createModelConfigurationSchema.shape.model.parse(row.model);
  } catch {
    return unavailable('CONFIGURATION_INVALID');
  }
  return { selectable: true, unavailableReason: null };
}
