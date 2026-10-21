'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, Button, Spin } from 'antd';
import type { CurrentUser } from '@dramaflow/contracts';
import { ApiError } from '@/lib/http';
import { useIdentity } from './use-identity';

export function AuthBoundary({
  children,
  preserveEditsOnTransientError = false,
}: {
  children: (user: CurrentUser) => React.ReactNode;
  preserveEditsOnTransientError?: boolean;
}) {
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
  // 编辑器不能因后台会话检查的临时故障而卸载；明确拒绝访问仍立即隐藏内容。
  const accessDenied =
    identity.error instanceof ApiError &&
    (identity.error.status === 401 || identity.error.status === 403);
  const retained = preserveEditsOnTransientError && !!identity.data && !accessDenied;
  if (identity.error && !retained)
    return (
      <div className="page-loading">
        <Alert type="error" title={identity.error.message} showIcon />
        <Button onClick={() => void identity.refetch()}>重新连接</Button>
        <Button type="text" onClick={() => router.replace('/login')}>
          返回登录
        </Button>
      </div>
    );
  if (!identity.data) return null;
  return (
    <>
      {identity.error ? (
        <Alert
          showIcon
          type="warning"
          title="暂时无法确认最新登录状态，当前编辑仍保留"
          action={
            <Button
              size="small"
              loading={identity.isFetching}
              onClick={() => void identity.refetch()}
            >
              重新检查登录状态
            </Button>
          }
        />
      ) : null}
      {children(identity.data)}
    </>
  );
}
