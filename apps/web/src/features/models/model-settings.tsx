'use client';
import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App, Button, Drawer, Empty, Modal, Spin, Tabs, Tag } from 'antd';
import { Plus, RefreshCw } from 'lucide-react';
import type {
  ManagedModelConfiguration,
  ModelProvider,
  ProviderCatalogItem,
  ProviderPluginDescription,
  ModelAvailability,
} from '@dramaflow/contracts';
import { modelApi, modelKeys } from './model-api';
import {
  ConfigureCatalogProviderForm,
  CredentialRotationForm,
  credentialSubmitLabel,
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
  setupRequest = null,
  onClose,
}: {
  open: boolean;
  projectId: string;
  projectName: string;
  setupRequest?: { definitionId: string; mode: 'configure' | 'manage' } | null;
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
      <ModelSettingsContent
        key={projectId}
        projectId={projectId}
        projectName={projectName}
        setupRequest={setupRequest}
      />
    </Drawer>
  );
}

type FormState =
  | { kind: 'configure'; definitionId: string }
  | { kind: 'manage'; definitionId: string }
  | { kind: 'advanced' }
  | { kind: 'model'; providerId?: string }
  | {
      kind: 'rotate';
      provider: ModelProvider;
      fields: ProviderCatalogItem['credentialFields'];
    };
