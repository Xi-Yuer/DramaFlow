// @vitest-environment happy-dom
import { useState } from 'react';
import { App, ConfigProvider } from 'antd';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StringType, type WorkflowRunResponse } from '@dramaflow/contracts';
import {
  WorkflowExecutionWorkspace,
  type WorkflowExecutionWorkspaceProps,
} from '../src/features/workflow/editor/workflow-execution-workspace';

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
        if (init?.signal?.aborted) {
          abort();
          return;
        }
        init?.signal?.addEventListener('abort', abort, { once: true });
      });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const completed: WorkflowRunResponse = {
  id: 'run-workspace',
  workflowId: 'workflow-a',
  workflowVersionId: 'fixed-version',
  invocationKey: 'fixed-invocation',
  status: 'completed',
  inputs: {},
  outputs: { script: { storage: 'inline', type: StringType, value: '恢复后的最终剧本\n第二行' } },
  createdAt: '2026-10-23T01:00:00.000Z',
};
function fixture(): WorkflowExecutionWorkspaceProps {
  return {
    children: <div data-testid="canvas">工作流画布</div>,
    publication: <span>保存修订 2 已发布 · v1</span>,
    recovery: { checking: false, entries: [], selected: null, notice: null, storageError: false },
    onRetryRecovery: vi.fn(),
    onSelectRecovered: vi.fn(),
    run: {
      versions: [
        {
          id: completed.workflowVersionId,
          workflowId: completed.workflowId,
          projectId: 'project-a',
          version: 1,
          sourceRevision: 2,
          publishedAt: completed.createdAt,
        },
      ],
      selectedVersionId: completed.workflowVersionId,
      version: {
        id: completed.workflowVersionId,
        workflowId: completed.workflowId,
        projectId: 'project-a',
        version: 1,
        sourceRevision: 2,
        publishedAt: completed.createdAt,
        definition: {
          inputs: [{ name: 'topic', type: StringType, required: true }],
          nodes: [],
          edges: [],
          outputs: [],
        },
      },
      values: { topic: { provided: true, explicitNull: false, value: '原始主题' } },
      versionsLoading: false,
      versionLoading: false,
      versionsError: false,
      versionError: false,
      draftDirty: false,
      state: { phase: 'idle', accepted: null, request: null, error: null },
      runStatus: {
        phase: 'idle',
        runId: null,
        run: null,
        error: null,
        refreshing: false,
        review: null,
      },
      onSelectVersion: vi.fn(),
      onChangeInput: vi.fn(),
      onRun: vi.fn(),
      onRetry: vi.fn(),
      onRetryVersions: vi.fn(),
      onRetryVersion: vi.fn(),
      onRefreshRunStatus: vi.fn(),
    },
  };
}
function page(props: WorkflowExecutionWorkspaceProps) {
  return (
    <ConfigProvider theme={{ token: { motion: false } }}>
      <App>
        <WorkflowExecutionWorkspace {...props} />
      </App>
    </ConfigProvider>
  );
}
function tracked(props: WorkflowExecutionWorkspaceProps) {
  return {
    ...props,
    run: {
      ...props.run,
      runStatus: {
        phase: 'ready' as const,
        runId: completed.id,
        run: completed,
        error: null,
        refreshing: false,
        review: null,
      },
    },
  };
}

