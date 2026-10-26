'use client';
import { Drawer } from 'antd';
import { useIdentity } from '../auth/use-identity';
import { ModelSettingsContent } from './settings/model-settings-content';
import type { ModelSettingsProps } from './settings/model-settings-types';
import './model-settings.css';

export { availabilityLabel } from './configurations/model-availability';

export function ModelSettings({
  open,
  setupRequest = null,
  onIntentCancelled,
  onIntentProviderReady,
  onClose,
}: ModelSettingsProps) {
  const identity = useIdentity();
  const userId = identity.data?.id;
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
      {userId ? (
        <ModelSettingsContent
          key={userId}
          userId={userId}
          setupRequest={setupRequest}
          onIntentCancelled={onIntentCancelled}
          onIntentProviderReady={onIntentProviderReady}
        />
      ) : null}
    </Drawer>
  );
}
