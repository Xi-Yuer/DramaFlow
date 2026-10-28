// @vitest-environment happy-dom
import { App, ConfigProvider } from 'antd';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type {
  StartWorkflowRunRequest,
  WorkflowRunResponse,
  WorkflowVersionResponse,
} from '@dramaflow/contracts';
import { useWorkflowRun } from '../../../../src/features/workflow/run/use-workflow-run';
import { WorkflowRunStatusView } from '../../../../src/features/workflow/run/status/workflow-run-status-controls';
import { useSignOut } from '../../../../src/features/auth/use-sign-out';
import {
  InvocationReceiptStore,
  receiptStorageKey,
} from '../../../../src/features/workflow/run/recovery/invocation-receipts';
const mocks = vi.hoisted(() => ({
  lookup: vi.fn(),
  start: vi.fn(),
  get: vi.fn(),
  signOut: vi.fn(),
  replace: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: mocks.replace }) }));
vi.mock('../../../../src/features/auth/use-identity', () => ({
  useIdentity: () => ({ data: { id: 'user-hook' } }),
}));
vi.mock('../../../../src/features/auth/auth-client', () => ({
  authClient: { signOut: mocks.signOut },
}));
vi.mock('../../../../src/features/workflow/workflow-api', async (original) => {
  const actual = await original<typeof import('../../../../src/features/workflow/workflow-api')>();
  return {
    ...actual,
    workflowApi: {
      ...actual.workflowApi,
      listVersions: async () => ({
        items: [
          {
            id: 'version-a',
            workflowId: 'workflow-a',
            projectId: 'project-a',
            version: 1,
            sourceRevision: 1,
            publishedAt: '2026-10-22T00:00:00.000Z',
          },
        ],
      }),
      getVersion: async (): Promise<WorkflowVersionResponse> => ({
        id: 'version-a',
        workflowId: 'workflow-a',
        projectId: 'project-a',
        version: 1,
        sourceRevision: 1,
        publishedAt: '2026-10-22T00:00:00.000Z',
        definition: { inputs: [], nodes: [], edges: [], outputs: [] },
      }),
      lookupInvocation: (...args: unknown[]) => mocks.lookup(...args),
      startRun: (...args: unknown[]) => mocks.start(...args),
      getRun: (...args: unknown[]) => mocks.get(...args),
    },
  };
});
const scope = { userId: 'user-hook', projectId: 'project-a', workflowId: 'workflow-a' };
const metadata = {
  projectId: scope.projectId,
  workflowId: scope.workflowId,
  workflowVersionId: 'version-a',
  invocationKey: 'key-a',
  createdAt: '2026-10-22T00:00:00.000Z',
};
const resultRun = (invocationKey = 'key-a'): WorkflowRunResponse => ({
  id: 'run-a',
  workflowId: 'workflow-a',
  workflowVersionId: 'version-a',
  invocationKey,
  status: 'running',
  inputs: {},
  createdAt: metadata.createdAt,
});
function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function TestProviders({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <ConfigProvider theme={{ token: { motion: false } }}>
          <App>{children}</App>
        </ConfigProvider>
      </QueryClientProvider>
    );
  };
}
function store() {
  return new InvocationReceiptStore(scope, () => window.localStorage);
}
beforeEach(() => {
  window.localStorage.clear();
  vi.clearAllMocks();
  mocks.lookup.mockResolvedValue({ run: null });
  mocks.start.mockImplementation(async (request: StartWorkflowRunRequest) =>
    resultRun(request.invocationKey),
  );
  mocks.get.mockResolvedValue(resultRun());
  mocks.signOut.mockResolvedValue({ error: null });
});
afterEach(cleanup);

