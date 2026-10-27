// @vitest-environment happy-dom
import { App, ConfigProvider } from 'antd';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StringType, type WorkflowRunResponse } from '@dramaflow/contracts';
import {
  WorkflowExecutionWorkspace,
  type WorkflowExecutionWorkspaceProps,
} from '../../../src/features/workflow/editor/workflow-execution-workspace';
import { useWorkflowRunStatus } from '../../../src/features/workflow/run/status/use-workflow-run-status';
import { workflowApi } from '../../../src/features/workflow/workflow-api';
import { ApiError } from '../../../src/lib/http';
import { pendingReview, waitingRun } from '../../fixtures/human-review';

const onRun = vi.fn();
function Harness() {
  const status = useWorkflowRunStatus('run-1');
  const run: WorkflowExecutionWorkspaceProps['run'] = {
    versions: [],
    selectedVersionId: null,
    version: null,
    versionsLoading: false,
    versionLoading: false,
    versionsError: false,
    versionError: false,
    draftDirty: false,
    values: {},
    state: { phase: 'idle', accepted: null, error: null, request: null },
    runStatus: status.state,
    onRefreshRunStatus: () => void status.refresh(),
    reviewActions: status.reviewActions,
    onRun,
    onRetry: onRun,
    onSelectVersion: vi.fn(),
    onChangeInput: vi.fn(),
    onRetryVersions: vi.fn(),
    onRetryVersion: vi.fn(),
  };
  return (
    <ConfigProvider theme={{ token: { motion: false } }}>
      <App>
        <WorkflowExecutionWorkspace
          run={run}
          publication={null}
          recovery={{
            checking: false,
            entries: [],
            selected: null,
            notice: null,
            storageError: false,
          }}
          onRetryRecovery={() => {}}
          onSelectRecovered={() => {}}
        >
          <span>画布</span>
        </WorkflowExecutionWorkspace>
      </App>
    </ConfigProvider>
  );
}
function setup() {
  const get = vi.spyOn(workflowApi, 'getRun').mockResolvedValue(waitingRun);
  const pending = vi
    .spyOn(workflowApi, 'getPendingHumanReviews')
    .mockResolvedValue({ items: [pendingReview] });
  const nodeRuns = vi.spyOn(workflowApi, 'getNodeRuns').mockResolvedValue({ items: [] });
  const resume = vi.spyOn(workflowApi, 'resumeRun').mockResolvedValue(waitingRun);
  const start = vi.spyOn(workflowApi, 'startRun');
  const view = render(<Harness />);
  return { get, pending, nodeRuns, resume, start, view };
}
function button(name: '通过' | '拒绝') {
  return screen.getByRole('button', {
    name: new RegExp(name.split('').join('\\s*')),
  }) as HTMLButtonElement;
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  onRun.mockClear();
});

