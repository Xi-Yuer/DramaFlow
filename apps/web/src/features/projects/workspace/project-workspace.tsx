'use client';

import { useCallback, useRef, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Spin } from 'antd';
import {
  ArrowLeft,
  Clapperboard,
  Film,
  FolderOpen,
  LayoutDashboard,
  Settings2,
  Workflow,
} from 'lucide-react';
import { z } from 'zod';
import { AuthBoundary } from '@/features/auth/auth-boundary';
import { AccountMenuButton } from '@/features/auth/account-menu';
import { ApiError } from '@/lib/http';
import type { RequestLeave } from '@/lib/navigation/use-leave-guard';
import type { Project } from '@dramaflow/contracts';
import { projectApi, projectKeys } from '../project-api';
import { ProjectWorkspaceContext } from './workspace-context';
import { WorkspaceLink } from './workspace-link';
import styles from './workspace.module.css';

const sections = [
  { segment: 'overview', label: '概览', icon: LayoutDashboard },
  { segment: 'videos', label: '视频', icon: Film },
  { segment: 'assets', label: '素材', icon: FolderOpen },
  { segment: 'workflows', label: '工作流', icon: Workflow },
  { segment: 'settings', label: '设置', icon: Settings2 },
] as const;

export function ProjectWorkspace({
  projectId,
  children,
}: {
  projectId: string;
  children: ReactNode;
}) {
  return (
    <AuthBoundary preserveEditsOnTransientError>
      {() => (
        <WorkspaceLoader key={projectId} projectId={projectId}>
          {children}
        </WorkspaceLoader>
      )}
    </AuthBoundary>
  );
}

function WorkspaceLoader({ projectId, children }: { projectId: string; children: ReactNode }) {
  const valid = z.uuid().safeParse(projectId).success;
  const project = useQuery({
    queryKey: projectKeys.detail(projectId),
    queryFn: () => projectApi.get(projectId),
    enabled: valid,
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always',
    refetchOnReconnect: false,
  });
  if (!valid) return <WorkspaceFailure title="项目地址无效" />;
  if (project.isPending)
    return (
      <div className="page-loading" role="status">
        <Spin size="large" />
        <span>正在打开创作项目…</span>
      </div>
    );
  const denied =
    project.error instanceof ApiError && [401, 403, 404].includes(project.error.status);
  if (!project.data || denied)
    return (
      <WorkspaceFailure
        title={project.error?.message ?? '无法打开项目'}
        retry={() => void project.refetch()}
      />
    );
  return (
    <WorkspaceShell project={project.data}>
      {project.error ? (
        <Alert
          type="warning"
          showIcon
          title="项目信息暂时无法刷新，当前编辑仍保留"
          action={<Button onClick={() => void project.refetch()}>重试</Button>}
        />
      ) : null}
      {children}
    </WorkspaceShell>
  );
}

function WorkspaceFailure({ title, retry }: { title: string; retry?: () => void }) {
  return (
    <div className="page-loading">
      <Alert type="error" title={title} showIcon />
      {retry ? <Button onClick={retry}>重新连接</Button> : null}
      <Button href="/projects">返回项目列表</Button>
    </div>
  );
}

function WorkspaceShell({ project, children }: { project: Project; children: ReactNode }) {
  const pathname = usePathname();
  const guard = useRef<RequestLeave | null>(null);
  const registerLeaveGuard = useCallback((next: RequestLeave) => {
    guard.current = next;
    return () => {
      if (guard.current === next) guard.current = null;
    };
  }, []);
  const requestLeave = useCallback<RequestLeave>((action) => {
    if (guard.current) guard.current(action);
    else void action();
  }, []);
  const base = `/projects/${project.id}`;

  return (
    <ProjectWorkspaceContext.Provider value={{ project, requestLeave, registerLeaveGuard }}>
      <div className={styles.shell}>
        <header className={styles.header}>
          <WorkspaceLink href="/projects" className={styles.back}>
            <ArrowLeft size={16} aria-hidden />
            项目列表
          </WorkspaceLink>
          <span className="brand-symbol">
            <Clapperboard size={20} aria-hidden />
          </span>
          <div className={styles.identity}>
            <span>视频创作项目</span>
            <strong>{project.name}</strong>
          </div>
          <AccountMenuButton requestLeave={requestLeave} />
        </header>
        <nav className={styles.navigation} aria-label="项目工作空间">
          {sections.map(({ segment, label, icon: Icon }) => {
            const href = `${base}/${segment}`;
            return (
              <WorkspaceLink
                key={segment}
                href={href}
                current={pathname === href || pathname.startsWith(`${href}/`)}
              >
                <Icon size={16} aria-hidden />
                {label}
              </WorkspaceLink>
            );
          })}
        </nav>
        <div className={styles.content}>{children}</div>
      </div>
    </ProjectWorkspaceContext.Provider>
  );
}
