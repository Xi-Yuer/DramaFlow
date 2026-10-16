'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Checkbox, Form, Input, Spin } from 'antd';
import { ArrowRight, Clapperboard, LockKeyhole, Mail, ScanLine, Sparkles } from 'lucide-react';
import { ApiError } from '@/lib/http';
import { authClient } from './auth-client';
import { authErrorMessage, identityKey } from './identity-api';
import { useIdentity } from './use-identity';

type LoginValues = { email: string; password: string; rememberMe: boolean };
export function LoginPage() {
  const router = useRouter();
  const cache = useQueryClient();
  const identity = useIdentity();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (identity.data && !identity.error) router.replace('/');
  }, [identity.data, identity.error, router]);
  async function login(values: LoginValues) {
    setBusy(true);
    setError(null);
    try {
      const result = await authClient.signIn.email({
        email: values.email.trim().toLowerCase(),
        password: values.password,
        rememberMe: values.rememberMe,
      });
      if (result.error) {
        setError(authErrorMessage(result.error));
        return;
      }
      await cache.invalidateQueries({ queryKey: identityKey });
      router.replace('/');
    } catch {
      setError('无法连接登录服务，请检查网络后重试。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login-layout">
      <section className="login-atmosphere" aria-label="DramaFlow 创作空间">
        <div className="brand">
          <span className="brand-symbol">
            <Clapperboard size={21} />
          </span>
          <span>
            DramaFlow<span className="brand-caption">你的智能创作空间</span>
          </span>
        </div>
        <div className="login-art" aria-hidden="true">
          <div className="art-orbit" />
          <div className="art-frame">
            <span className="art-label">
              <ScanLine size={13} /> FRAME / 01
            </span>
            <div className="art-landscape" />
            <span className="art-caption">从一个想法，到下一幕。</span>
          </div>
          <div className="art-frame art-frame-back" />
          <span className="art-spark">
            <Sparkles size={19} />
          </span>
        </div>
        <div className="login-intro">
          <span className="small-kicker">A SPACE FOR YOUR NEXT STORY</span>
          <h1>给灵感，一个开始的地方。</h1>
          <p>用自己的节奏，开启下一次创作。</p>
        </div>
        <footer>
          DRAMAFLOW <span>创作，由你定义。</span>
        </footer>
      </section>
      <section className="login-form-side">
        <div className="login-form-shell">
          <div className="login-heading-icon">
            <LockKeyhole size={22} />
          </div>
          <p className="small-kicker">WELCOME BACK</p>
          <h2>登录你的创作空间</h2>
          <p className="secondary-copy">使用团队分配的账号，继续你的创作。</p>
          {identity.isPending || (identity.data && !identity.error) ? (
            <Spin />
          ) : (
            <>
              {identity.error &&
                !(identity.error instanceof ApiError && identity.error.status === 401) && (
                  <Alert
                    type="warning"
                    showIcon
                    title="暂时无法确认登录状态"
                    description="你可以重试登录；账号停用时请联系管理员。"
                    className="form-notice"
                  />
                )}
              {error && <Alert type="error" showIcon title={error} className="form-notice" />}
              <Form<LoginValues>
                layout="vertical"
                initialValues={{ rememberMe: true }}
                onFinish={login}
                requiredMark={false}
                disabled={busy}
                size="large"
              >
                <Form.Item
                  label="邮箱"
                  name="email"
                  rules={[
                    { required: true, message: '请输入邮箱' },
                    { type: 'email', message: '请输入有效的邮箱地址' },
                  ]}
                >
                  <Input
                    prefix={<Mail size={16} />}
                    placeholder="name@example.com"
                    autoComplete="username"
                    maxLength={254}
                  />
                </Form.Item>
                <Form.Item
                  label="密码"
                  name="password"
                  rules={[{ required: true, message: '请输入密码' }]}
                >
                  <Input.Password
                    prefix={<LockKeyhole size={16} />}
                    placeholder="输入你的密码"
                    autoComplete="current-password"
                    maxLength={128}
                  />
                </Form.Item>
                <Form.Item name="rememberMe" valuePropName="checked">
                  <Checkbox>保持登录 7 天</Checkbox>
                </Form.Item>
                <Button
                  type="primary"
                  htmlType="submit"
                  block
                  loading={busy}
                  icon={<ArrowRight size={17} />}
                  iconPlacement="end"
                >
                  登录并继续
                </Button>
              </Form>
            </>
          )}
          <div className="login-help">
            <p>账号由部署管理员创建，当前不开放自行注册。</p>
            <p>忘记密码或无法登录？请联系管理员协助处理。</p>
          </div>
        </div>
        <div className="login-bottom">
          为专注创作而设计 <span>DramaFlow</span>
        </div>
      </section>
    </main>
  );
}
