import { Alert, App, Button } from 'antd';
import type { WorkflowMetadata } from '../metadata/use-workflow-metadata';
import type { useWorkflowDraft } from '../draft/use-workflow-draft';

export function EditorNotices({
  metadata,
  draft,
  publishing,
}: {
  metadata: WorkflowMetadata;
  draft: ReturnType<typeof useWorkflowDraft>;
  publishing: boolean;
}) {
  const { modal } = App.useApp();
  const { conflict, metadataError, reloadingMetadata, saving, reloadMetadata } = metadata;
  function reloadDraft() {
    if (!draft.dirty) {
      void draft.reload();
      return;
    }
    modal.confirm({
      title: '重新读取会放弃当前图修改',
      content: '工作流名称和视口的修改会保留。',
      okText: '读取服务器草稿',
      cancelText: '继续编辑',
      onOk: draft.reload,
    });
  }

  return (
    <>
      {conflict || metadataError ? (
        <Alert
          className="canvas-notice"
          showIcon
          type={conflict ? 'warning' : 'error'}
          title={conflict ? '工作流信息已在其他页面更新' : '工作流信息保存未确认'}
          description={`${metadataError ?? ''} 当前本地修改仍保留。`}
          action={
            conflict ? (
              <Button
                size="small"
                loading={reloadingMetadata}
                disabled={saving}
                onClick={reloadMetadata}
              >
                重新读取工作流信息
              </Button>
            ) : undefined
          }
        />
      ) : null}
      {draft.conflict || draft.error ? (
        <Alert
          className="canvas-notice"
          showIcon
          type={draft.conflict ? 'warning' : 'error'}
          title={
            draft.conflict ? '服务器草稿已更新，本地修改仍保留' : '草稿操作未完成，本地修改仍保留'
          }
          description={
            draft.conflict
              ? '请重新读取服务器草稿后继续编辑，当前修改不会覆盖服务器的新版本。'
              : draft.error
          }
          action={
            <Button
              size="small"
              loading={draft.operation === 'reloading'}
              disabled={draft.operation === 'saving' || publishing}
              onClick={reloadDraft}
            >
              重新读取草稿
            </Button>
          }
        />
      ) : null}
    </>
  );
}
