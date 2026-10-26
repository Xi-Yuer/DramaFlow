import { Alert, Button, Modal } from 'antd';
import type {
  ModelProvider,
  ProviderCatalogItem,
  ProviderPluginDescription,
} from '@dramaflow/contracts';
import { findPlugin } from './provider-form-helpers';

export function ProviderManagementDialog({
  managing,
  managingInstances,
  plugins,
  busy,
  reading,
  error,
  onClose,
  onRefresh,
  onAddModel,
  onRotate,
  onToggle,
}: {
  managing: ProviderCatalogItem;
  managingInstances: ModelProvider[];
  plugins: ProviderPluginDescription[];
  busy: ReadonlySet<string>;
  reading: boolean;
  error: string | null;
  onClose: () => void;
  onRefresh: () => Promise<void>;
  onAddModel: (providerId: string) => void;
  onRotate: (provider: ModelProvider, fields: ProviderCatalogItem['credentialFields']) => void;
  onToggle: (provider: ModelProvider) => void;
}) {
  return (
    <Modal
      open
      title={`管理 ${managing.displayName}`}
      onCancel={onClose}
      destroyOnHidden
      footer={[
        <Button key="close" onClick={onClose}>
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
            <Button size="small" onClick={() => void onRefresh()}>
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
                  onClick={() => onAddModel(provider.id)}
                >
                  添加模型
                </Button>
                <Button
                  size="small"
                  disabled={!managing.credentialFields.length || busy.has(provider.id) || reading}
                  onClick={() => onRotate(provider, managing.credentialFields)}
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
          );
        })}
      </div>
    </Modal>
  );
}
