'use client';
import { Alert, Button, Spin, Tabs } from 'antd';
import { RefreshCw } from 'lucide-react';
import type { ManagedModelConfiguration, ModelProvider } from '@dramaflow/contracts';
import { modelApi, modelKeys } from '../model-api';
import { findPlugin } from '../providers/provider-form-helpers';
import { ConfigureCatalogProviderForm } from '../providers/configure-catalog-provider-form';
import { ProviderCreateForm } from '../providers/provider-create-form';
import { CredentialRotationForm } from '../providers/credential-rotation-form';
import { ProviderManagementDialog } from '../providers/provider-management-dialog';
import { ModelCreateForm } from '../configurations/model-create-form';
import { ModelConfigurationList } from '../configurations/model-configuration-list';
import { ProviderCatalogPanel } from '../catalog/provider-catalog-panel';
import { useModelSettings } from './use-model-settings';
import type { ModelSettingsContentProps } from './model-settings-types';

export function ModelSettingsContent({
  userId,
  setupRequest,
  onIntentCancelled,
  onIntentProviderReady,
}: ModelSettingsContentProps) {
  const {
    cache,
    message,
    tab,
    setTab,
    form,
    setForm,
    busy,
    error,
    reading,
    readError,
    catalog,
    definitions,
    providers,
    models,
    refresh,
    reloadResources,
    action,
  } = useModelSettings({ userId, setupRequest });
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
          description={readError?.message ?? '无法读取模型配置'}
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
  return (
    <section className="model-settings-content">
      <div className="model-settings-heading">
        <div>
          <span className="model-project-name">我的模型</span>
          <h2>为我的工作流接入模型</h2>
          <p>在模型供应商里配置平台服务的访问凭证，再添加模型；自己创建的所有项目均可使用。</p>
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
                    () => modelApi.setProviderEnabled(provider.id, !provider.enabled),
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
              <ModelConfigurationList
                modelItems={modelItems}
                supplierItems={supplierItems}
                enabledSuppliers={enabledSuppliers}
                plugins={plugins}
                reading={reading}
                busy={busy}
                onAddModel={() => setForm({ kind: 'model' })}
                onShowProviders={() => setTab('providers')}
                onToggle={(model) =>
                  void action(
                    model.id,
                    () => modelApi.setModelEnabled(model.id, !model.enabled),
                    model.enabled ? '模型已停用' : '模型已启用',
                  )
                }
              />
            ),
          },
        ]}
      />
      {configuring ? (
        <ConfigureCatalogProviderForm
          provider={configuring}
          onClose={() => {
            if (
              setupRequest?.intent &&
              setupRequest.mode === 'configure' &&
              setupRequest.intent.providerDefinitionId === configuring.id
            )
              onIntentCancelled?.();
            setForm(null);
          }}
          onCreated={async (provider) => {
            cache.setQueryData<ModelProvider[]>(modelKeys.providers(userId), (current) => [
              provider,
              ...(current ?? []).filter((item) => item.id !== provider.id),
            ]);
            try {
              await reloadResources();
            } catch {
              // 供应商已经保存。列表随后由选择器重新读取。
            }
            void message.success('访问凭证已保存');
            const continueSelection =
              setupRequest?.intent &&
              setupRequest.mode === 'configure' &&
              setupRequest.intent.providerDefinitionId === configuring.id;
            if (continueSelection) onIntentProviderReady?.(provider);
            else setForm(null);
          }}
        />
      ) : null}
      {managing ? (
        <ProviderManagementDialog
          managing={managing}
          managingInstances={managingInstances}
          plugins={plugins}
          busy={busy}
          reading={reading}
          error={error}
          onClose={() => setForm(null)}
          onRefresh={refresh}
          onAddModel={(providerId) => setForm({ kind: 'model', providerId })}
          onRotate={(provider, fields) => setForm({ kind: 'rotate', provider, fields })}
          onToggle={(provider) =>
            void action(
              provider.id,
              () => modelApi.setProviderEnabled(provider.id, !provider.enabled),
              provider.enabled ? '供应商已停用' : '供应商已启用',
            )
          }
        />
      ) : null}
      {form?.kind === 'advanced' ? (
        <ProviderCreateForm
          plugins={plugins}
          onClose={() => setForm(null)}
          onCreated={(provider) => {
            cache.setQueryData<ModelProvider[]>(modelKeys.providers(userId), (current) => [
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
          providers={supplierItems}
          plugins={plugins}
          initialProviderId={form.providerId}
          onClose={() => setForm(null)}
          onCreated={(model) => {
            cache.setQueryData<ManagedModelConfiguration[]>(modelKeys.models(userId), (current) => [
              model,
              ...(current ?? []),
            ]);
            setTab('models');
            setForm(null);
            void message.success('模型配置已添加');
            void reloadResources();
          }}
        />
      ) : null}
      {form?.kind === 'rotate' ? (
        <CredentialRotationForm
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
