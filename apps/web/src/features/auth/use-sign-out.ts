'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { App } from 'antd';
import { authClient } from './auth-client';

export function useSignOut() {
  const router = useRouter();
  const cache = useQueryClient();
  const { message } = App.useApp();
  const [signingOut, setSigningOut] = useState(false);
  async function signOut() {
    setSigningOut(true);
    try {
      const result = await authClient.signOut();
      if (result.error) {
        void message.error('退出未完成，请重试');
        return;
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
