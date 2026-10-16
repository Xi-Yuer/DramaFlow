'use client';

import type {
  Capability,
  JsonValue,
  ModelSelection,
  PluginConnection,
  PluginInstallation,
} from '@dramaflow/contracts';
import { FormField } from '@/components/ui/form-field';

export function readModel(value: JsonValue | undefined): ModelSelection | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return typeof value.pluginId === 'string' &&
    typeof value.pluginVersion === 'string' &&
    typeof value.connectionId === 'string' &&
    typeof value.modelId === 'string'
    ? {
        pluginId: value.pluginId,
        pluginVersion: value.pluginVersion,
        connectionId: value.connectionId,
        modelId: value.modelId,
      }
    : undefined;
}

export function ModelSelector({
  capability,
  value,
  onChange,
  plugins,
  connections,
  disabled = false,
}: {
  capability: Capability;
  value?: ModelSelection;
  onChange: (model: ModelSelection) => void;
  plugins: PluginInstallation[];
  connections: PluginConnection[];
  disabled?: boolean;
}) {
  const compatible = plugins.filter(
    (plugin) => plugin.enabled && plugin.manifest.capabilities.includes(capability),
  );
  const selected = compatible.find(
    (plugin) =>
      plugin.pluginId === value?.pluginId && plugin.pluginVersion === value?.pluginVersion,
  );
  const availableConnections = connections.filter(
    (connection) =>
      connection.pluginId === selected?.pluginId &&
      connection.pluginVersion === selected.pluginVersion &&
      connection.hasCredential,
  );
  return (
    <div className="model-selector">
      {!compatible.length && (
        <p className="config-section-note">
          尚未启用支持该能力的插件。请在插件与连接设置中启用受信任插件。
        </p>
      )}
      <FormField
        label="能力插件"
        hint={value?.pluginId && !selected ? '此插件版本不可用，运行将被阻止。' : undefined}
      >
        <select
          value={value ? `${value.pluginId}@${value.pluginVersion}` : ''}
          disabled={disabled || !compatible.length}
          onChange={(event) => {
            const plugin = compatible.find(
              (entry) => `${entry.pluginId}@${entry.pluginVersion}` === event.target.value,
            );
            if (plugin)
              onChange({
                pluginId: plugin.pluginId,
                pluginVersion: plugin.pluginVersion,
                modelId: '',
                connectionId: '',
              });
          }}
        >
          <option value="" disabled>
            选择插件
          </option>
          {compatible.map((plugin) => (
            <option
              key={`${plugin.pluginId}@${plugin.pluginVersion}`}
              value={`${plugin.pluginId}@${plugin.pluginVersion}`}
            >
              {plugin.manifest.name} · {plugin.pluginVersion}
            </option>
          ))}
        </select>
      </FormField>
      <FormField
        label="模型"
        hint={
          selected && !selected.manifest.models.length
            ? '按供应商文档填写模型标识；请确认连接的上下文窗口与该模型一致。'
            : undefined
        }
      >
        {selected && !selected.manifest.models.length ? (
          <input
            value={value?.modelId ?? ''}
            disabled={disabled}
            placeholder="填写模型 ID"
            onChange={(event) => {
              if (value) onChange({ ...value, modelId: event.target.value });
            }}
          />
        ) : (
          <select
            value={value?.modelId ?? ''}
            disabled={disabled || !selected}
            onChange={(event) => {
              if (value) onChange({ ...value, modelId: event.target.value });
            }}
          >
            <option value="" disabled>
              选择模型
            </option>
            {selected?.manifest.models
              .filter((model) => model.capabilities.includes(capability))
              .map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name}
                </option>
              ))}
          </select>
        )}
      </FormField>
      <FormField
        label="凭证连接"
        hint={
          selected && !availableConnections.length
            ? '尚无可用连接，请先配置服务端凭证。'
            : '这里只保存连接引用，不包含密钥。'
        }
      >
        <select
          value={value?.connectionId ?? ''}
          disabled={disabled || !selected}
          onChange={(event) => {
            if (value) onChange({ ...value, connectionId: event.target.value });
          }}
        >
          <option value="" disabled>
            选择连接
          </option>
          {availableConnections.map((connection) => (
            <option key={connection.id} value={connection.id}>
              {connection.name}
            </option>
          ))}
        </select>
      </FormField>
    </div>
  );
}
