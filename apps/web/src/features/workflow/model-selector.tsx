'use client';

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Form, Input, Modal, Popover, Spin } from 'antd';
import { Check } from 'lucide-react';
import { z } from 'zod';
import type { ManagedModelConfiguration, ModelProvider } from '@dramaflow/contracts';
import { ApiError } from '../../lib/http';
import { modelApi, modelKeys } from '../models/model-api';
import { SchemaFormFields } from '../models/schema-form';
import { trySchemaFields } from '../models/schema-fields';
import {
  describeSelection,
  filterConfiguredGroups,
  filterSelectorGroups,
  groupConfiguredModels,
  groupSelectorModels,
  modelsForCapabilities,
  resumeModelSelection,
  type SelectorGroup,
  type ConfiguredSelectorGroup,
  type SelectorModelRow,
} from './model-selector-options';
import './model-selector.css';

export interface ModelSelectionIntent {
  nodeId: string;
  catalogId: string;
  displayName: string;
  providerDefinitionId: string;
  capability: string;
}

export interface ModelSelectionResume extends ModelSelectionIntent {
  providerId: string;
  resumedAt: number;
}

export interface WorkflowModelActions {
  projectId: string;
  disabled: boolean;
  onSelectModel: (nodeId: string, modelConfigurationId: string) => void;
  onOpenProvider: (
    providerDefinitionId: string,
    mode: 'configure' | 'manage',
    intent?: ModelSelectionIntent,
  ) => void;
  resume: ModelSelectionResume | null;
  onResumeConsumed: () => void;
}

export const WorkflowModelActionsContext = createContext<WorkflowModelActions | null>(null);

const queryOptions = {
  retry: false,
  staleTime: 0,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
};

function useClient() {
  return useSyncExternalStore(
    () => () => undefined,
    () => true,
    () => false,
  );
}

function failure(error: unknown) {
  return error instanceof Error ? error.message : '请求未完成';
}

export function ModelSelector({
  nodeId,
  capabilityTypes,
  value,
}: {
  nodeId: string;
  capabilityTypes: readonly string[];
  value: unknown;
}) {
  const actions = useContext(WorkflowModelActionsContext);
  const cache = useQueryClient();
  const client = useClient();
  const hasValue = typeof value === 'string' && value.length > 0;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [addTarget, setAddTarget] = useState<{
    catalogId: string;
    displayName: string;
    providerId: string;
    capability: string;
  } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [handledResumeId, setHandledResumeId] = useState<string | null>(null);
  const resume = actions?.resume?.nodeId === nodeId ? actions.resume : null;
  const resumeId = resume ? `${resume.providerId}:${resume.catalogId}` : null;
  const enabled =
    Boolean(actions) &&
    client &&
    capabilityTypes.length > 0 &&
    (open || hasValue || addTarget !== null || resume !== null);
  const catalogQueries = useQueries({
    queries: capabilityTypes.map((capability) => ({
      ...queryOptions,
      queryKey: modelKeys.modelCatalog(capability),
      queryFn: ({ signal }: { signal: AbortSignal }) => modelApi.modelCatalog(capability, signal),
      enabled,
    })),
  });
  const definitions = useQuery({
    ...queryOptions,
    queryKey: modelKeys.providerCatalog,
    queryFn: ({ signal }) => modelApi.providerCatalog(signal),
    enabled,
  });
  const providers = useQuery({
    ...queryOptions,
    queryKey: modelKeys.providers(actions?.projectId ?? ''),
    queryFn: ({ signal }) => modelApi.providers(actions!.projectId, signal),
    enabled: enabled && Boolean(actions),
  });
  const models = useQuery({
    ...queryOptions,
    queryKey: modelKeys.models(actions?.projectId ?? ''),
    queryFn: ({ signal }) => modelApi.models(actions!.projectId, signal),
    enabled: enabled && Boolean(actions),
  });
  const resumeReady =
    resume !== null &&
    !actions?.disabled &&
    models.isSuccess &&
    providers.isSuccess &&
    !models.isFetching &&
    !providers.isFetching &&
    models.dataUpdatedAt >= resume.resumedAt &&
    providers.dataUpdatedAt >= resume.resumedAt &&
    (providers.data ?? []).some((item) => item.id === resume.providerId && item.enabled);
  const decision =
    resume && resumeReady
      ? resumeModelSelection({
          providerId: resume.providerId,
          catalogId: resume.catalogId,
          capability: resume.capability,
          configurations: models.data ?? [],
        })
      : null;
  const selectId = decision?.kind === 'select' ? decision.configurationId : null;
  if (decision && resume && resumeId && handledResumeId !== resumeId) {
    setHandledResumeId(resumeId);
    if (decision.kind === 'add') {
      setAddTarget({
        catalogId: resume.catalogId,
        displayName: resume.displayName,
        providerId: resume.providerId,
        capability: resume.capability,
      });
    }
    if (decision.kind === 'choose') {
      setOpen(true);
      setQuery(resume.displayName);
    }
  }
  const onSelectModel = actions?.onSelectModel;
  const onResumeConsumed = actions?.onResumeConsumed;
  useEffect(() => {
    if (!resumeId || handledResumeId !== resumeId || !onResumeConsumed) return;
    if (selectId) onSelectModel?.(nodeId, selectId);
    onResumeConsumed();
  }, [handledResumeId, nodeId, onResumeConsumed, onSelectModel, resumeId, selectId]);
  if (actions?.disabled && open) setOpen(false);

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

  function select(configurationId: string) {
    actions!.onSelectModel(nodeId, configurationId);
    setOpen(false);
    setQuery('');
  }

  async function enable(configurationId: string) {
    if (busyId) return;
    setBusyId(configurationId);
    setActionError(null);
    try {
      await modelApi.setModelEnabled(actions!.projectId, configurationId, true);
      await cache.invalidateQueries({ queryKey: modelKeys.models(actions!.projectId) });
      select(configurationId);
    } catch (error) {
      setActionError(failure(error));
    } finally {
      setBusyId(null);
    }
  }

  function reload() {
    for (const item of catalogQueries) void item.refetch();
    void definitions.refetch();
    void providers.refetch();
    void models.refetch();
  }

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
                title="项目模型配置读取失败"
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
          projectId={actions.projectId}
          target={addTarget}
          providers={providerItems}
          onClose={() => setAddTarget(null)}
          onCreated={(model) => {
            cache.setQueryData<ManagedModelConfiguration[]>(
              modelKeys.models(actions.projectId),
              (current) => [model, ...(current ?? []).filter((item) => item.id !== model.id)],
            );
            setAddTarget(null);
            actions.onSelectModel(nodeId, model.id);
          }}
        />
      ) : null}
    </>
  );
}

