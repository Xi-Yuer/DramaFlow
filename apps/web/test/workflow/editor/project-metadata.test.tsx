// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Project } from '@dramaflow/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../src/lib/http';
import { projectApi, projectKeys } from '../../../src/features/projects/project-api';
import { useProjectMetadata } from '../../../src/features/projects/metadata/use-project-metadata';

const feedback = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  confirm: vi.fn<(options: { onOk: () => Promise<void> }) => void>(),
  push: vi.fn(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: feedback.push }) }));
vi.mock('antd', () => ({
  App: { useApp: () => ({ message: feedback, modal: { confirm: feedback.confirm } }) },
}));
vi.mock('../../../src/features/projects/project-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/features/projects/project-api')>()),
  projectApi: { save: vi.fn(), get: vi.fn(), remove: vi.fn() },
}));

const project: Project = {
  id: '7ac10b00-33cc-4e50-9a2b-05ef764c44f4',
  name: '原项目',
  revision: 1,
  createdAt: '2026-10-27T00:00:00.000Z',
  updatedAt: '2026-10-27T00:00:00.000Z',
};

function mount() {
  const cache = new QueryClient();
  cache.setQueryData(projectKeys.detail(project.id), project);
  return {
    ...renderHook(() => useProjectMetadata(project), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={cache}>{children}</QueryClientProvider>
      ),
    }),
    cache,
  };
}

beforeEach(() => vi.resetAllMocks());
afterEach(cleanup);

describe('项目元数据保存与冲突恢复', () => {
  it('同一时刻只保存一次，响应只确认提交快照，保留请求期间的新修改', async () => {
    let complete!: (value: Project) => void;
    vi.mocked(projectApi.save).mockReturnValue(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    const { result, cache } = mount();
    act(() => result.current.setName('第一次修改'));
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.save();
    });
    await act(async () => {
      await result.current.save();
    });
    expect(projectApi.save).toHaveBeenCalledExactlyOnceWith(project.id, {
      revision: 1,
      name: '第一次修改',
    });
    act(() => result.current.setName('保存期间继续修改'));
    await act(async () => {
      complete({ ...project, revision: 2 });
      await pending;
    });
    expect(result.current.revision).toBe(2);
    expect(result.current.name).toBe('保存期间继续修改');
    expect(result.current.dirty).toBe(true);
    expect(result.current.saving).toBe(false);
    expect(cache.getQueryData(projectKeys.detail(project.id))).toMatchObject({
      name: '第一次修改',
      revision: 2,
    });
  });

  it('409 保留本地修改并阻止覆盖，确认重读后同步项目名称与修订', async () => {
    vi.mocked(projectApi.save).mockRejectedValue(new ApiError('修订冲突', 409));
    const server = {
      ...project,
      name: '服务器项目',
      revision: 3,
    };
    vi.mocked(projectApi.get).mockResolvedValue(server);
    const { result } = mount();
    act(() => result.current.setName('本地修改'));
    await act(async () => {
      await result.current.save();
    });
    expect(result.current.conflict).toBe(true);
    expect(result.current.name).toBe('本地修改');
    await act(async () => {
      await result.current.save();
    });
    expect(projectApi.save).toHaveBeenCalledTimes(1);
    act(() => result.current.reloadProject());
    expect(projectApi.get).not.toHaveBeenCalled();
    await act(async () => {
      await feedback.confirm.mock.calls[0]![0].onOk();
    });
    expect(result.current.name).toBe(server.name);
    expect(result.current.revision).toBe(3);
    expect(result.current.conflict).toBe(false);
    expect(result.current.dirty).toBe(false);
  });

  it('网络结果不明时保留修改与错误，不标记已保存或自动重放请求', async () => {
    vi.mocked(projectApi.save).mockRejectedValue(new Error('网络断开'));
    const { result } = mount();
    act(() => result.current.setName('待保存'));
    await act(async () => {
      await result.current.save();
    });
    expect(result.current.projectError).toBe('网络断开');
    expect(result.current.dirty).toBe(true);
    expect(result.current.revision).toBe(1);
    expect(projectApi.save).toHaveBeenCalledTimes(1);
    expect(feedback.success).not.toHaveBeenCalled();
  });
});
