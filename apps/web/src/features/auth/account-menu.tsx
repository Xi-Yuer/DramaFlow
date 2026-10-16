'use client';
import { useRouter } from 'next/navigation';
import { Avatar, Button, Dropdown } from 'antd';
import { LogOut, UserRound } from 'lucide-react';
import { useIdentity } from './use-identity';
import { useSignOut } from './use-sign-out';

export function AccountMenuButton() {
  const router = useRouter();
  const identity = useIdentity();
  const { signOut, signingOut } = useSignOut();
  const name = identity.data?.name ?? '';
  return (
    <Dropdown
      menu={{
        items: [
          { key: 'account', icon: <UserRound size={15} />, label: '账户与安全' },
          { key: 'logout', icon: <LogOut size={15} />, label: '退出登录', disabled: signingOut },
        ],
        onClick: ({ key }) => {
          if (key === 'account') router.push('/');
          if (key === 'logout') void signOut();
        },
      }}
      trigger={['click']}
    >
      <Button type="text" className="account-menu" aria-label="账户菜单" loading={signingOut}>
        <Avatar size={26}>{name.slice(0, 1) || '…'}</Avatar>
        {name ? <span className="account-menu-name">{name}</span> : null}
      </Button>
    </Dropdown>
  );
}