function EnableModelButton({
  name,
  configurationId,
  busy,
  onEnable,
}: {
  name: string;
  configurationId: string;
  busy: boolean;
  onEnable: (configurationId: string) => void;
}) {
  return (
    <Button
      size="small"
      autoInsertSpace={false}
      aria-label={`启用 ${name}`}
      loading={busy}
      onClick={() => onEnable(configurationId)}
    >
      启用
    </Button>
  );
}

export function ConfiguredModelGroup({
  group,
  selectedId,
  onSelect,
}: {
  group: ConfiguredSelectorGroup;
  selectedId: string | undefined;
  onSelect: (configurationId: string) => void;
}) {
  return (
    <div role="group" aria-label={group.providerName}>
      <h3>{group.providerName}</h3>
      <ul>
        {group.models.map((model) => {
          const selected = model.configurationId === selectedId;
          return (
            <li key={model.configurationId}>
              <button
                type="button"
                className="model-selector-option"
                role="option"
                aria-selected={selected}
                data-configuration-id={model.configurationId}
                onClick={() => onSelect(model.configurationId)}
              >
                <span className="model-selector-name">{model.displayName}</span>
                <span className="model-selector-state">
                  {selected ? <Check size={14} aria-hidden="true" /> : null}
                  可用
                </span>
                {model.detail ? <small>{model.detail}</small> : null}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function modelStatusLabel(kind: Exclude<SelectorModelRow['status']['kind'], 'available'>) {
  if (kind === 'not-added') return '尚未添加';
  if (kind === 'unconfigured') return '未配置';
  return '已停用';
}

function ModelGroup({
  group,
  selectedId,
  busyId,
  onSelect,
  onEnable,
  onConfigure,
  onManage,
  onAdd,
}: {
  group: SelectorGroup;
  selectedId: string | undefined;
  busyId: string | null;
  onSelect: (configurationId: string) => void;
  onEnable: (configurationId: string) => void;
  onConfigure: (row: SelectorModelRow) => void;
  onManage: () => void;
  onAdd: (row: SelectorModelRow) => void;
}) {
  return (
    <div role="group" aria-label={group.providerName}>
      <h3>{group.providerName}</h3>
      <ul>
        {group.models.map((model) => (
          <li key={model.id}>
            {model.status.kind === 'available' ? (
              model.status.choices.map((choice) => {
                const selected = choice.configurationId === selectedId;
                return (
                  <button
                    key={choice.configurationId}
                    type="button"
                    className="model-selector-option"
                    role="option"
                    aria-selected={selected}
                    onClick={() => onSelect(choice.configurationId)}
                  >
                    <span className="model-selector-name">{model.displayName}</span>
                    <span className="model-selector-state">
                      {selected ? <Check size={14} aria-hidden="true" /> : null}
                      可用
                    </span>
                    {choice.detail ? <small>{choice.detail}</small> : null}
                  </button>
                );
              })
            ) : (
              <div className="model-selector-static">
                <span className="model-selector-name">{model.displayName}</span>
                <span className="model-selector-state pending">
                  {modelStatusLabel(model.status.kind)}
                </span>
                <div className="model-selector-actions">
                  {model.status.kind === 'unconfigured' ? (
                    <Button
                      size="small"
                      autoInsertSpace={false}
                      aria-label={`配置 ${group.providerName}`}
                      onClick={() => onConfigure(model)}
                    >
                      配置
                    </Button>
                  ) : null}
                  {model.status.kind === 'provider-disabled' ? (
                    <Button
                      size="small"
                      autoInsertSpace={false}
                      aria-label={`管理 ${group.providerName}`}
                      onClick={onManage}
                    >
                      管理
                    </Button>
                  ) : null}
                  {model.status.kind === 'disabled' ? (
                    <EnableModelButton
                      name={model.displayName}
                      configurationId={model.status.configurationId}
                      busy={busyId === model.status.configurationId}
                      onEnable={onEnable}
                    />
                  ) : null}
                  {model.status.kind === 'not-added' ? (
                    <Button
                      size="small"
                      autoInsertSpace={false}
                      aria-label={`添加 ${model.displayName}`}
                      onClick={() => onAdd(model)}
                    >
                      添加
                    </Button>
                  ) : null}
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function AddCatalogModel({
  projectId,
  target,
  providers,
  onClose,
  onCreated,
}: {
  projectId: string;
  target: { catalogId: string; displayName: string; providerId: string; capability: string };
  providers: readonly ModelProvider[];
  onClose: () => void;
  onCreated: (model: ManagedModelConfiguration) => void;
}) {
  const plugins = useQuery({
    ...queryOptions,
    queryKey: modelKeys.catalog,
    queryFn: ({ signal }) => modelApi.catalog(signal),
  });
  const [form] = Form.useForm();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lock = useRef(false);
  const provider = providers.find((item) => item.id === target.providerId);
  const plugin = plugins.data?.items.find(
    (item) => item.id === provider?.pluginId && item.version === provider.pluginVersion,
  );
  const capability = plugin?.capabilities.find((item) => item.type === target.capability);
  const compiled = capability ? trySchemaFields(capability.modelSettingsSchema) : null;

  async function submit() {
    if (lock.current || !provider?.enabled || !compiled?.form) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    let sent = false;
    try {
      const values: unknown = await form.validateFields();
      const settings = compiled.form.validate(
        z.object({ settings: z.unknown() }).parse(values).settings,
      );
      sent = true;
      onCreated(
        await modelApi.createModel(projectId, {
          providerId: provider.id,
          capability: target.capability,
          model: target.catalogId,
          settings,
        }),
      );
    } catch (error) {
      if (sent)
        setError(error instanceof ApiError ? error.message : '模型配置未确认，请刷新后核对');
      else if (!(error instanceof Object && 'errorFields' in error)) setError('请检查生成参数');
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  let body: ReactNode;
  if (plugins.isPending) body = <Spin size="small" />;
  else if (plugins.isError) body = <Alert showIcon type="error" title={failure(plugins.error)} />;
  else if (!provider?.enabled) body = <Alert showIcon type="warning" title="供应商当前不可用" />;
  else if (!compiled?.form)
    body = <Alert showIcon type="error" title={compiled?.error ?? '当前无法添加该模型'} />;
  else
    body = (
      <Form
        form={form}
        layout="vertical"
        requiredMark={false}
        initialValues={{ settings: compiled.form.defaults }}
      >
        <SchemaFormFields schema={compiled.form} group="settings" disabled={busy} />
      </Form>
    );

  return (
    <Modal
      open
      title={`添加 ${target.displayName}`}
      onCancel={onClose}
      closable={!busy}
      maskClosable={false}
      keyboard={!busy}
      destroyOnHidden
      footer={[
        <Button key="cancel" autoInsertSpace={false} disabled={busy} onClick={onClose}>
          取消
        </Button>,
        <Button
          key="submit"
          type="primary"
          aria-label="添加并选择"
          loading={busy}
          disabled={busy || !compiled?.form || !provider?.enabled}
          onClick={() => void submit()}
        >
          添加并选择
        </Button>,
      ]}
    >
      <p className="model-selector-note">填写该模型在当前项目中的生成参数。节点只保存这次选择。</p>
      {body}
      {error ? <Alert showIcon type="error" title="模型配置未确认" description={error} /> : null}
    </Modal>
  );
}
