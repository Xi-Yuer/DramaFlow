'use client';
import { App, Button } from 'antd';
import { canCancelWorkflowRun, type WorkflowRunStatusState } from './workflow-run-status';

export function WorkflowRunCancelButton({
  state,
  onCancel,
}: {
  state: WorkflowRunStatusState;
  onCancel?: (runId: string) => Promise<void>;
}) {
  const { modal } = App.useApp();
  const run = state.run;
  if (
    !onCancel ||
    !run ||
    !['pending', 'running', 'waiting'].includes(run.status) ||
    run.cancellationRequestedAt ||
    (run.cancellation && run.cancellation !== 'none')
  )
    return null;
  return (
    <Button
      size="small"
      danger
      loading={state.cancelSubmitting}
      disabled={!canCancelWorkflowRun(state)}
      onClick={() => {
        const target = run.id;
        modal.confirm({
          title: '确认取消本次运行？',
          content:
            '将阻止后续工作继续执行，并尝试停止正在执行的任务。已发送到外部服务的请求可能无法撤销。',
          okText: '确认取消运行',
          cancelText: '继续运行',
          okButtonProps: { danger: true },
          onOk: () => onCancel(target),
        });
      }}
    >
      取消运行
    </Button>
  );
}
