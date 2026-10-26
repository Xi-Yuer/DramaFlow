'use client';
import { Alert, Button, Input, Popover, Spin } from 'antd';
import type { ManagedModelConfiguration } from '@dramaflow/contracts';
import { modelKeys } from '../../models/model-api';
import {
  describeSelection,
  filterConfiguredGroups,
  filterSelectorGroups,
  groupConfiguredModels,
  groupSelectorModels,
  modelsForCapabilities,
} from './selection/model-selector-options';
import { useModelSelection } from './selection/use-model-selection';
import { failure } from './selection/model-selection-resources';
import type { ModelSelectorProps } from './selection/model-selection-context';
import { ConfiguredModelGroup } from './presentation/configured-model-group';
import { ModelGroup } from './presentation/discovery-model-group';
import { AddCatalogModel } from './configuration/add-catalog-model';
import './presentation/model-selector.css';

export {
  WorkflowModelActionsContext,
  type ModelSelectionIntent,
  type ModelSelectionResume,
  type WorkflowModelActions,
} from './selection/model-selection-context';
export { ConfiguredModelGroup } from './presentation/configured-model-group';

export function ModelSelector({ nodeId, capabilityTypes, value }: ModelSelectorProps) {
  const {
    actions,
    userId,
    cache,
    client,
    hasValue,
    open,
    setOpen,
    query,
    setQuery,
    addTarget,
    setAddTarget,
    busyId,
    actionError,
    catalogQueries,
    definitions,
    providers,
    models,
    select,
    enable,
    reload,
  } = useModelSelection({ nodeId, capabilityTypes, value });
  if (!actions || capabilityTypes.length === 0) return <span>选择模型</span>;

  const catalog = modelsForCapabilities(
    catalogQueries.flatMap((item) => item.data?.items ?? []),
    capabilityTypes,
  );
  const capability = capabilityTypes[0] ?? '';
  const configurationItems = models.data ?? [];
  const providerItems = providers.data ?? [];
  const definitionItems = definitions.data?.items ?? [];
  const described = describeSelection({
    configurationId: value,
    configurations: configurationItems,
    providers: providerItems,
    definitions: definitionItems,
    catalog,
  });
  const configuredGroups = filterConfiguredGroups(
    groupConfiguredModels({
      catalog,
      providers: providerItems,
      configurations: configurationItems,
      capabilityTypes,
    }),
    query,
  );
  const configurationPending = providers.isPending || models.isPending;
  const configurationFailed = providers.error ?? models.error;
  const discoveryPending = catalogQueries.some((item) => item.isPending) || definitions.isPending;
  const discoveryFailed = catalogQueries.find((item) => item.isError)?.error ?? definitions.error;
  const discoveryGroups =
    discoveryPending || discoveryFailed
      ? []
      : filterSelectorGroups(
          groupSelectorModels({
            catalog,
            definitions: definitionItems,
            providers: providerItems,
            configurations: configurationItems,
            capability,
          })
            .map((group) => ({
              ...group,
              models: group.models.filter((model) => model.status.kind !== 'available'),
            }))
            .filter((group) => group.models.length > 0),
          query,
        );

  return (
    <>
      <Popover
        open={open}
        trigger="click"
        placement="bottomLeft"
        arrow={false}
        destroyOnHidden
        getPopupContainer={client ? () => document.body : undefined}
        styles={{ container: { padding: 0, background: '#19191d' } }}
        onOpenChange={(next) => {
          if (!actions.disabled) setOpen(next);
          if (!next) setQuery('');
        }}
        content={
          <div className="model-selector-panel" role="dialog" aria-label="选择模型">
            <Input
              allowClear
              autoFocus
              aria-label="搜索模型"
              placeholder="搜索模型..."
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            {configurationFailed ? (
              <Alert
                showIcon
                type="error"
                title="模型配置读取失败"
                description={failure(configurationFailed)}
                action={
                  <Button size="small" onClick={reload}>
                    重试
                  </Button>
                }
              />
            ) : configurationPending ? (
              <Spin size="small" />
            ) : (
              <>
                {discoveryFailed ? (
                  <Alert
                    showIcon
                    type="warning"
                    title="模型目录读取失败"
                    description="已配置模型仍可选择；暂时无法发现或添加目录模型。"
                    action={
                      <Button size="small" onClick={reload}>
                        重试
                      </Button>
                    }
                  />
                ) : null}
                {configuredGroups.length ? (
                  <div className="model-selector-section" aria-label="已配置模型">
                    <h2>已配置模型</h2>
                    {configuredGroups.map((group) => (
                      <ConfiguredModelGroup
                        key={group.providerId}
                        group={group}
                        selectedId={typeof value === 'string' ? value : undefined}
                        onSelect={select}
                      />
                    ))}
                  </div>
                ) : null}
                {discoveryPending ? (
                  <p className="model-selector-empty" role="status">
                    正在读取可添加模型…
                  </p>
                ) : null}
                {discoveryGroups.length ? (
                  <div className="model-selector-section" aria-label="发现并添加模型">
                    <h2>发现并添加模型</h2>
                    {discoveryGroups.map((group) => (
                      <ModelGroup
                        key={group.providerDefinitionId}
                        group={group}
                        selectedId={typeof value === 'string' ? value : undefined}
                        busyId={busyId}
                        onSelect={select}
                        onEnable={(configurationId) => void enable(configurationId)}
                        onConfigure={(row) => {
                          setOpen(false);
                          actions.onOpenProvider(group.providerDefinitionId, 'configure', {
                            nodeId,
                            catalogId: row.id,
                            displayName: row.displayName,
                            providerDefinitionId: group.providerDefinitionId,
                            capability,
                          });
                        }}
                        onManage={() => {
                          setOpen(false);
                          actions.onOpenProvider(group.providerDefinitionId, 'manage');
                        }}
                        onAdd={(row) => {
                          if (row.status.kind !== 'not-added') return;
                          setOpen(false);
                          setAddTarget({
                            catalogId: row.id,
                            displayName: row.displayName,
                            providerId: row.status.providerId,
                            capability,
                          });
                        }}
                      />
                    ))}
                  </div>
                ) : null}
                {configuredGroups.length === 0 &&
                discoveryGroups.length === 0 &&
                !discoveryPending ? (
                  <p className="model-selector-empty" role="status">
                    {query.trim() ? '没有匹配的模型' : '没有可选择的模型'}
                  </p>
                ) : null}
              </>
            )}
            {actionError ? <Alert showIcon type="error" title={actionError} /> : null}
          </div>
        }
      >
        <Button
          className="nodrag nopan nowheel model-selector-trigger"
          aria-label={
            !hasValue
              ? '选择模型'
              : hasValue && configurationPending
                ? '已选 正在读取所选模型'
                : described.detail
                  ? `已选 ${described.label}，${described.detail}`
                  : `已选 ${described.label}`
          }
          aria-expanded={open}
          title={configurationPending ? '正在读取所选模型' : described.title}
          disabled={actions.disabled}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <span className="model-selector-selection">
            <span className="model-selector-name">
              {hasValue && configurationPending ? '正在读取所选模型' : described.label}
            </span>
            {hasValue && !configurationPending && described.detail ? (
              <span className="model-selector-detail">{described.detail}</span>
            ) : null}
          </span>
        </Button>
      </Popover>
      {addTarget ? (
        <AddCatalogModel
          target={addTarget}
          providers={providerItems}
          onClose={() => setAddTarget(null)}
          onCreated={(model) => {
            cache.setQueryData<ManagedModelConfiguration[]>(modelKeys.models(userId), (current) => [
              model,
              ...(current ?? []).filter((item) => item.id !== model.id),
            ]);
            setAddTarget(null);
            actions.onSelectModel(nodeId, model.id);
          }}
        />
      ) : null}
    </>
  );
}
