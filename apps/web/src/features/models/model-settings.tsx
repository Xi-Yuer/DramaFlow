'use client';
import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App, Button, Collapse, Drawer, Empty, Spin, Tabs, Tag } from 'antd';
import { Plus, RefreshCw } from 'lucide-react';
import type {
  ManagedModelConfiguration,
  ModelProvider,
  ProviderPluginDescription,
  ModelAvailability,
} from '@dramaflow/contracts';
import { modelApi, modelKeys } from './model-api';
import {
  CredentialRotationForm,
  findPlugin,
  ModelCreateForm,
  ProviderCreateForm,
} from './model-forms';
import { fieldLabel } from './schema-fields';
import './model-settings.css';

const reasons: Record<NonNullable<ModelAvailability['unavailableReason']>, string> = {
  MODEL_DISABLED: '模型已停用',
  PROVIDER_DISABLED: '供应商已停用',
  PLUGIN_UNAVAILABLE: '接入方式当前不可用',
  CAPABILITY_UNAVAILABLE: '接入方式当前不支持此能力',
  CONFIGURATION_INVALID: '配置与当前能力要求不匹配，请新建配置',
};
export function availabilityLabel(model: ManagedModelConfiguration) {
  return model.availability.selectable
    ? '可供工作流选择'
    : reasons[model.availability.unavailableReason!];
}
export function ModelSettings({
  open,
  projectId,
  projectName,
  onClose,
}: {
  open: boolean;
  projectId: string;
  projectName: string;
  onClose: () => void;
}) {
  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="模型设置"
      closable={{ 'aria-label': '关闭模型设置' }}
      placement="right"
      size={940}
      destroyOnHidden
      className="model-settings-drawer"
    >
      <ModelSettingsContent key={projectId} projectId={projectId} projectName={projectName} />
    </Drawer>
  );
}

type FormState =
  | { kind: 'provider' }
  | { kind: 'model'; providerId?: string }
  | { kind: 'rotate'; provider: ModelProvider; plugin: ProviderPluginDescription };