describe('Editor 执行与结果工作区', () => {
  it('提交中关闭面板不会取消请求，受理响应到达后也不会强制弹回', () => {
    const props = fixture();
    props.run.state = {
      phase: 'submitting',
      request: {
        workflowVersionId: completed.workflowVersionId,
        invocationKey: completed.invocationKey,
        inputs: {},
      },
      accepted: null,
      error: null,
    };
    const view = render(page(props));
    fireEvent.click(screen.getByRole('button', { name: '运行工作流' }));
    expect(screen.getByRole('button', { name: '提交中…' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '关闭执行面板' }));
    const accepted = tracked(props);
    accepted.run.state = {
      ...props.run.state,
      phase: 'accepted',
      accepted: {
        id: completed.id,
        workflowVersionId: completed.workflowVersionId,
        invocationKey: completed.invocationKey,
        status: 'pending',
      },
    };
    view.rerender(page(accepted));
    expect(screen.queryByRole('complementary', { name: '执行与结果' })).toBeNull();
    expect(screen.getByRole('button', { name: '已完成 · 查看结果' })).toBeTruthy();
    expect(props.run.onRun).not.toHaveBeenCalled();
    expect(props.run.onRetry).not.toHaveBeenCalled();
  });

  it('只剩一个其他 Run 可恢复时仍保留切换入口，不把它当成当前 Run 隐藏', async () => {
    const props = tracked(fixture());
    const other = {
      ...completed,
      id: 'older-run-a',
      invocationKey: 'older-invocation',
      status: 'running' as const,
    };
    props.recovery = {
      ...props.recovery,
      selected: completed,
      entries: [
        {
          phase: 'found',
          run: other,
          receipt: {
            projectId: 'project-a',
            workflowId: other.workflowId,
            workflowVersionId: other.workflowVersionId,
            invocationKey: other.invocationKey,
            createdAt: other.createdAt,
          },
        },
      ],
    };
    render(page(props));
    fireEvent.mouseDown(screen.getByRole('combobox', { name: '选择恢复的运行' }));
    expect(await screen.findByRole('option', { name: /older-ru/ })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('combobox', { name: '选择恢复的运行' }), {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
    });
    expect(vi.mocked(props.onSelectRecovered).mock.calls[0]?.[0]).toBe(other.invocationKey);
    expect(props.run.onRun).not.toHaveBeenCalled();
  });

  it('默认只显示紧凑工具栏和画布；打开 / 关闭面板不重建画布，也不发起运行', () => {
    const props = fixture();
    render(page(props));
    const canvas = screen.getByTestId('canvas');
    expect(screen.queryByRole('complementary', { name: '执行与结果' })).toBeNull();
    const trigger = screen.getByRole('button', { name: '运行工作流' });
    fireEvent.click(trigger);
    expect(screen.getByRole('complementary', { name: '执行与结果' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'topic 输入' })).toHaveProperty('value', '原始主题');
    expect(props.run.onRun).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '关闭执行面板' }));
    expect(screen.queryByRole('complementary', { name: '执行与结果' })).toBeNull();
    expect(screen.getByTestId('canvas')).toBe(canvas);
    expect(document.activeElement).toBe(trigger);
  });

  it('关闭后重新打开保留输入；只有面板内明确运行才触发提交', () => {
    const props = fixture();
    function Editor() {
      const [value, setValue] = useState('原始主题');
      return page({
        ...props,
        run: {
          ...props.run,
          values: { topic: { provided: true, explicitNull: false, value } },
          onChangeInput: (_, next) => setValue(String(next.value)),
        },
      });
    }
    render(<Editor />);
    fireEvent.click(screen.getByRole('button', { name: '运行工作流' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'topic 输入' }), {
      target: { value: '保留的新主题' },
    });
    fireEvent.click(screen.getByRole('button', { name: '关闭执行面板' }));
    fireEvent.click(screen.getByRole('button', { name: '运行工作流' }));
    expect(screen.getByRole('textbox', { name: 'topic 输入' })).toHaveProperty(
      'value',
      '保留的新主题',
    );
    fireEvent.click(
      within(screen.getByRole('complementary', { name: '执行与结果' })).getByRole('button', {
        name: /^运\s*行$/,
      }),
    );
    expect(props.run.onRun).toHaveBeenCalledOnce();
  });

  it('受理后自动显示状态与结果；关闭后同一个 Run 的状态刷新不会强制重开', () => {
    const props = fixture();
    const view = render(page(props));
    const accepted = tracked(props);
    accepted.run.state = {
      phase: 'accepted',
      request: {
        workflowVersionId: completed.workflowVersionId,
        invocationKey: completed.invocationKey,
        inputs: {},
      },
      accepted: {
        id: completed.id,
        workflowVersionId: completed.workflowVersionId,
        invocationKey: completed.invocationKey,
        status: 'pending',
      },
      error: null,
    };
    view.rerender(page(accepted));
    expect(screen.getByRole('tab', { name: '状态与结果' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(screen.getByRole('region', { name: '运行结果' }).textContent).toContain(
      '恢复后的最终剧本',
    );
    expect(screen.queryByText('运行请求已受理')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '关闭执行面板' }));
    view.rerender(
      page({
        ...accepted,
        run: { ...accepted.run, runStatus: { ...accepted.run.runStatus, refreshing: true } },
      }),
    );
    expect(screen.queryByRole('complementary', { name: '执行与结果' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '已完成 · 查看结果' }));
    expect(screen.getByRole('region', { name: '运行结果' }).textContent).toContain(
      '恢复后的最终剧本',
    );
    expect(props.run.onRun).not.toHaveBeenCalled();
  });

  it('recovery 的 completed Run 复用结果，receipt 清理不清除面板中的结果', () => {
    const props = tracked(fixture());
    props.recovery = {
      ...props.recovery,
      selected: completed,
      entries: [
        {
          phase: 'found',
          run: completed,
          receipt: {
            projectId: 'project-a',
            workflowId: completed.workflowId,
            workflowVersionId: completed.workflowVersionId,
            invocationKey: completed.invocationKey,
            createdAt: completed.createdAt,
          },
        },
      ],
    };
    const view = render(page(props));
    expect(screen.getByRole('region', { name: '运行结果' })).toBeTruthy();
    expect(screen.queryByText('重新查询运行身份')).toBeNull();
    view.rerender(page({ ...props, recovery: { ...props.recovery, entries: [] } }));
    expect(screen.getByRole('region', { name: '运行结果' }).textContent).toContain(
      '恢复后的最终剧本',
    );
  });

  it('技术 identity 默认收起，用户展开运行详情后可查看完整标识', () => {
    render(page(tracked(fixture())));
    expect(screen.queryByText(completed.invocationKey)).toBeNull();
    fireEvent.click(screen.getByText('运行详情'));
    expect(screen.getByText(completed.invocationKey)).toBeTruthy();
    expect(screen.getByText(completed.workflowVersionId)).toBeTruthy();
    expect(screen.getByText(completed.id)).toBeTruthy();
  });

  it('不确定请求自动提示并保留原 retry；只关闭面板不会提交或重试', () => {
    const props = fixture();
    props.run.state = {
      phase: 'error',
      request: {
        workflowVersionId: completed.workflowVersionId,
        invocationKey: completed.invocationKey,
        inputs: {},
      },
      accepted: null,
      error: { message: '运行请求结果未确认', status: 0 },
    };
    render(page(props));
    expect(screen.getByText('运行请求结果未确认')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '关闭执行面板' }));
    expect(screen.getByRole('button', { name: '请求待确认' })).toBeTruthy();
    expect(props.run.onRetry).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '请求待确认' }));
    fireEvent.click(screen.getByRole('button', { name: '重试同一次请求' }));
    expect(props.run.onRetry).toHaveBeenCalledOnce();
    expect(props.run.onRun).not.toHaveBeenCalled();
  });
});
