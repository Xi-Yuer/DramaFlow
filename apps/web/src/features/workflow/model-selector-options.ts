// Model Catalog 只描述系统认识的模型。ModelConfiguration 是项目里可执行的配置。
// 分组结果同时引用两边，但不把它们合成同一个对象。

export interface CatalogModelRef {
  id: string;
  displayName: string;
  providerDefinitionId: string;
  capabilities: readonly { type: string }[];
}

export interface SelectorProviderDefinition {
  id: string;
  displayName: string;
}

export interface SelectorProviderInstance {
  id: string;
  providerDefinitionId: string | null;
  enabled: boolean;
  createdAt: string;
}

export interface SelectorConfiguration {
  id: string;
  providerId: string;
  capability: string;
  model: string;
  createdAt: string;
  settings: Readonly<Record<string, unknown>>;
  availability: {
    selectable: boolean;
    unavailableReason:
      | 'MODEL_DISABLED'
      | 'PROVIDER_DISABLED'
      | 'PLUGIN_UNAVAILABLE'
      | 'CAPABILITY_UNAVAILABLE'
      | 'CONFIGURATION_INVALID'
      | null;
  };
}

export interface SelectorChoice {
  configurationId: string;
  detail: string | null;
}

export type SelectorModelStatus =
  | { kind: 'available'; choices: SelectorChoice[] }
  | { kind: 'unconfigured' }
  | { kind: 'provider-disabled' }
  | { kind: 'disabled'; configurationId: string }
  | { kind: 'not-added'; providerId: string };

export interface SelectorModelRow {
  id: string;
  displayName: string;
  providerDefinitionId: string;
  status: SelectorModelStatus;
}

export interface SelectorGroup {
  providerDefinitionId: string;
  providerName: string;
  models: SelectorModelRow[];
}

export function modelsForCapabilities(
  items: readonly CatalogModelRef[],
  capabilities: readonly string[],
) {
  const seen = new Set<string>();
  const matched: CatalogModelRef[] = [];
  for (const item of items) {
    if (!capabilities.every((capability) => item.capabilities.some((entry) => entry.type === capability)))
      continue;
    const key = `${item.providerDefinitionId}\0${item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    matched.push(item);
  }
  return matched;
}

function choiceDetail(settings: Readonly<Record<string, unknown>>, multiple: boolean) {
  if (!multiple) return null;
  const parts: string[] = [];
  if (typeof settings.maxOutputTokens === 'number') parts.push(`最大输出 ${settings.maxOutputTokens}`);
  if (typeof settings.temperature === 'number') parts.push(`随机度 ${settings.temperature}`);
  return parts.join(' · ') || '已有配置';
}

function earliest(instances: readonly SelectorProviderInstance[]) {
  return [...instances].sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
}

export function groupSelectorModels(input: {
  catalog: readonly CatalogModelRef[];
  definitions: readonly SelectorProviderDefinition[];
  providers: readonly SelectorProviderInstance[];
  configurations: readonly SelectorConfiguration[];
  capability: string;
}): SelectorGroup[] {
  const names = new Map(input.definitions.map((item) => [item.id, item.displayName]));
  const groups: SelectorGroup[] = [];
  for (const item of input.catalog) {
    const instances = input.providers.filter(
      (provider) => provider.providerDefinitionId === item.providerDefinitionId,
    );
    const enabled = instances.filter((provider) => provider.enabled);
    const matching = input.configurations.filter((configuration) => {
      const provider = input.providers.find((candidate) => candidate.id === configuration.providerId);
      return (
        configuration.capability === input.capability &&
        configuration.model === item.id &&
        provider?.providerDefinitionId === item.providerDefinitionId
      );
    });
    const selectable = matching.filter((configuration) => configuration.availability.selectable);
    let status: SelectorModelStatus;
    if (instances.length === 0) status = { kind: 'unconfigured' };
    else if (selectable.length > 0) {
      const ordered = [...selectable].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      status = {
        kind: 'available',
        choices: ordered.map((configuration) => ({
          configurationId: configuration.id,
          detail: choiceDetail(configuration.settings, ordered.length > 1),
        })),
      };
    } else if (enabled.length === 0) status = { kind: 'provider-disabled' };
    else {
      const disabled = matching
        .filter((configuration) => configuration.availability.unavailableReason === 'MODEL_DISABLED')
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
      const provider = earliest(enabled);
      status = disabled
        ? { kind: 'disabled', configurationId: disabled.id }
        : provider
          ? { kind: 'not-added', providerId: provider.id }
          : { kind: 'provider-disabled' };
    }
    const row: SelectorModelRow = {
      id: item.id,
      displayName: item.displayName,
      providerDefinitionId: item.providerDefinitionId,
      status,
    };
    const current = groups.find((group) => group.providerDefinitionId === item.providerDefinitionId);
    if (current) current.models.push(row);
    else
      groups.push({
        providerDefinitionId: item.providerDefinitionId,
        providerName: names.get(item.providerDefinitionId) ?? '未知供应商',
        models: [row],
      });
  }
  return groups;
}

export function filterSelectorGroups(groups: readonly SelectorGroup[], query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...groups];
  return groups
    .map((group) => ({
      ...group,
      models: group.models.filter(
        (model) =>
          model.displayName.toLowerCase().includes(needle) || model.id.toLowerCase().includes(needle),
      ),
    }))
    .filter((group) => group.models.length > 0);
}

export function describeSelection(input: {
  configurationId: unknown;
  configurations: readonly { id: string; model: string; providerId: string }[];
  providers: readonly { id: string; providerDefinitionId: string | null }[];
  definitions: readonly SelectorProviderDefinition[];
  catalog: readonly CatalogModelRef[];
}) {
  if (input.configurationId === undefined || input.configurationId === null || input.configurationId === '')
    return { label: '选择模型', title: '选择模型' };
  if (typeof input.configurationId !== 'string')
    return { label: '模型配置不可用', title: '模型配置不可用' };
  const configuration = input.configurations.find((item) => item.id === input.configurationId);
  if (!configuration) return { label: '模型配置不可用', title: '模型配置不可用' };
  const provider = input.providers.find((item) => item.id === configuration.providerId);
  const catalogItem = input.catalog.find(
    (item) =>
      item.id === configuration.model && item.providerDefinitionId === provider?.providerDefinitionId,
  );
  const providerName = input.definitions.find(
    (item) => item.id === provider?.providerDefinitionId,
  )?.displayName;
  if (catalogItem) {
    const title = providerName ? `${providerName} · ${catalogItem.displayName}` : catalogItem.displayName;
    return { label: catalogItem.displayName, title };
  }
  return { label: configuration.model, title: configuration.model };
}
