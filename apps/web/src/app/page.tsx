import { Suspense } from 'react';
import { AuthGate } from '@/features/auth/auth-gate';
import { WorkspaceApp } from '@/features/workspaces/workspace-app';

export default function Home() {
  return (
    <AuthGate>
      <Suspense fallback={<div className="app-loading">正在准备工作台…</div>}>
        <WorkspaceApp />
      </Suspense>
    </AuthGate>
  );
}
