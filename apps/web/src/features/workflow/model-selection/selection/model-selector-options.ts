// ModelConfiguration 决定用户所有项目中可执行的选择；Model Catalog 只负责发现与显示增强。
// 两者保持独立身份，Catalog 缺失不能隐藏已有配置。

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
  name: string;
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

export interface ConfiguredSelectorModel {
  configurationId: string;
  model: string;
  displayName: string;
  detail: string | null;
}

export interface ConfiguredSelectorGroup {
  providerId: string;
  providerName: string;
  models: ConfiguredSelectorModel[];
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
    if (
      !capabilities.every((capability) =>
        item.capabilities.some((entry) => entry.type === capability),
      )
    )
      continue;
    const key = `${item.providerDefinitionId}\0${item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    matched.push(item);
  }
  return matched;
}

export function configurationParameterSummary(settings: Readonly<Record<string, unknown>>) {
  const parts: string[] = [];
  if (typeof settings.maxOutputTokens === 'number' && Number.isFinite(settings.maxOutputTokens))
    parts.push(`最大输出 ${settings.maxOutputTokens}`);
  if (typeof settings.temperature === 'number' && Number.isFinite(settings.temperature))
    parts.push(`随机度 ${settings.temperature}`);
  return parts.join(' · ') || null;
}

export function groupConfiguredModels(input: {
  catalog: readonly CatalogModelRef[];
  providers: readonly SelectorProviderInstance[];
  configurations: readonly SelectorConfiguration[];
  capabilityTypes: readonly string[];
}): ConfiguredSelectorGroup[] {
  const capabilityTypes = new Set(input.capabilityTypes);
  const groups: ConfiguredSelectorGroup[] = [];
  for (const provider of input.providers) {
    const models = input.configurations
      .filter(
        (configuration) =>
          configuration.providerId === provider.id &&
          capabilityTypes.has(configuration.capability) &&
          configuration.availability.selectable,
      )
      .map((configuration) => {
        const catalogItem = input.catalog.find(
          (item) =>
            item.id === configuration.model &&
            item.providerDefinitionId === provider.providerDefinitionId,
        );
        return {
          configurationId: configuration.id,
          model: configuration.model,
          displayName: catalogItem?.displayName ?? configuration.model,
          detail: configurationParameterSummary(configuration.settings),
        };
      });
    if (models.length)
      groups.push({
        providerId: provider.id,
        providerName: provider.name,
        models,
      });
  }
  return groups;
}

export function filterConfiguredGroups(groups: readonly ConfiguredSelectorGroup[], query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...groups];
  return groups
    .map((group) => ({
      ...group,
      models: group.models.filter(
        (model) =>
          group.providerName.toLowerCase().includes(needle) ||
          model.displayName.toLowerCase().includes(needle) ||
          model.model.toLowerCase().includes(needle),
      ),
    }))
    .filter((group) => group.models.length > 0);
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
      const provider = input.providers.find(
        (candidate) => candidate.id === configuration.providerId,
      );
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
      const ordered = [...selectable].sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt),
      );
      status = {
        kind: 'available',
        choices: ordered.map((configuration) => ({
          configurationId: configuration.id,
          detail:
            configurationParameterSummary(configuration.settings) ??
            (ordered.length > 1 ? '已有配置' : null),
        })),
      };
    } else if (enabled.length === 0) status = { kind: 'provider-disabled' };
    else {
      const disabled = matching
        .filter(
          (configuration) => configuration.availability.unavailableReason === 'MODEL_DISABLED',
        )
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
    const current = groups.find(
      (group) => group.providerDefinitionId === item.providerDefinitionId,
    );
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
          model.displayName.toLowerCase().includes(needle) ||
          model.id.toLowerCase().includes(needle),
      ),
    }))
    .filter((group) => group.models.length > 0);
}

export interface ModelSelectionResumeInput {
  providerId: string;
  catalogId: string;
  capability: string;
  configurations: readonly SelectorConfiguration[];
}

export type ModelSelectionResumeDecision =
  | { kind: 'select'; configurationId: string }
  | { kind: 'choose' }
  | { kind: 'add'; providerId: string };

// 配置供应商之后如何继续原来的目录模型。只看当前用户所有项目中的 ModelConfiguration，不保存这次判断。
export function resumeModelSelection(
  input: ModelSelectionResumeInput,
): ModelSelectionResumeDecision {
  const matching = input.configurations.filter(
    (configuration) =>
      configuration.providerId === input.providerId &&
      configuration.model === input.catalogId &&
      configuration.capability === input.capability,
  );
  const selectable = matching.filter((configuration) => configuration.availability.selectable);
  if (selectable.length === 1) {
    const configurationId = selectable[0]?.id;
    if (configurationId) return { kind: 'select', configurationId };
  }
  if (matching.length > 0) return { kind: 'choose' };
  return { kind: 'add', providerId: input.providerId };
}

export function describeSelection(input: {
  configurationId: unknown;
  configurations: readonly {
    id: string;
    model: string;
    providerId: string;
    settings?: Readonly<Record<string, unknown>>;
    availability?: SelectorConfiguration['availability'];
  }[];
  providers: readonly {
    id: string;
    name: string;
    providerDefinitionId: string | null;
  }[];
  definitions: readonly SelectorProviderDefinition[];
  catalog: readonly CatalogModelRef[];
}) {
  if (
    input.configurationId === undefined ||
    input.configurationId === null ||
    input.configurationId === ''
  )
    return { label: '选择模型', title: '选择模型', detail: null };
  if (typeof input.configurationId !== 'string')
    return { label: '模型配置不可用', title: '模型配置不可用', detail: null };
  const configuration = input.configurations.find((item) => item.id === input.configurationId);
  if (!configuration) return { label: '模型配置不可用', title: '模型配置不可用', detail: null };
  const provider = input.providers.find((item) => item.id === configuration.providerId);
  const catalogItem = input.catalog.find(
    (item) =>
      item.id === configuration.model &&
      item.providerDefinitionId === provider?.providerDefinitionId,
  );
  const providerName = input.definitions.find(
    (item) => item.id === provider?.providerDefinitionId,
  )?.displayName;
  const label = catalogItem?.displayName ?? configuration.model;
  const unavailable = configuration.availability?.unavailableReason;
  const unavailableLabels = {
    MODEL_DISABLED: '模型已停用',
    PROVIDER_DISABLED: '供应商已停用',
    PLUGIN_UNAVAILABLE: '接入方式当前不可用',
    CAPABILITY_UNAVAILABLE: '能力当前不可用',
    CONFIGURATION_INVALID: '配置当前不可用',
  } as const;
  const detail = unavailable
    ? unavailableLabels[unavailable]
    : configuration.settings
      ? configurationParameterSummary(configuration.settings)
      : null;
  const owner = provider?.name ?? providerName;
  const title = owner ? `${owner} · ${label}` : label;
  return { label, title: detail ? `${title}，${detail}` : title, detail };
}
