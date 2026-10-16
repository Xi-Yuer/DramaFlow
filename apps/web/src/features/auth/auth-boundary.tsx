'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, Button, Spin } from 'antd';
import type { CurrentUser } from '@dramaflow/contracts';
import { ApiError } from '@/lib/http';
import { useIdentity } from './use-identity';

export function AuthBoundary({ children }: { children: (user: CurrentUser) => React.ReactNode }) {
  const identity = useIdentity();
  const router = useRouter();
  const anonymous = identity.error instanceof ApiError && identity.error.status === 401;
  useEffect(() => {
    if (anonymous) router.replace('/login');
  }, [anonymous, router]);
  if (identity.isPending || anonymous)
    return (
      <div className="page-loading">
        <Spin size="large" />
        <span>正在确认登录状态…</span>
      </div>
    );
  if (identity.error)
    return (
      <div className="page-loading">
        <Alert type="error" title={identity.error.message} showIcon />
        <Button onClick={() => void identity.refetch()}>重新连接</Button>
        <Button type="text" onClick={() => router.replace('/login')}>
          返回登录
        </Button>
      </div>
    );
  return children(identity.data);
}
