'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Clapperboard,
  FolderClosed,
  HelpCircle,
  Images,
  Loader2,
  LogOut,
  Plug,
  Workflow,
  Users,
} from 'lucide-react';
import { api, queryKeys } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { EmptyState, ErrorNotice } from '@/components/ui/form-field';
import { authClient } from '@/features/auth/auth-client';
import { useEditorStore, isEditorDirty } from '@/features/editor/editor-store';
import { WorkflowEditor } from '@/features/editor/workflow-editor';
import { PluginSettings } from '@/features/plugins/plugin-settings';
import { WorkflowList } from './workflow-list';
import { AssetLibrary } from './asset-library';
import { MembersPanel } from './members-panel';
import { cn } from '@/lib/utils';

export function WorkspaceApp() {
  const router = useRouter();
  const search = useSearchParams();
  const client = useQueryClient();
  const workspaces = useQuery({ queryKey: queryKeys.workspaces, queryFn: api.workspaces });
  const workspace =
    workspaces.data?.items.find((item) => item.id === search.get('workspace')) ??
    workspaces.data?.items[0];
  const workflowId = search.get('workflow');
  const screen = search.get('view') === 'assets' ? 'assets' : 'workflows';
  const [pluginsOpen, setPluginsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  const [signOutError, setSignOutError] = useState<Error | null>(null);
  const session = authClient.useSession();
  function canLeave() {
    return (
      !workflowId ||
      !isEditorDirty(useEditorStore.getState()) ||
      window.confirm('当前草稿尚未保存，离开将放弃这些修改。确定离开吗？')
    );
  }
  function navigate(workspaceId: string, target?: string, view = 'workflows') {
    if (!canLeave()) return;
    useEditorStore.setState({ workflowId: null });
    const params = new URLSearchParams({ workspace: workspaceId });
    if (target) params.set('workflow', target);
    if (view === 'assets') params.set('view', view);
    router.push(`/?${params}`);
  }
  async function signOut() {
    if (!canLeave()) return;
    try {
      const result = await authClient.signOut();
      if (result.error) throw new Error(result.error.message ?? '退出失败');
      client.clear();
      useEditorStore.setState({ workflowId: null });
    } catch (error) {
      setSignOutError(error instanceof Error ? error : new Error('退出失败'));
    }
  }
  const workspacePicker = workspace ? (
    <select
      className="workspace-picker"
      aria-label="当前工作空间"
      value={workspace.id}
      onChange={(event) => navigate(event.target.value)}
    >
      {workspaces.data?.items.map((item) => (
        <option key={item.id} value={item.id}>
          {item.name} · {{ admin: '管理员', editor: '编辑者', viewer: '查看者' }[item.role]}
        </option>
      ))}
    </select>
  ) : null;
  return (
    <div className="workspace-shell">
      <nav className="app-rail" aria-label="主导航">
        <button
          type="button"
          className="brand-mark"
          title="DramaFlow"
          aria-label="DramaFlow 首页"
          onClick={() => workspace && navigate(workspace.id)}
        >
          <Clapperboard size={21} />
        </button>
        <button
          type="button"
          className={cn('rail-button', screen === 'workflows' && 'active')}
          title="工作流"
          aria-label="工作流"
          onClick={() => workspace && navigate(workspace.id)}
        >
          <Workflow size={19} />
        </button>
        <button
          type="button"
          className={cn('rail-button', screen === 'assets' && 'active')}
          title="素材版本"
          aria-label="素材版本"
          onClick={() => workspace && navigate(workspace.id, undefined, 'assets')}
        >
          <Images size={19} />
        </button>
        <button
          type="button"
          className="rail-button"
          title="插件与连接"
          aria-label="插件与连接"
          disabled={!workspace}
          onClick={() => setPluginsOpen(true)}
        >
          <Plug size={19} />
        </button>
        <span className="rail-spacer" />
        {workspace?.role === 'admin' && (
          <button type="button" className="rail-button" title="团队成员" aria-label="团队成员" onClick={() => setMembersOpen(true)}><Users size={19} /></button>
        )}
        <button
          type="button"
          className="rail-button"
          title="使用说明"
          aria-label="使用说明"
          onClick={() => setHelpOpen(true)}
        >
          <HelpCircle size={17} />
        </button>
        <button
          type="button"
          className="rail-button"
          title="退出登录"
          aria-label="退出登录"
          onClick={() => void signOut()}
        >
          <LogOut size={16} />
        </button>
        <span className="user-avatar" title={session.data?.user.name}>
          {session.data?.user.name?.slice(0, 1).toUpperCase() ?? 'U'}
        </span>
      </nav>
      {workspace && workflowId ? (
        <WorkflowEditor
          key={workflowId}
          workflowId={workflowId}
          workspace={workspace}
          workspacePicker={workspacePicker}
          onBack={() => navigate(workspace.id)}
          onPlugins={() => setPluginsOpen(true)}
        />
      ) : (
        <div className="workspace-main">
          <header className="workspace-header">
            {workspacePicker}
            <span className="header-divider" />
            <span className="breadcrumb-label">{screen === 'assets' ? '素材版本' : '工作流'}</span>
            <div className="header-actions">
              <span className="eyebrow" style={{ fontSize: 8 }}>
                DRAMAFLOW / CREATION STUDIO
              </span>
            </div>
          </header>
          <div className="workspace-content">
            {workspaces.isPending ? (
              <div className="loading-row">
                <Loader2 className="animate-spin" size={15} />
                读取工作空间…
              </div>
            ) : workspaces.error ? (
              <div style={{ padding: 25 }}>
                <ErrorNotice error={workspaces.error} onRetry={() => void workspaces.refetch()} />
              </div>
            ) : !workspace ? (
              <div className="workspace-home">
                <EmptyState icon={<FolderClosed />} title="你还没有工作空间">
                  请联系管理员分配团队工作空间与权限。
                </EmptyState>
              </div>
            ) : screen === 'assets' ? (
              <AssetLibrary workspaceId={workspace.id} />
            ) : (
              <WorkflowList workspace={workspace} onOpen={(id) => navigate(workspace.id, id)} />
            )}
          </div>
        </div>
      )}
      {signOutError && (
        <div style={{ position: 'fixed', bottom: 20, left: 75, zIndex: 90 }}>
          <ErrorNotice error={signOutError} />
        </div>
      )}
      {pluginsOpen && workspace && (
        <PluginSettings workspace={workspace} onClose={() => setPluginsOpen(false)} />
      )}
      {helpOpen && (
        <Dialog title="你的创作工作台" onClose={() => setHelpOpen(false)}>
          <div style={{ lineHeight: 1.9, color: '#9bb1a3', fontSize: 12 }}>
            <p>1. 在「插件与连接」中启用能力插件，添加团队模型凭证。</p>
            <p>2. 新建工作流，从节点库拖入需要的能力，分别连接执行顺序与数据输入。</p>
            <p>3. 为生成节点选择插件、模型和连接，填写生成需求。保存草稿并校验，通过后发布。</p>
            <p>4. 运行会绑定发布版本。人工确认会暂停；你可审核数据、批准继续，或拒绝。</p>
            <p>5. 在节点或工作流对话中讨论想法。配置建议需要确认才会应用，聊天不会自动生成作品。</p>
            <p className="field-hint">
              修改草稿不影响已运行版本。重新生成会保留历史产物。没有安装的模型能力会明确显示不可用。
            </p>
          </div>
          <Button variant="outline" onClick={() => setHelpOpen(false)}>
            开始创作
          </Button>
        </Dialog>
      )}
      {membersOpen && workspace && <MembersPanel workspaceId={workspace.id} onClose={() => setMembersOpen(false)} />}
    </div>
  );
}
