// @vitest-environment happy-dom
import { useState } from 'react';
import { App, ConfigProvider, Button } from 'antd';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowRunResponse } from '@dramaflow/contracts';
import { workflowApi } from '../../../../src/features/workflow/workflow-api';
import { WorkflowRunStatusView } from '../../../../src/features/workflow/run/status/workflow-run-status-controls';
import { useWorkflowRunStatus } from '../../../../src/features/workflow/run/status/use-workflow-run-status';
import { pendingReview, waitingRun } from '../../../fixtures/human-review';

const project = '00000000-0000-4000-8000-000000000001';
function Harness() {
  const [id, setId] = useState('run-1');
  const status = useWorkflowRunStatus(id, {
    projectId: project,
    workflowId: waitingRun.workflowId,
  });
  return (
    <>
      <WorkflowRunStatusView
        state={status.state}
        onRefresh={() => void status.refresh()}
        onCancel={status.cancel}
        reviewActions={status.reviewActions}
      />
      <Button onClick={() => setId('run-2')}>切换运行</Button>
    </>
  );
}
function setup(extra: Partial<WorkflowRunResponse> = {}) {
  const current = { ...waitingRun, status: 'running' as const, ...extra };
  const get = vi.spyOn(workflowApi, 'getRun').mockResolvedValue(current);
  const pending = vi
    .spyOn(workflowApi, 'getPendingHumanReviews')
    .mockResolvedValue({ items: [pendingReview] });
  vi.spyOn(workflowApi, 'getNodeRuns').mockResolvedValue({ items: [] });
  const cancel = vi
    .spyOn(workflowApi, 'cancelRun')
    .mockResolvedValue({ outcome: 'requested', run: { ...current, cancellation: 'requested' } });
  const resume = vi.spyOn(workflowApi, 'resumeRun');
  render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <App>
        <Harness />
      </App>
    </ConfigProvider>,
  );
  return { get, pending, cancel, resume, current };
}
async function confirm() {
  fireEvent.click(await screen.findByRole('button', { name: /取消运行/ }));
  fireEvent.click(await screen.findByRole('button', { name: /确认取消运行/ }));
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('Run Cancel 正式 Web 交互', () => {
  it.each(['pending', 'running', 'waiting'] as const)(
    '%s 提供一次确认，放弃确认不发 POST',
    async (status) => {
      const f = setup({ status });
      fireEvent.click(await screen.findByRole('button', { name: /取消运行/ }));
      expect(
        await screen.findByText(
          '将阻止后续工作继续执行，并尝试停止正在执行的任务。已发送到外部服务的请求可能无法撤销。',
        ),
      ).toBeTruthy();
      expect(f.cancel).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: /继续运行/ }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(f.cancel).not.toHaveBeenCalled();
    },
  );
  it.each(['completed', 'failed', 'cancelled'] as const)('%s 不提供取消', async (status) => {
    setup({ status });
    await screen.findByText('运行状态');
    await waitFor(() =>
      expect(
        screen.getByText(
          status === 'completed' ? '已完成' : status === 'failed' ? '失败' : '已取消',
        ),
      ).toBeTruthy(),
    );
    expect(screen.queryByRole('button', { name: /取消运行/ })).toBeNull();
  });
  it.each(['requested', 'uncertain'] as const)(
    '%s 只展示服务端状态，不重复提交取消',
    async (cancellation) => {
      setup({ cancellation });
      await screen.findByText(cancellation === 'requested' ? '取消中' : '暂无法确认停止');
      expect(screen.queryByRole('button', { name: /取消运行/ })).toBeNull();
    },
  );
  it('running accepted 保持取消中，再刷新显示 cancelled，不提前宣布停止', async () => {
    const f = setup();
    await screen.findByRole('button', { name: /取消运行/ });
    f.get.mockResolvedValue({ ...f.current, cancellation: 'requested' });
    await confirm();
    await screen.findByText('取消中');
    expect(screen.queryByText('已取消')).toBeNull();
    expect(f.cancel).toHaveBeenCalledExactlyOnceWith(project, waitingRun.workflowId, 'run-1');
    f.get.mockResolvedValue({ ...f.current, status: 'cancelled', cancellation: 'none' });
    fireEvent.click(screen.getByRole('button', { name: '手动刷新' }));
    await screen.findByText('已取消');
    expect(f.cancel).toHaveBeenCalledOnce();
  });
  it('waiting cancel 撤下 approval，不调用 reject 或生成 feedback', async () => {
    const f = setup({ status: 'waiting' });
    await screen.findByRole('region', { name: '人工审核' });
    const cancelled = { ...f.current, status: 'cancelled' as const, cancellation: 'none' as const };
    f.cancel.mockResolvedValue({ outcome: 'cancelled', run: cancelled });
    f.get.mockResolvedValue(cancelled);
    await confirm();
    await screen.findByText('已取消');
    expect(screen.queryByRole('region', { name: '人工审核' })).toBeNull();
    expect(f.resume).not.toHaveBeenCalled();
  });
  it.each(['completed', 'failed'] as const)('与 %s 竞争，显示最新事实', async (status) => {
    const f = setup();
    await screen.findByRole('button', { name: /取消运行/ });
    const terminal = { ...f.current, status };
    f.cancel.mockResolvedValue({ outcome: 'terminal', run: terminal });
    f.get.mockResolvedValue(terminal);
    await confirm();
    await screen.findByText(status === 'completed' ? '已完成' : '失败');
    expect(screen.queryByText('已取消')).toBeNull();
  });
  it('响应丢失只 GET 对账，不重放 POST；查询到 uncertain 如实展示', async () => {
    const f = setup();
    await screen.findByRole('button', { name: /取消运行/ });
    f.cancel.mockRejectedValue(new TypeError('offline'));
    f.get.mockResolvedValue({ ...f.current, cancellation: 'uncertain' });
    await confirm();
    await screen.findByText('暂无法确认停止');
    expect(f.cancel).toHaveBeenCalledOnce();
  });
  it('旧确认窗口不能取消已切换的 Run', async () => {
    const f = setup();
    fireEvent.click(await screen.findByRole('button', { name: /取消运行/ }));
    f.get.mockResolvedValue({ ...f.current, id: 'run-2' });
    fireEvent.click(screen.getByRole('button', { name: '切换运行' }));
    await waitFor(() => expect(f.get).toHaveBeenCalledWith('run-2', expect.any(AbortSignal)));
    fireEvent.click(screen.getByRole('button', { name: /确认取消运行/ }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(f.cancel).not.toHaveBeenCalled();
  });
});