describe('Run recovery 的真实 Hook / 组件行为', () => {
  it('unresolved → 新 Run 必须确认，取消 zero POST，确认才生成独立 key', async () => {
    store().save(metadata);
    const hook = renderHook(() => useWorkflowRun('project-a', 'workflow-a', null), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(hook.result.current.version).not.toBeNull());
    await waitFor(() => expect(hook.result.current.recovery.checking).toBe(false));
    expect(hook.result.current.uncertainInvocation).toBe(true);
    await act(async () => {
      await hook.result.current.run();
    });
    expect(await screen.findByRole('dialog')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^取\s*消$/ }));
    expect(mocks.start).not.toHaveBeenCalled();
    expect(store().list().receipts).toHaveLength(1);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await act(async () => {
      await hook.result.current.run();
    });
    fireEvent.click(await screen.findByRole('button', { name: '发起新运行' }));
    await waitFor(() => expect(mocks.start).toHaveBeenCalledOnce());
    expect(mocks.start.mock.calls[0]?.[0].invocationKey).not.toBe('key-a');
    expect(store().list().receipts).toHaveLength(2);
  });
  it('重进找到 Run 后恢复既有 Status tracking，不 POST', async () => {
    store().save(metadata);
    mocks.lookup.mockResolvedValue({ run: resultRun() });
    const hook = renderHook(() => useWorkflowRun('project-a', 'workflow-a', null), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(hook.result.current.runStatus.run?.id).toBe('run-a'));
    expect(hook.result.current.uncertainInvocation).toBe(false);
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it('恢复 completed Run 复用 Result，终态 receipt 清理和再次检查不清除当前结果', async () => {
    store().save(metadata);
    const completed: WorkflowRunResponse = {
      ...resultRun(),
      status: 'completed',
      outputs: {
        recovered: {
          storage: 'inline',
          type: { kind: 'primitive', name: 'string' },
          value: '恢复的最终结果',
        },
      },
    };
    mocks.lookup.mockResolvedValue({ run: completed });
    mocks.get.mockResolvedValue(completed);
    function RecoveredRun() {
      const workflow = useWorkflowRun('project-a', 'workflow-a', null);
      return (
        <WorkflowRunStatusView state={workflow.runStatus} onRefresh={workflow.refreshRunStatus} />
      );
    }
    render(<RecoveredRun />, { wrapper: wrapper() });
    expect(await screen.findByText('恢复的最终结果')).toBeTruthy();
    await waitFor(() => expect(store().list().receipts).toEqual([]));
    await act(async () => {
      fireEvent(
        window,
        new StorageEvent('storage', {
          key: receiptStorageKey(scope, 'key-a'),
          storageArea: window.localStorage,
        }),
      );
    });
    expect(mocks.lookup).toHaveBeenCalledOnce();
    expect(screen.getByText('恢复的最终结果')).toBeTruthy();
    expect(mocks.get).toHaveBeenCalledOnce();
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it('storage event 同步其他 Tab 的 create/update/remove，不自动 POST', async () => {
    const hook = renderHook(() => useWorkflowRun('project-a', 'workflow-a', null), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(hook.result.current.recovery.checking).toBe(false));
    store().save(metadata);
    fireEvent(
      window,
      new StorageEvent('storage', {
        key: receiptStorageKey(scope, 'key-a'),
        storageArea: window.localStorage,
      }),
    );
    await waitFor(() => expect(hook.result.current.recovery.entries).toHaveLength(1));
    store().save({ ...metadata, workflowRunId: 'run-a' });
    fireEvent(
      window,
      new StorageEvent('storage', {
        key: receiptStorageKey(scope, 'key-a'),
        storageArea: window.localStorage,
      }),
    );
    await waitFor(() =>
      expect(hook.result.current.recovery.entries[0]?.receipt.workflowRunId).toBe('run-a'),
    );
    store().remove('key-a');
    fireEvent(
      window,
      new StorageEvent('storage', {
        key: receiptStorageKey(scope, 'key-a'),
        storageArea: window.localStorage,
      }),
    );
    await waitFor(() => expect(hook.result.current.recovery.entries).toEqual([]));
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it('原 error lookup 找到同一 invocation 后解除旧 uncertainty', async () => {
    mocks.start.mockRejectedValueOnce(new Error('response lost'));
    const hook = renderHook(() => useWorkflowRun('project-a', 'workflow-a', null), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(hook.result.current.version).not.toBeNull());
    await waitFor(() => expect(hook.result.current.recovery.checking).toBe(false));
    await act(async () => {
      await hook.result.current.run();
    });
    expect(hook.result.current.state.phase).toBe('error');
    const key = store().list().receipts[0]!.invocationKey;
    mocks.lookup.mockResolvedValue({ run: resultRun(key) });
    await act(async () => {
      await hook.result.current.retryRecovery();
    });
    await waitFor(() => expect(hook.result.current.state.phase).toBe('accepted'));
    expect(hook.result.current.uncertainInvocation).toBe(false);
    expect(mocks.start).toHaveBeenCalledOnce();
  });
  it.each([false, true])('Logout failed=%s：只有成功退出清理本用户', async (failed) => {
    store().save(metadata);
    const other = new InvocationReceiptStore(
      { ...scope, userId: 'other-user' },
      () => window.localStorage,
    );
    other.save(metadata);
    if (failed) mocks.signOut.mockResolvedValue({ error: { code: 'FAILED' } });
    const hook = renderHook(useSignOut, { wrapper: wrapper() });
    await act(async () => {
      await hook.result.current.signOut();
    });
    expect(
      new InvocationReceiptStore(scope, () => window.localStorage).list().receipts,
    ).toHaveLength(failed ? 1 : 0);
    expect(other.list().receipts).toHaveLength(1);
    expect(mocks.replace).toHaveBeenCalledTimes(failed ? 0 : 1);
  });
});
