import { Button, Empty, Tag } from 'antd';
import { Plus } from 'lucide-react';
import type {
  ManagedModelConfiguration,
  ModelProvider,
  ProviderPluginDescription,
} from '@dramaflow/contracts';
import { availabilityLabel } from './model-availability';
import { findPlugin } from '../providers/provider-form-helpers';
import { ConfigSummary } from '../shared/config-summary';

export function ModelConfigurationList({
  modelItems,
  supplierItems,
  enabledSuppliers,
  plugins,
  reading,
  busy,
  onAddModel,
  onShowProviders,
  onToggle,
}: {
  modelItems: ManagedModelConfiguration[];
  supplierItems: ModelProvider[];
  enabledSuppliers: ModelProvider[];
  plugins: ProviderPluginDescription[];
  reading: boolean;
  busy: ReadonlySet<string>;
  onAddModel: () => void;
  onShowProviders: () => void;
  onToggle: (model: ManagedModelConfiguration) => void;
}) {
  const capabilityName = (model: ManagedModelConfiguration) => {
    const provider = supplierItems.find((item) => item.id === model.providerId);
    return (
      findPlugin(plugins, provider)?.capabilities.find((item) => item.type === model.capability)
        ?.name ?? model.capability
    );
  };
  return (
    <div className="model-tab-content">
      <div className="model-section-heading">
        <p>只有可选的模型，才能在后续工作流配置中使用。</p>
        <Button
          type="primary"
          icon={<Plus size={15} />}
          disabled={!enabledSuppliers.length || reading}
          onClick={onAddModel}
        >
          添加模型
        </Button>
      </div>
      {!modelItems.length ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            supplierItems.length ? '还没有模型，为供应商添加第一个模型' : '先在模型供应商中配置服务'
          }
        >
          {!supplierItems.length ? (
            <Button onClick={onShowProviders}>前往模型供应商</Button>
          ) : !enabledSuppliers.length ? (
            <Button onClick={onShowProviders}>查看供应商状态</Button>
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
                    {supplierItems.find((provider) => provider.id === model.providerId)?.name ??
                      '供应商信息待刷新'}{' '}
                    · {capabilityName(model)}
                  </p>
                </div>
                <Tag
                  color={
                    reading ? undefined : model.availability.selectable ? 'success' : 'default'
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
                  onClick={() => onToggle(model)}
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
  );
}
