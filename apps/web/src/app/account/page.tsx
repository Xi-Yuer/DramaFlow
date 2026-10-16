'use client';
import { AuthBoundary } from '@/features/auth/auth-boundary';
import { AccountHome } from '@/features/users/account-home';

export default function AccountPage() {
  return <AuthBoundary>{(user) => <AccountHome user={user} />}</AuthBoundary>;
}
