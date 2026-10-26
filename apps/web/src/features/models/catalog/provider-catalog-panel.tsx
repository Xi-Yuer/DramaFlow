import { Button, Empty, Tag } from 'antd';
import type {
  ModelProvider,
  ProviderCatalogItem,
  ProviderPluginDescription,
} from '@dramaflow/contracts';
import { credentialSubmitLabel, findPlugin } from '../providers/provider-form-helpers';
import { ConfigSummary } from '../shared/config-summary';

export function ProviderCatalogPanel({
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