function ModelSettingsContent({
  projectId,
  projectName,
  setupRequest,
}: {
  projectId: string;
  projectName: string;
  setupRequest: { definitionId: string; mode: 'configure' | 'manage' } | null;
}) {
  const cache = useQueryClient(),
    { message } = App.useApp();
  const [tab, setTab] = useState('providers'),
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
  const definitions = useQuery({
    ...options,
    queryKey: modelKeys.providerCatalog,
    queryFn: ({ signal }) => modelApi.providerCatalog(signal),
  });
  const setupToken = setupRequest ? `${setupRequest.mode}:${setupRequest.definitionId}` : null;
  const [appliedSetup, setAppliedSetup] = useState<string | null>(null);
  if (definitions.data && setupToken !== appliedSetup) {
    setAppliedSetup(setupToken);
    if (
      setupRequest &&
      definitions.data.items.some((item) => item.id === setupRequest.definitionId)
    ) {
      setTab('providers');
      setForm(
        setupRequest.mode === 'configure'
          ? { kind: 'configure', definitionId: setupRequest.definitionId }
          : { kind: 'manage', definitionId: setupRequest.definitionId },
      );
    }
  }
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
  const reading =
    catalog.isFetching || definitions.isFetching || providers.isFetching || models.isFetching;
  const readError = catalog.error || definitions.error || providers.error || models.error;
  async function refresh() {
    setError(null);
    await Promise.all([
      cache.invalidateQueries({ queryKey: modelKeys.catalog }),
      cache.invalidateQueries({ queryKey: modelKeys.providerCatalog }),
      cache.invalidateQueries({ queryKey: modelKeys.providers(projectId) }),
      cache.invalidateQueries({ queryKey: modelKeys.models(projectId) }),
    ]);
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
  if (catalog.isPending || definitions.isPending || providers.isPending || models.isPending)
    return (
      <div className="model-loading" role="status">
        <Spin />
        <span>正在读取模型设置…</span>
      </div>
    );
  if (readError || !catalog.data || !definitions.data || !providers.data || !models.data)
    return (
      <div className="model-read-error">
        <Alert
          showIcon
          type="error"
          title="模型设置读取失败"
          description={readError?.message ?? '无法读取项目配置'}
        />
        <Button htmlType="button" onClick={() => void refresh()}>
          重新读取模型设置
        </Button>
      </div>
    );
  const plugins = catalog.data.items;
  const services = definitions.data.items;
  const supplierItems = providers.data;
  const catalogIds = new Set(services.map((item) => item.id));
  const customSuppliers = supplierItems.filter(
    (provider) =>
      provider.providerDefinitionId === null || !catalogIds.has(provider.providerDefinitionId),
  );
  const modelItems = models.data;
  const enabledSuppliers = supplierItems.filter(
    (provider) => provider.enabled && findPlugin(plugins, provider),
  );
  const configuring =
    form?.kind === 'configure' ? services.find((item) => item.id === form.definitionId) : undefined;
  const managing =
    form?.kind === 'manage' ? services.find((item) => item.id === form.definitionId) : undefined;
  const managingInstances = managing
    ? supplierItems.filter((provider) => provider.providerDefinitionId === managing.id)
    : [];
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
          <p>在模型供应商里配置平台服务的访问凭证，再添加项目要用的模型。</p>
        </div>
        <Button icon={<RefreshCw size={15} />} loading={reading} onClick={() => void refresh()}>
          刷新列表
        </Button>
      </div>
      {!services.length && !plugins.length ? (
        <Alert showIcon type="info" title="当前没有可配置的模型服务，请联系部署管理员" />
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
            key: 'providers',
            label: '模型供应商',
            children: (
              <ProviderCatalogPanel
                services={services}
                suppliers={supplierItems}
                customSuppliers={customSuppliers}
                plugins={plugins}
                reading={reading}
                busy={busy}
                onConfigure={(definitionId) => setForm({ kind: 'configure', definitionId })}
                onManage={(definitionId) => setForm({ kind: 'manage', definitionId })}
                onAdvanced={() => setForm({ kind: 'advanced' })}
                onAddModel={(providerId) => setForm({ kind: 'model', providerId })}
                onRotate={(provider, fields) => setForm({ kind: 'rotate', provider, fields })}
                onToggle={(provider) =>
                  void action(
                    provider.id,
                    () => modelApi.setProviderEnabled(projectId, provider.id, !provider.enabled),
                    provider.enabled ? '供应商已停用' : '供应商已启用',
                  )
                }
              />
            ),
          },
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
                        : '先在模型供应商中配置服务'
                    }
                  >
                    {!supplierItems.length ? (
                      <Button onClick={() => setTab('providers')}>前往模型供应商</Button>
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
        ]}
      />
      {configuring ? (
        <ConfigureCatalogProviderForm
          projectId={projectId}
          provider={configuring}
          onClose={() => setForm(null)}
          onCreated={(provider) => {
            cache.setQueryData<ModelProvider[]>(modelKeys.providers(projectId), (current) => [
              provider,
              ...(current ?? []).filter((item) => item.id !== provider.id),
            ]);
            setForm(null);
            void message.success('访问凭证已保存');
            void reloadResources();
          }}
        />
      ) : null}
      {managing ? (
        <Modal
          open
          title={`管理 ${managing.displayName}`}
          onCancel={() => setForm(null)}
          maskClosable={false}
          destroyOnHidden
          footer={[
            <Button key="close" onClick={() => setForm(null)}>
              返回列表
            </Button>,
          ]}
        >
          <p className="model-form-copy">
            支持：{managing.capabilities.map((capability) => capability.name).join('、')}
            。访问凭证不提供读取。
          </p>
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
          <div className="model-manage-list">
            {managingInstances.map((provider) => {
              const plugin = findPlugin(plugins, provider);
              return (
                <div key={provider.id} className="model-manage-instance">
                  {managingInstances.length > 1 ? <h3>{provider.name}</h3> : null}
                  {!plugin ? (
                    <p className="model-unavailable-copy">
                      此接入方式当前不可用，暂不能添加模型。已有配置保留。
                    </p>
                  ) : null}
                  <div className="model-card-actions">
                    <Button
                      size="small"
                      disabled={!plugin || !provider.enabled || busy.has(provider.id) || reading}
                      onClick={() => setForm({ kind: 'model', providerId: provider.id })}
                    >
                      添加模型
                    </Button>
                    <Button
                      size="small"
                      disabled={
                        !managing.credentialFields.length || busy.has(provider.id) || reading
                      }
                      onClick={() =>
                        setForm({
                          kind: 'rotate',
                          provider,
                          fields: managing.credentialFields,
                        })
                      }
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
                            modelApi.setProviderEnabled(projectId, provider.id, !provider.enabled),
                          provider.enabled ? '供应商已停用' : '供应商已启用',
                        )
                      }
                    >
                      {provider.enabled ? '停用供应商' : '启用供应商'}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </Modal>
      ) : null}
      {form?.kind === 'advanced' ? (
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
          fields={form.fields}
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
function ProviderCatalogPanel({
  services,
  suppliers,
  customSuppliers,
  plugins,
  reading,
  busy,
  onConfigure,
  onManage,
  onAdvanced,
  onAddModel,
  onRotate,
  onToggle,
}: {
  services: ProviderCatalogItem[];
  suppliers: ModelProvider[];
  customSuppliers: ModelProvider[];
  plugins: ProviderPluginDescription[];
  reading: boolean;
  busy: ReadonlySet<string>;
  onConfigure: (definitionId: string) => void;
  onManage: (definitionId: string) => void;
  onAdvanced: () => void;
  onAddModel: (providerId: string) => void;
  onRotate: (provider: ModelProvider, fields: ProviderCatalogItem['credentialFields']) => void;
  onToggle: (provider: ModelProvider) => void;
}) {
  return (
    <div className="model-tab-content">
      <div className="model-section-heading">
        <p>选择平台提供的模型服务，填写它要求的访问凭证。</p>
      </div>
      {!services.length ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="当前没有可选择的模型服务，请联系部署管理员"
        />
      ) : (
        <div className="model-card-list">
          {services.map((service) => {
            const matched = suppliers.filter(
              (provider) => provider.providerDefinitionId === service.id,
            );
            const configured = matched.length > 0;
            const suspended = configured && matched.every((provider) => !provider.enabled);
            return (
              <article
                className="model-config-card"
                key={service.id}
                aria-label={`供应商 ${service.displayName}`}
              >
                <div className="model-card-heading">
                  <div>
                    <h3>{service.displayName}</h3>
                    <p>
                      支持：{service.capabilities.map((capability) => capability.name).join('、')}
                    </p>
                  </div>
                  <div className="model-card-tags">
                    <Tag color={configured ? 'success' : undefined}>
                      {configured ? '已配置' : '未配置'}
                    </Tag>
                    {suspended ? <Tag>已停用</Tag> : null}
                  </div>
                </div>
                {!service.available && !configured ? (
                  <p className="model-unavailable-copy">此服务当前不可配置。</p>
                ) : null}
                <div className="model-card-footer">
                  <span>{configured ? '访问凭证不提供读取' : '尚未填写访问凭证'}</span>
                  {configured ? (
                    <Button
                      size="small"
                      type="primary"
                      autoInsertSpace={false}
                      disabled={reading}
                      onClick={() => onManage(service.id)}
                    >
                      管理
                    </Button>
                  ) : (
                    <Button
                      size="small"
                      type="primary"
                      disabled={!service.available || !service.credentialFields.length || reading}
                      onClick={() => onConfigure(service.id)}
                    >
                      {credentialSubmitLabel(service.credentialFields, 'configure')}
                    </Button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
      <div className="model-advanced-entry">
        <div>
          <h3>自定义接入</h3>
          <p>自行指定兼容服务地址。</p>
        </div>
        <Button disabled={!plugins.length || reading} onClick={onAdvanced}>
          自定义接入
        </Button>
      </div>
      {customSuppliers.length ? (
        <div className="model-card-list">
          {customSuppliers.map((provider) => {
            const plugin = findPlugin(plugins, provider);
            return (
              <article
                className="model-config-card"
                key={provider.id}
                aria-label={`自定义供应商 ${provider.name}`}
              >
                <div className="model-card-heading">
                  <div>
                    <h3>{provider.name}</h3>
                    <p>
                      {plugin
                        ? `支持：${plugin.capabilities.map((capability) => capability.name).join('、')}`
                        : '当前接入方式不可用'}
                    </p>
                  </div>
                  <Tag color={provider.enabled ? 'success' : undefined}>
                    {provider.enabled ? '已启用' : '已停用'}
                  </Tag>
                </div>
                {provider.providerDefinitionId === null ? (
                  <ConfigSummary values={provider.configuration} />
                ) : null}
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
                      disabled={!plugin || !provider.enabled || busy.has(provider.id) || reading}
                      onClick={() => onAddModel(provider.id)}
                    >
                      添加模型
                    </Button>
                    <Button
                      size="small"
                      disabled={!plugin || busy.has(provider.id) || reading}
                      onClick={() => {
                        if (plugin) onRotate(provider, plugin.credentialFields);
                      }}
                    >
                      轮换凭证
                    </Button>
                    <Button
                      size="small"
                      loading={busy.has(provider.id)}
                      disabled={reading}
                      onClick={() => onToggle(provider)}
                    >
                      {provider.enabled ? '停用供应商' : '启用供应商'}
                    </Button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      ) : null}
    </div>
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
