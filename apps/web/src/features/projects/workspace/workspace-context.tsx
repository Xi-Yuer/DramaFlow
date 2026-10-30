'use client';

import { createContext, useContext, useEffect } from 'react';
import type { Project } from '@dramaflow/contracts';
import type { RequestLeave } from '@/lib/navigation/use-leave-guard';

export const ProjectWorkspaceContext = createContext<{
  project: Project;
  requestLeave: RequestLeave;
  registerLeaveGuard: (guard: RequestLeave) => () => void;
} | null>(null);

export function useProjectWorkspace() {
  const workspace = useContext(ProjectWorkspaceContext);
  if (!workspace) throw new Error('项目页面必须位于 Project Workspace 中');
  return workspace;
}

// 编辑器也可独立装配；在 Workspace 中将其现有保护接到共享导航上。
export function useProjectNavigationGuard(guard: RequestLeave) {
  const register = useContext(ProjectWorkspaceContext)?.registerLeaveGuard;
  useEffect(() => register?.(guard), [register, guard]);
}
