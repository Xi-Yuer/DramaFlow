'use client';

import Link from 'next/link';
import { useState } from 'react';
import { ArrowRight, Clapperboard, Loader2, Workflow } from 'lucide-react';
import { authClient } from './auth-client';
import { Button } from '@/components/ui/button';
import { ErrorNotice, FormField } from '@/components/ui/form-field';

export function AuthGate({ children }: { children: React.ReactNode }) {
  const { data: session, isPending, error, refetch } = authClient.useSession();
  const [submitError, setSubmitError] = useState<Error | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setSubmitting(true);
    setSubmitError(null);
    try {
      const credentials = {
        email: String(form.get('email')),
        password: String(form.get('password')),
      };
      const result = await authClient.signIn.email(credentials);
      if (result.error) throw new Error(result.error.message ?? '登录失败，请检查账户信息');
      await refetch();
    } catch (failure) {
      setSubmitError(failure instanceof Error ? failure : new Error('账户服务暂不可用'));
    } finally {
      setSubmitting(false);
    }
  }

  if (isPending)
    return (
      <div className="app-loading">
        <span className="brand-mark">
          <Clapperboard size={24} />
        </span>
        <p>正在连接创作工作台…</p>
        <Loader2 className="animate-spin" size={18} />
      </div>
    );
  if (session) return children;

  return (
    <main className="auth-page">
      <section className="auth-story">
        <Link className="brand" href="/">
          <span className="brand-mark">
            <Clapperboard size={23} />
          </span>
          <span>
            Drama<span className="brand-serif">Flow</span>
          </span>
        </Link>
        <div className="auth-manifesto">
          <span className="eyebrow">
            <i /> YOUR IDEAS, IN MOTION
          </span>
          <h1>
            让想象，
            <br />
            沿着你的
            <br />
            <em>方式发生。</em>
          </h1>
          <p>
            从一句灵感到一幕故事。
            <br />
            连接模型、编排过程，让创作成为可以掌控的流程。
          </p>
          <div className="auth-flow">
            <span>
              <Workflow size={18} /> 想法
            </span>
            <i />
            <span>生成</span>
            <i />
            <span>作品</span>
          </div>
        </div>
        <footer>BUILT FOR CREATORS · DESIGNED TO CONNECT</footer>
      </section>
      <section className="auth-form-wrap">
        <form className="auth-form" onSubmit={submit}>
          <span className="eyebrow">创作的下一步</span>
          <h2>欢迎回到工作台</h2>
          <p className="muted">使用团队平台账户进入你的工作空间。</p>
          {error && (
            <ErrorNotice
              error={new Error(error.message ?? '账户服务连接失败')}
              onRetry={() => void refetch()}
            />
          )}
          {submitError && <ErrorNotice error={submitError} />}
          <FormField label="电子邮箱">
            <input
              name="email"
              type="email"
              autoComplete="email"
              required
              placeholder="you@studio.com"
            />
          </FormField>
          <FormField label="密码">
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              minLength={8}
              maxLength={128}
              required
              placeholder="至少 8 位字符"
            />
          </FormField>
          <Button type="submit" size="lg" disabled={submitting}>
            {submitting ? <Loader2 className="animate-spin" /> : null}进入工作台
            <ArrowRight />
          </Button>
          <div className="auth-switch">需要账户？请联系团队管理员。</div>
          <div className="auth-footnote">
            账户和工作空间权限由你所在的团队管理。模型凭证仅在服务端加密保存。
          </div>
        </form>
      </section>
    </main>
  );
}
