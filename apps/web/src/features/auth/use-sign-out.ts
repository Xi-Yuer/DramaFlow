'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { App } from 'antd';
import { authClient } from './auth-client';
import { useIdentity } from './use-identity';
import { clearUserInvocationReceipts } from '../workflow/run/recovery/invocation-receipts';

export function useSignOut() {
  const router = useRouter();
  const cache = useQueryClient();
  const { message } = App.useApp();
  const identity = useIdentity();
  const [signingOut, setSigningOut] = useState(false);
  async function signOut() {
    setSigningOut(true);
    try {
      const result = await authClient.signOut();
      if (result.error) {
        void message.error('退出未完成，请重试');
        return;
      }
      if (identity.data?.id) {
        try {
          clearUserInvocationReceipts(identity.data.id, () => window.localStorage);
        } catch {
          void message.warning(
            '已退出登录，但本地运行恢复标识清理未完成；其他用户不会加载这些标识。',
          );
        }
      }
      cache.clear();
      router.replace('/login');
    } catch {
      void message.error('无法连接认证服务，请稍后重试');
    } finally {
      setSigningOut(false);
    }
  }
  return { signOut, signingOut };
}