describe('现有执行面板中的人工审核闭环', () => {
  it('waiting 展示产品内容与可选反馈，隐藏实现身份；通过时锁住按钮，受理后禁用审批', async () => {
    const { pending, resume, start, view } = setup();
    await screen.findByRole('region', { name: '人工审核' });
    expect(screen.getByText(pendingReview.node.name)).toBeTruthy();
    expect(screen.getByText(pendingReview.instruction!)).toBeTruthy();
    expect(screen.getByText(/主角站在窗前/).textContent).toBe(pendingReview.content);
    expect(view.container.querySelector('script')).toBeNull();
    for (const hidden of [
      'interruptId',
      'waitingRevision',
      'threadId',
      'NodeRunId',
      'checkpoint',
      'RuntimeValue',
      pendingReview.interruptId,
    ])
      expect(view.container.innerHTML).not.toContain(hidden);
    let resolve!: (run: WorkflowRunResponse) => void;
    resume.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    fireEvent.change(screen.getByRole('textbox', { name: '修改意见 / 反馈' }), {
      target: { value: '角色准确，可以继续' },
    });
    fireEvent.click(button('通过'));
    expect(button('通过').disabled).toBe(true);
    expect(button('拒绝').disabled).toBe(true);
    fireEvent.click(button('拒绝'));
    expect(resume).toHaveBeenCalledExactlyOnceWith('run-1', {
      interruptId: pendingReview.interruptId,
      expectedWaitingRevision: 17,
      value: { action: 'approve', feedback: '角色准确，可以继续' },
    });
    pending.mockResolvedValue({ items: [{ ...pendingReview, submissionStatus: 'submitted' }] });
    await act(async () => resolve(waitingRun));
    await screen.findByText('审批结果已提交，等待工作流继续执行……');
    expect(button('通过').disabled).toBe(true);
    expect(button('拒绝').disabled).toBe(true);
    expect(start).not.toHaveBeenCalled();
    expect(onRun).not.toHaveBeenCalled();
  });

  it('拒绝是正常决策；同一 Run 的 Review1 → Review2 → completed 使用现有 Result', async () => {
    const { get, pending, resume, start } = setup();
    await screen.findByText(pendingReview.node.name);
    const second = {
      ...pendingReview,
      interruptId: 'opaque-second',
      waitingRevision: 18,
      node: { id: 'review-2', name: '剧本审核' },
      content: '第二轮审核内容',
      instruction: undefined,
    };
    pending.mockResolvedValue({ items: [second] });
    fireEvent.change(screen.getByRole('textbox', { name: '修改意见 / 反馈' }), {
      target: { value: '第一轮反馈' },
    });
    fireEvent.click(button('拒绝'));
    await screen.findByText(second.node.name);
    expect(
      (screen.getByRole('textbox', { name: '修改意见 / 反馈' }) as HTMLTextAreaElement).value,
    ).toBe('');
    expect(screen.queryByText(pendingReview.instruction!)).toBeNull();
    get.mockResolvedValue({
      ...waitingRun,
      status: 'completed',
      outputs: { result: { storage: 'inline', type: StringType, value: '最终剧本' } },
    });
    fireEvent.click(button('通过'));
    await screen.findByText('最终剧本');
    expect(resume.mock.calls.map(([, input]) => input)).toEqual([
      {
        interruptId: pendingReview.interruptId,
        expectedWaitingRevision: 17,
        value: { action: 'reject', feedback: '第一轮反馈' },
      },
      {
        interruptId: second.interruptId,
        expectedWaitingRevision: 18,
        value: { action: 'approve' },
      },
    ]);
    expect(get.mock.calls.every(([id]) => id === 'run-1')).toBe(true);
    expect(screen.queryByRole('region', { name: '人工审核' })).toBeNull();
    expect(start).not.toHaveBeenCalled();
    expect(onRun).not.toHaveBeenCalled();
  });

  it.each([new ApiError('stale revision', 409), new TypeError('network uncertain')])(
    '409 / 网络不确定先重读，再按服务器 submitted 禁用，不自动 POST：%s',
    async (error) => {
      const { get, pending, resume } = setup();
      await screen.findByText(pendingReview.node.name);
      resume.mockRejectedValue(error);
      pending.mockResolvedValue({ items: [{ ...pendingReview, submissionStatus: 'submitted' }] });
      fireEvent.click(button('通过'));
      await screen.findByText('审批结果已提交，等待工作流继续执行……');
      expect(resume).toHaveBeenCalledOnce();
      expect(get).toHaveBeenCalledTimes(2);
      expect(pending).toHaveBeenCalledTimes(2);
      expect(button('通过').disabled).toBe(true);
    },
  );

  it('submitted 初次打开也禁用审批；恢复后 failed 使用现有失败界面', async () => {
    const { get, pending } = setup();
    pending.mockResolvedValue({ items: [{ ...pendingReview, submissionStatus: 'submitted' }] });
    await screen.findByText('审批结果已提交，等待工作流继续执行……');
    expect(button('拒绝').disabled).toBe(true);
    get.mockResolvedValue({
      ...waitingRun,
      status: 'failed',
      error: { stage: 'invoke', message: '下游执行失败' },
    });
    fireEvent.click(screen.getByRole('button', { name: '手动刷新' }));
    await screen.findByText('下游执行失败');
    expect(screen.getByText('工作流运行失败')).toBeTruthy();
    expect(screen.queryByRole('region', { name: '人工审核' })).toBeNull();
  });

  it('关闭审批面板后提交仍由页面级 Hook 跟踪，重新打开保留服务器状态', async () => {
    const { pending, resume } = setup();
    await screen.findByText(pendingReview.node.name);
    let resolve!: (run: WorkflowRunResponse) => void;
    resume.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    fireEvent.click(button('通过'));
    fireEvent.click(screen.getByRole('button', { name: '关闭执行面板' }));
    pending.mockResolvedValue({ items: [{ ...pendingReview, submissionStatus: 'submitted' }] });
    await act(async () => resolve(waitingRun));
    expect(screen.queryByRole('complementary', { name: '执行与结果' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /等待继续 · 查看状态/ }));
    await screen.findByText('审批结果已提交，等待工作流继续执行……');
    expect(button('通过').disabled).toBe(true);
  });

  it('Pending capability 错误原样显示，不构造本地审批', async () => {
    const { pending } = setup();
    pending.mockRejectedValue(new ApiError('当前审核拓扑不受支持', 422));
    await screen.findByText('当前审核拓扑不受支持');
    expect(screen.queryByRole('region', { name: '人工审核' })).toBeNull();
    const panel = screen.getByRole('complementary', { name: '执行与结果' });
    expect(within(panel).getAllByRole('button', { name: '手动刷新' })).toHaveLength(2);
    await waitFor(() => expect(pending).toHaveBeenCalledOnce());
  });
});
