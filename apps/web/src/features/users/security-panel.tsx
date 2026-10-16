'use client';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App, Button, Form, Input, Tag } from 'antd';
import { Laptop, ShieldCheck } from 'lucide-react';
import type { CurrentUser } from '@dramaflow/contracts';
import { authClient } from '@/features/auth/auth-client';
import {
  authErrorMessage,
  identityApi,
  identityKey,
  sessionsKey,
} from '@/features/auth/identity-api';

type PasswordValues = { currentPassword: string; newPassword: string; confirmPassword: string };
export function SecurityPanel({ user }: { user: CurrentUser }) {
  const [form] = Form.useForm<PasswordValues>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cache = useQueryClient();
  const { message, modal } = App.useApp();
  const sessions = useQuery({ queryKey: sessionsKey, queryFn: identityApi.sessions, retry: false });
  const revoke = useMutation({
    mutationFn: identityApi.revokeOthers,
    onSuccess: () => {
      void cache.invalidateQueries({ queryKey: sessionsKey });
      void message.success('其他设备已退出登录');
    },
    onError: (error) => void message.error(error.message),
  });
  async function changePassword(values: PasswordValues) {
    setBusy(true);
    setError(null);
    try {
      const result = await authClient.changePassword({
        currentPassword: values.currentPassword,
        newPassword: values.newPassword,
        revokeOtherSessions: true,
      });
      if (result.error) {
        setError(authErrorMessage(result.error));
        return;
      }
      form.resetFields();
      await Promise.all([
        cache.invalidateQueries({ queryKey: identityKey }),
        cache.invalidateQueries({ queryKey: sessionsKey }),
      ]);
      void message.success('密码已更新，其他设备已退出登录');
    } catch {
      setError('无法连接认证服务，请稍后重试。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="security-content">
      <div>
        <h3>
          <ShieldCheck size={17} />
          修改密码
        </h3>
        <p className="secondary-copy">使用至少 12 个字符。更新后，其他设备需要重新登录。</p>
        {error && <Alert type="error" showIcon title={error} className="form-notice" />}
        <Form
          form={form}
          layout="vertical"
          requiredMark={false}
          onFinish={changePassword}
          disabled={busy}
        >
          <Form.Item
            name="currentPassword"
            label="当前密码"
            rules={[{ required: true, message: '请输入当前密码' }]}
          >
            <Input.Password autoComplete="current-password" maxLength={128} />
          </Form.Item>
          <Form.Item
            name="newPassword"
            label="新密码"
            rules={[
              { required: true, message: '请输入新密码' },
              { min: 12, max: 128, message: '密码长度为 12—128 个字符' },
            ]}
          >
            <Input.Password autoComplete="new-password" maxLength={128} />
          </Form.Item>
          <Form.Item
            name="confirmPassword"
            label="确认新密码"
            dependencies={['newPassword']}
            rules={[
              { required: true, message: '请再次输入新密码' },
              ({ getFieldValue }) => ({
                validator(_, value) {
                  return value === getFieldValue('newPassword')
                    ? Promise.resolve()
                    : Promise.reject(new Error('两次输入的密码不一致'));
                },
              }),
            ]}
          >
            <Input.Password autoComplete="new-password" maxLength={128} />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={busy}>
            更新密码
          </Button>
        </Form>
      </div>
      <div className="session-section">
        <div className="section-title-row">
          <h3>登录设备</h3>
          <Button
            size="small"
            disabled={revoke.isPending || !sessions.data?.items.some((session) => !session.current)}
            onClick={() =>
              modal.confirm({
                title: '退出其他设备？',
                content: '当前设备会保持登录，其他设备需要重新输入密码。',
                okText: '确认退出',
                cancelText: '取消',
                onOk: () => revoke.mutateAsync(),
              })
            }
          >
            退出其他设备
          </Button>
        </div>
        {sessions.isPending && <p className="secondary-copy">正在读取登录设备…</p>}
        {sessions.error && (
          <Alert
            type="error"
            title="读取登录设备失败"
            action={<Button onClick={() => void sessions.refetch()}>重试</Button>}
          />
        )}
        {sessions.data?.items.map((session) => (
          <div className="session-row" key={session.id}>
            <Laptop size={19} />
            <div>
              <strong>{session.current ? '当前浏览器' : '其他浏览器'}</strong>
              <p>{session.userAgent || '未提供设备信息'}</p>
              <small>
                {session.ipAddress || '地址未知'} ·{' '}
                {new Date(session.createdAt).toLocaleString('zh-CN', {
                  timeZone: user.profile.timeZone,
                })}
              </small>
            </div>
            {session.current && <Tag color="cyan">当前</Tag>}
          </div>
        ))}
      </div>
    </div>
  );
}
