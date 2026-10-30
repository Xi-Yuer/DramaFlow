import { Button } from 'antd';
import { ArrowLeft, Settings2 } from 'lucide-react';
import { AccountMenuButton } from '@/features/auth/account-menu';
import type { ProjectMetadata } from '../project/use-project-metadata';
import type { useWorkflowDraft } from '../draft/use-workflow-draft';
import type { useEditorLeaveGuard } from '../navigation/use-editor-leave-guard';

export function EditorToolbar({
  metadata,
  draft,
  publishing,
  onBack,
  onOpenModels,
  requestLeave,
  inWorkspace = false,
}: {
  metadata: ProjectMetadata;
  draft: ReturnType<typeof useWorkflowDraft>;
  publishing: boolean;
  onBack: () => void;
  onOpenModels: () => void;
  requestLeave: ReturnType<typeof useEditorLeaveGuard>['requestLeave'];
  inWorkspace?: boolean;
}) {
  const { name, setName, saving, reloadingProject, conflict, projectError, dirty, revision, save } =
    metadata;
  return (
    <header className="canvas-top">
      <Button
        type="text"
        icon={<ArrowLeft size={16} />}
        onClick={onBack}
        aria-label={inWorkspace ? '返回项目概览' : '返回项目'}
      >
        {inWorkspace ? '概览' : '项目'}
      </Button>
      <input
        className="canvas-name"
        value={name}
        maxLength={80}
        aria-label="项目名称"
        onChange={(event) => setName(event.target.value)}
      />
      <div className="canvas-save-group" role="group" aria-label="项目信息">
        <span className="canvas-status" role="status" aria-label="项目信息状态">
          {saving
            ? '正在保存项目信息…'
            : reloadingProject
              ? '正在读取项目信息…'
              : conflict
                ? '项目信息冲突'
                : projectError
                  ? '项目信息保存未确认'
                  : dirty
                    ? '项目信息未保存'
                    : `项目已保存 · 修订 ${revision}`}
        </span>
        <Button
          size="small"
          loading={saving}
          disabled={!dirty || conflict || reloadingProject}
          onClick={() => void save()}
        >
          保存项目信息
        </Button>
      </div>
      <div className="canvas-save-group" role="group" aria-label="工作流草稿">
        <span className="canvas-status" role="status" aria-label="工作流草稿状态">
          {draft.operation === 'saving'
            ? '正在保存草稿…'
            : draft.operation === 'reloading'
              ? '正在读取服务器草稿…'
              : draft.conflict
                ? '草稿修订冲突'
                : draft.error
                  ? '草稿操作未完成'
                  : draft.dirty
                    ? '草稿未保存'
                    : `草稿已保存 · 修订 ${draft.revision}`}
        </span>
        <Button
          type="primary"
          size="small"
          title="保存草稿（⌘/Ctrl+S）"
          loading={draft.operation === 'saving'}
          disabled={!draft.dirty || draft.conflict || draft.operation === 'reloading' || publishing}
          onClick={() => void draft.save()}
        >
          保存草稿
        </Button>
      </div>
      <div className="canvas-actions">
        <Button
          type="text"
          danger
          size="small"
          aria-label="删除项目"
          onClick={metadata.removeProject}
        >
          删除项目
        </Button>
        <Button
          size="small"
          icon={<Settings2 size={15} />}
          disabled={publishing}
          onClick={onOpenModels}
        >
          模型设置
        </Button>
        {!inWorkspace ? <AccountMenuButton requestLeave={requestLeave} /> : null}
      </div>
    </header>
  );
}