function ModelSettingsContent({
  projectId,
  projectName,
}: {
  projectId: string;
  projectName: string;
}) {
  const cache = useQueryClient(),
    { message } = App.useApp();
  const [tab, setTab] = useState('models'),
    [form, setForm] = useState<FormState | null>(null);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const locks = useRef(new Set<string>());
  const [error, setError] = useState<string | null>(null);
  const options = {
    retry: false,
    staleTime: 0,
    refetchOnMount: 'always' as const,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  };
  const catalog = useQuery({
    ...options,
    queryKey: modelKeys.catalog,
    queryFn: ({ signal }) => modelApi.catalog(signal),
  });
  const providers = useQuery({
    ...options,
    queryKey: modelKeys.providers(projectId),
    queryFn: ({ signal }) => modelApi.providers(projectId, signal),
  });
  const models = useQuery({
    ...options,
    queryKey: modelKeys.models(projectId),
    queryFn: ({ signal }) => modelApi.models(projectId, signal),
  });
  const reading = catalog.isFetching || providers.isFetching || models.isFetching;
  const readError = catalog.error || providers.error || models.error;
  async function refresh() {
    setError(null);
    await Promise.all([catalog.refetch(), providers.refetch(), models.refetch()]);
  }
  async function reloadResources() {
    await Promise.all([
      cache.invalidateQueries({ queryKey: modelKeys.providers(projectId) }),
      cache.invalidateQueries({ queryKey: modelKeys.models(projectId) }),
    ]);
  }
  async function action(id: string, apply: () => Promise<unknown>, success: string) {
    if (locks.current.has(id)) return;
    locks.current.add(id);
    setBusy(new Set(locks.current));
    setError(null);
    try {
      await apply();
      void message.success(success);
      await reloadResources();
    } catch (error) {
      setError(error instanceof Error ? error.message : '操作未确认，请刷新列表核对');
    } finally {
      locks.current.delete(id);
      setBusy(new Set(locks.current));
    }
  }
  if (catalog.isPending || providers.isPending || models.isPending)
    return (
      <div className="model-loading" role="status">
        <Spin />
        <span>正在读取模型设置…</span>
      </div>
    );
  if (readError || !catalog.data || !providers.data || !models.data)
    return (
      <div className="model-read-error">
        <Alert
          showIcon
          type="error"
          title="模型设置读取失败"
          description={readError?.message ?? '无法读取项目配置'}
        />
        <Button loading={reading} onClick={() => void refresh()}>
          重新读取模型设置
        </Button>
      </div>
    );
  const plugins = catalog.data.items;
  const supplierItems = providers.data;
  const modelItems = models.data;
  const enabledSuppliers = supplierItems.filter(
    (provider) => provider.enabled && findPlugin(plugins, provider),
  );
  const capabilityName = (model: ManagedModelConfiguration) => {
    const provider = supplierItems.find((item) => item.id === model.providerId);
    return (
      findPlugin(plugins, provider)?.capabilities.find((item) => item.type === model.capability)
        ?.name ?? model.capability
    );
  };
  return (
    <section className="model-settings-content">
      <div className="model-settings-heading">
        <div>
          <span className="model-project-name">{projectName}</span>
          <h2>为这个项目接入模型</h2>
          <p>先添加模型供应商，再在同一个服务地址下添加一个或多个模型。</p>
        </div>
        <Button icon={<RefreshCw size={15} />} loading={reading} onClick={() => void refresh()}>
          刷新列表
        </Button>
      </div>
      {!plugins.length ? (
        <Alert showIcon type="info" title="当前没有可配置的接入方式，请联系部署管理员" />
      ) : null}
      {error ? (
        <Alert
          showIcon
          type="error"
          title="操作未确认"
          description={error}
          action={
            <Button size="small" onClick={() => void refresh()}>
              重新读取
            </Button>
          }
        />
      ) : null}
      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={[
          {
            key: 'models',
            label: `模型（${modelItems.length}）`,
            children: (
              <div className="model-tab-content">
                <div className="model-section-heading">
                  <p>只有可选的模型，才能在后续工作流配置中使用。</p>
                  <Button
                    type="primary"
                    icon={<Plus size={15} />}
                    disabled={!enabledSuppliers.length || reading}
                    onClick={() => setForm({ kind: 'model' })}
                  >
                    添加模型
                  </Button>
                </div>
                {!modelItems.length ? (
                  <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description={
                      supplierItems.length
                        ? '还没有模型，为供应商添加第一个模型'
                        : '先接入一个模型供应商'
                    }
                  >
                    {!supplierItems.length ? (
                      <Button
                        type="primary"
                        disabled={!plugins.length}
                        onClick={() => setForm({ kind: 'provider' })}
                      >
                        添加供应商
                      </Button>
                    ) : !enabledSuppliers.length ? (
                      <Button onClick={() => setTab('providers')}>查看供应商状态</Button>
                    ) : null}
                  </Empty>
                ) : (
                  <div className="model-card-list">
                    {modelItems.map((model) => (
                      <article
                        className="model-config-card"
                        key={model.id}
                        aria-label={`模型 ${model.model}`}
                      >
                        <div className="model-card-heading">
                          <div>
                            <h3>{model.model}</h3>
                            <p>
                              {supplierItems.find((provider) => provider.id === model.providerId)
                                ?.name ?? '供应商信息待刷新'}{' '}
                              · {capabilityName(model)}
                            </p>
                          </div>
                          <Tag
                            color={
                              reading
                                ? undefined
                                : model.availability.selectable
                                  ? 'success'
                                  : 'default'
                            }
                          >
                            {reading ? '正在更新状态…' : availabilityLabel(model)}
                          </Tag>
                        </div>
                        <ConfigSummary values={model.settings} empty="使用服务默认参数" />
                        <div className="model-card-footer">
                          <span>{model.capability}</span>
                          <Button
                            size="small"
                            loading={busy.has(model.id)}
                            disabled={reading}
                            onClick={() =>
                              void action(
                                model.id,
                                () => modelApi.setModelEnabled(projectId, model.id, !model.enabled),
                                model.enabled ? '模型已停用' : '模型已启用',
                              )
                            }
                          >
                            {model.enabled ? '停用模型' : '启用模型'}
                          </Button>
                        </div>
                      </article>
                    ))}
                  </div>
                )}
                <p className="model-status-note">可选状态仅反映当前配置，不会发起模型调用。</p>
              </div>
            ),
          },
          {
            key: 'providers',
            label: `模型供应商（${supplierItems.length}）`,
            children: (
              <div className="model-tab-content">
                <div className="model-section-heading">
                  <p>供应商保存服务地址和凭证；一个供应商可以配置多个模型。</p>
                  <Button
                    type="primary"
                    icon={<Plus size={15} />}
                    disabled={!plugins.length || reading}
                    onClick={() => setForm({ kind: 'provider' })}
                  >
                    添加供应商
                  </Button>
                </div>
                {!supplierItems.length ? (
                  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未接入模型供应商" />
                ) : (
                  <div className="model-card-list">
                    {supplierItems.map((provider) => {
                      const plugin = findPlugin(plugins, provider);
                      return (
                        <article
                          className="model-config-card"
                          key={provider.id}
                          aria-label={`供应商 ${provider.name}`}
                        >
                          <div className="model-card-heading">
                            <div>
                              <h3>{provider.name}</h3>
                              <p>
                                {plugin?.name ?? provider.pluginId} · v{provider.pluginVersion}
                              </p>
                            </div>
                            <Tag color={provider.enabled ? 'success' : 'default'}>
                              {provider.enabled ? '已启用' : '已停用'}
                            </Tag>
                          </div>
                          <ConfigSummary values={provider.configuration} />
                          {!plugin ? (
                            <p className="model-unavailable-copy">
                              此接入方式当前不在可配置目录中，暂不能添加模型或轮换凭证。已有配置保留。
                            </p>
                          ) : null}
                          <div className="model-card-footer">
                            <span>访问凭证不提供读取</span>
                            <div className="model-card-actions">
                              <Button
                                size="small"
                                disabled={
                                  !plugin || !provider.enabled || busy.has(provider.id) || reading
                                }
                                onClick={() => setForm({ kind: 'model', providerId: provider.id })}
                              >
                                添加模型
                              </Button>
                              <Button
                                size="small"
                                disabled={!plugin || busy.has(provider.id) || reading}
                                onClick={() => {
                                  if (plugin) setForm({ kind: 'rotate', provider, plugin });
                                }}
                              >
                                轮换凭证
                              </Button>
                              <Button
                                size="small"
                                loading={busy.has(provider.id)}
                                disabled={reading}
                                onClick={() =>
                                  void action(
                                    provider.id,
                                    () =>
                                      modelApi.setProviderEnabled(
                                        projectId,
                                        provider.id,
                                        !provider.enabled,
                                      ),
                                    provider.enabled ? '供应商已停用' : '供应商已启用',
                                  )
                                }
                              >
                                {provider.enabled ? '停用供应商' : '启用供应商'}
                              </Button>
                            </div>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                )}
              </div>
            ),
          },
        ]}
      />
      <Collapse
        className="model-catalog"
        items={[
          {
            key: 'catalog',
            label: `可用接入方式（${plugins.length}）`,
            children: !plugins.length ? (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="当前没有可配置的接入方式，请联系部署管理员"
              />
            ) : (
              <div className="model-catalog-items">
                {plugins.map((plugin) => (
                  <article key={`${plugin.id}-${plugin.version}`}>
                    <h3>
                      {plugin.name} <span>v{plugin.version}</span>
                    </h3>
                    <p>{plugin.description}</p>
                    <div>
                      {plugin.capabilities.map((capability) => (
                        <Tag key={capability.type}>
                          {capability.name} · {capability.type}
                        </Tag>
                      ))}
                    </div>
                  </article>
                ))}
              </div>
            ),
          },
        ]}
      />
      {form?.kind === 'provider' ? (
        <ProviderCreateForm
          projectId={projectId}
          plugins={plugins}
          onClose={() => setForm(null)}
          onCreated={(provider) => {
            cache.setQueryData<ModelProvider[]>(modelKeys.providers(projectId), (current) => [
              provider,
              ...(current ?? []),
            ]);
            setTab('models');
            setForm({ kind: 'model', providerId: provider.id });
            void message.success('供应商已添加，接下来添加模型');
            void reloadResources();
          }}
        />
      ) : null}
      {form?.kind === 'model' ? (
        <ModelCreateForm
          projectId={projectId}
          providers={supplierItems}
          plugins={plugins}
          initialProviderId={form.providerId}
          onClose={() => setForm(null)}
          onCreated={(model) => {
            cache.setQueryData<ManagedModelConfiguration[]>(
              modelKeys.models(projectId),
              (current) => [model, ...(current ?? [])],
            );
            setTab('models');
            setForm(null);
            void message.success('模型配置已添加');
            void reloadResources();
          }}
        />
      ) : null}
      {form?.kind === 'rotate' ? (
        <CredentialRotationForm
          projectId={projectId}
          provider={form.provider}
          plugin={form.plugin}
          onClose={() => setForm(null)}
          onRotated={() => {
            setForm(null);
            void message.success('访问凭证已轮换');
          }}
        />
      ) : null}
    </section>
  );
}
function ConfigSummary({ values, empty }: { values: Record<string, unknown>; empty?: string }) {
  const entries = Object.entries(values);
  return entries.length ? (
    <dl className="model-config-summary">
      {entries.map(([key, value]) => (
        <div key={key}>
          <dt>{fieldLabel(key)}</dt>
          <dd>
            {typeof value === 'boolean'
              ? value
                ? '是'
                : '否'
              : typeof value === 'string' || typeof value === 'number'
                ? String(value)
                : JSON.stringify(value)}
          </dd>
        </div>
      ))}
    </dl>
  ) : empty ? (
    <p className="model-status-note">{empty}</p>
  ) : null;
}
