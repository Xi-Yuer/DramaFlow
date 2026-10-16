'use client';
import { useRouter } from 'next/navigation';
import { Avatar, Button, Tabs, Tag } from 'antd';
import { Clapperboard, ShieldCheck, UserRound, Waypoints } from 'lucide-react';
import type { CurrentUser } from '@dramaflow/contracts';
import { AccountMenuButton } from '@/features/auth/account-menu';
import { ProfileForm } from './profile-form';
import { SecurityPanel } from './security-panel';

export function AccountHome({ user }: { user: CurrentUser }) {
  const router = useRouter();
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
        <div className="account-actions">
          <Button type="text" icon={<Waypoints size={15} />} onClick={() => router.push('/')}>
            项目画布
          </Button>
          <AccountMenuButton />
        </div>
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
