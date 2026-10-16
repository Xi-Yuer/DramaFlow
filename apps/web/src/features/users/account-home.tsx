'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { App, Avatar, Button, Dropdown, Tabs, Tag } from 'antd';
import { Clapperboard, LogOut, Settings2, ShieldCheck, UserRound } from 'lucide-react';
import type { CurrentUser } from '@dramaflow/contracts';
import { authClient } from '@/features/auth/auth-client';
import { ProfileForm } from './profile-form';
import { SecurityPanel } from './security-panel';

export function AccountHome({ user }: { user: CurrentUser }) {
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
  return (
    <main className="account-layout">
      <header className="account-header">
        <div className="brand">
          <span className="brand-symbol">
            <Clapperboard size={20} />
          </span>
          <span>DramaFlow</span>
        </div>
        <span className="account-location">账户与安全</span>
        <Dropdown
          menu={{
            items: [
              {
                key: 'logout',
                icon: <LogOut size={15} />,
                label: '退出登录',
                disabled: signingOut,
              },
            ],
            onClick: () => void signOut(),
          }}
          trigger={['click']}
        >
          <Button type="text" className="account-menu" aria-label="账户菜单" loading={signingOut}>
            <Avatar size={26}>{user.name.slice(0, 1)}</Avatar>
            <span>{user.name}</span>
            <Settings2 size={15} />
          </Button>
        </Dropdown>
      </header>
      <section className="account-space">
        <div className="account-intro">
          <span className="small-kicker">YOUR CREATIVE IDENTITY</span>
          <h1>你好，{user.name}。</h1>
          <p className="secondary-copy">在开始创作之前，先让这里更像你。</p>
        </div>
        <div className="account-surface">
          <aside className="identity-summary">
            <Avatar size={72}>{user.name.slice(0, 1)}</Avatar>
            <h2>{user.name}</h2>
            <p>{user.email}</p>
            <Tag color={user.role === 'admin' ? 'cyan' : 'default'}>
              {user.role === 'admin' ? '平台管理员' : '创作成员'}
            </Tag>
            <div className="identity-detail">
              <span>加入时间</span>
              <strong>
                {new Date(user.createdAt).toLocaleDateString('zh-CN', {
                  timeZone: user.profile.timeZone,
                })}
              </strong>
              <span>账号标识</span>
              <code>{user.id}</code>
            </div>
          </aside>
          <div className="account-panels">
            <Tabs
              items={[
                {
                  key: 'profile',
                  label: '个人资料',
                  icon: <UserRound size={15} />,
                  children: <ProfileForm user={user} />,
                },
                {
                  key: 'security',
                  label: '账号安全',
                  icon: <ShieldCheck size={15} />,
                  children: <SecurityPanel user={user} />,
                },
              ]}
            />
          </div>
        </div>
      </section>
      <footer className="account-footer">DramaFlow · 创作，由你定义。</footer>
    </main>
  );
}
