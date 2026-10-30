import { Button } from 'antd';
import { ArrowLeft, Settings2 } from 'lucide-react';
import { AccountMenuButton } from '@/features/auth/account-menu';
import type { WorkflowMetadata } from '../metadata/use-workflow-metadata';
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
  metadata: WorkflowMetadata;
  draft: ReturnType<typeof useWorkflowDraft>;
  publishing: boolean;
  onBack: () => void;
  onOpenModels: () => void;
  requestLeave: ReturnType<typeof useEditorLeaveGuard>['requestLeave'];
  inWorkspace?: boolean;
}) {
  const {
    name,
    setName,
    saving,
    reloadingMetadata,
    conflict,
    metadataError,
    dirty,
    revision,
    save,
  } = metadata;
  return (
    <header className="canvas-top">
      <Button
        type="text"
        icon={<ArrowLeft size={16} />}
        onClick={onBack}
        aria-label={inWorkspace ? '返回工作流列表' : '返回项目'}
      >
        {inWorkspace ? '工作流' : '项目'}
      </Button>
      <input
        className="canvas-name"
        value={name}
        maxLength={80}
        aria-label="工作流名称"
        onChange={(event) => setName(event.target.value)}
      />
      <div className="canvas-save-group" role="group" aria-label="工作流信息">
        <span className="canvas-status" role="status" aria-label="工作流信息状态">
          {saving
            ? '正在保存工作流信息…'
            : reloadingMetadata
              ? '正在读取工作流信息…'
              : conflict
                ? '工作流信息冲突'
                : metadataError
                  ? '工作流信息保存未确认'
                  : dirty
                    ? '工作流信息未保存'
                    : `工作流信息已保存 · 修订 ${revision}`}
        </span>
        <Button
          size="small"
          loading={saving}
          disabled={!dirty || conflict || reloadingMetadata}
          onClick={() => void save()}
        >
          保存工作流信息
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
