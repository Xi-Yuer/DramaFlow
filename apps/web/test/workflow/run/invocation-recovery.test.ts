import { describe, expect, it, vi } from 'vitest';
import type { StartWorkflowRunRequest, WorkflowRunResponse } from '@dramaflow/contracts';
import { ApiError } from '../../../src/lib/http';
import {
  InvocationReceiptStore,
  clearUserInvocationReceipts,
  invocationReceiptSchema,
  receiptStorageKey,
} from '../../../src/features/workflow/run/recovery/invocation-receipts';
import { InvocationRecoveryController } from '../../../src/features/workflow/run/recovery/invocation-recovery';
import { WorkflowRunController } from '../../../src/features/workflow/run/workflow-run';

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  clear() {
    this.values.clear();
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}
const scope = { userId: 'user-a', projectId: 'project-a', workflowId: 'workflow-a' };
const receipt = {
  ...scope,
  workflowVersionId: 'version-a',
  invocationKey: 'key-a',
  createdAt: '2026-10-22T00:00:00.000Z',
};
const metadata = {
  projectId: receipt.projectId,
  workflowId: receipt.workflowId,
  workflowVersionId: receipt.workflowVersionId,
  invocationKey: receipt.invocationKey,
  createdAt: receipt.createdAt,
};
const request = {
  workflowVersionId: metadata.workflowVersionId,
  invocationKey: metadata.invocationKey,
  inputs: {},
};
function run(change: Partial<WorkflowRunResponse> = {}): WorkflowRunResponse {
  return {
    id: 'run-a',
    workflowId: scope.workflowId,
    workflowVersionId: metadata.workflowVersionId,
    invocationKey: metadata.invocationKey,
    inputs: {},
    status: 'pending',
    createdAt: metadata.createdAt,
    ...change,
  };
}
function fixture(storage = new MemoryStorage(), userScope = scope) {
  const store = new InvocationReceiptStore(userScope, () => storage);
  const lookup = vi.fn(async () => ({ run: null as WorkflowRunResponse | null }));
  const start = vi.fn<(request: StartWorkflowRunRequest) => Promise<WorkflowRunResponse>>(
    async () => run(),
  );
  const recovery = new InvocationRecoveryController(store, { lookup, start });
  return { storage, store, lookup, start, recovery };
}

describe('最小 metadata receipts', () => {
  it('严格拒绝 inputs、secrets、outputs 等额外字段', () => {
    expect(invocationReceiptSchema.parse(metadata)).toEqual(metadata);
    for (const field of ['inputs', 'prompt', 'outputs', 'credential', 'definition', 'error', 'url'])
      expect(invocationReceiptSchema.safeParse({ ...metadata, [field]: 'private' }).success).toBe(
        false,
      );
  });
  it('A/B/C 独立存储，user / project / workflow 隔离，损坏数据隔离', () => {
    const f = fixture();
    for (const key of ['A', 'B', 'C']) f.store.save({ ...metadata, invocationKey: key });
    expect(f.store.list().receipts).toHaveLength(3);
    for (const other of [
      { ...scope, userId: 'user-b' },
      { ...scope, projectId: 'project-b' },
      { ...scope, workflowId: 'workflow-b' },
    ])
      expect(new InvocationReceiptStore(other, () => f.storage).list().receipts).toEqual([]);
    f.storage.setItem(receiptStorageKey(scope, 'broken'), '{');
    f.storage.setItem(receiptStorageKey(scope, 'wrong'), JSON.stringify(metadata));
    expect(f.store.list()).toMatchObject({ corrupt: true });
    expect(f.store.list().receipts).toHaveLength(3);
    expect(f.storage.getItem(receiptStorageKey(scope, 'A'))).not.toContain('inputs');
  });
  it('Logout 清理本用户，保留其他用户，并阻止旧 Tab / 异步 Store 写回', () => {
    const f = fixture();
    f.store.save(metadata);
    const other = new InvocationReceiptStore({ ...scope, userId: 'user-b' }, () => f.storage);
    other.save(metadata);
    const tab = new InvocationReceiptStore(scope, () => f.storage);
    tab.list();
    clearUserInvocationReceipts(scope.userId, f.storage);
    expect(() => f.store.save(metadata)).toThrow();
    expect(() => tab.save(metadata)).toThrow();
    expect(new InvocationReceiptStore(scope, () => f.storage).list().receipts).toEqual([]);
    expect(other.list().receipts).toHaveLength(1);
  });
});

describe('POST 持久化顺序与恢复', () => {
  it('依次明确发起 A / B / C 均保留独立 receipt', async () => {
    const f = fixture();
    f.start.mockImplementation(async (request) =>
      run({ id: `run-${request.invocationKey}`, invocationKey: request.invocationKey }),
    );
    for (const key of ['A', 'B', 'C']) await f.recovery.submit({ ...request, invocationKey: key });
    expect(f.store.list().receipts).toHaveLength(3);
    expect(f.recovery.getSnapshot().entries).toHaveLength(3);
    expect(f.start).toHaveBeenCalledTimes(3);
  });
  it('存储读取不可用时明确阻止发送', async () => {
    const f = fixture();
    vi.spyOn(f.storage, 'getItem').mockImplementation(() => {
      throw new Error('private storage disabled');
    });
    await f.recovery.refresh();
    expect(f.recovery.getSnapshot().storageError).toBe(true);
    await expect(f.recovery.submit(request)).rejects.toThrow('尚未发送');
    expect(f.start).not.toHaveBeenCalled();
  });
  it('真实 Start Controller 校验、冻结后持久化，POST 时 receipt 已存在', async () => {
    const f = fixture();
    const start = vi.fn(async (snapshot: StartWorkflowRunRequest) => {
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(f.store.list().receipts).toEqual([
        expect.objectContaining({
          workflowId: 'workflow-a',
          workflowVersionId: 'version-a',
          invocationKey: 'key-a',
        }),
      ]);
      return run();
    });
    const recovery = new InvocationRecoveryController(f.store, { lookup: f.lookup, start });
    const controller = new WorkflowRunController({
      createInvocationKey: () => 'key-a',
      start: (snapshot) => recovery.submit(snapshot),
    });
    await controller.startNew({ workflowVersionId: 'version-a', inputs: {} });
    expect(start).toHaveBeenCalledOnce();
    expect(f.store.list().receipts[0]?.workflowRunId).toBe('run-a');
  });
  it('receipt 写入失败时 zero POST，并安全说明尚未发送', async () => {
    const f = fixture();
    vi.spyOn(f.storage, 'setItem').mockImplementation(() => {
      throw new Error('private storage failure');
    });
    await expect(f.recovery.submit(request)).rejects.toThrow('运行请求尚未发送');
    expect(f.start).not.toHaveBeenCalled();
  });
  it('accepted 后刷新、或响应丢失只有 key，都只 lookup 恢复', async () => {
    for (const responseLost of [false, true]) {
      const f = fixture();
      if (responseLost) f.start.mockRejectedValueOnce(new Error('connection lost'));
      await f.recovery.submit(request).catch(() => undefined);
      const next = fixture(f.storage);
      next.lookup.mockResolvedValue({ run: run() });
      await next.recovery.refresh();
      expect(next.recovery.getSnapshot().selected?.id).toBe('run-a');
      expect(next.start).not.toHaveBeenCalled();
      expect(next.store.list().receipts[0]?.invocationKey).toBe('key-a');
    }
  });
  it('lookup null 保留 identity，不 POST、不换 key', async () => {
    const f = fixture();
    f.store.save(metadata);
    await f.recovery.refresh();
    expect(f.recovery.getSnapshot().entries[0]?.phase).toBe('unconfirmed');
    expect(f.store.list().receipts).toEqual([metadata]);
    expect(f.start).not.toHaveBeenCalled();
  });
  it('queue uncertainty 仅补写匹配请求的 runId', async () => {
    const f = fixture();
    f.start.mockRejectedValue(
      new ApiError('queue', 503, {
        code: 'WORKFLOW_QUEUE_UNAVAILABLE',
        workflowRunId: 'run-a',
        invocationKey: 'key-a',
      }),
    );
    await expect(f.recovery.submit(request)).rejects.toThrow();
    expect(f.store.list().receipts[0]?.workflowRunId).toBe('run-a');
    expect(f.start).toHaveBeenCalledOnce();
  });
  it('queue 返回其他 invocation 的身份不能保存或交给 tracking', async () => {
    const f = fixture();
    f.start.mockRejectedValue(
      new ApiError('queue', 503, {
        code: 'WORKFLOW_QUEUE_UNAVAILABLE',
        workflowRunId: 'other-run',
        invocationKey: 'other-key',
      }),
    );
    await expect(f.recovery.submit(request)).rejects.toMatchObject({
      status: 200,
      details: undefined,
    });
    expect(f.store.list().receipts[0]?.workflowRunId).toBeUndefined();
  });
  it('补写失败不重复 POST；原始 key 仍保留', async () => {
    const f = fixture();
    f.start.mockImplementation(async () => {
      vi.spyOn(f.storage, 'setItem').mockImplementation(() => {
        throw new Error('quota');
      });
      return run();
    });
    expect((await f.recovery.submit(request)).id).toBe('run-a');
    expect(f.start).toHaveBeenCalledOnce();
    expect(f.store.list().receipts[0]?.workflowRunId).toBeUndefined();
    expect(f.recovery.getSnapshot().notice).toContain('更新失败');
  });
  it('新请求明确拒绝可清理；既有 uncertain 后的 4xx 仍保留', async () => {
    const f = fixture();
    f.start.mockRejectedValueOnce(new ApiError('invalid', 400));
    await f.recovery.submit(request).catch(() => undefined);
    expect(f.store.list().receipts).toEqual([]);
    f.start
      .mockRejectedValueOnce(new Error('lost'))
      .mockRejectedValueOnce(new ApiError('invalid', 400));
    await f.recovery.submit(request).catch(() => undefined);
    await f.recovery.submit(request).catch(() => undefined);
    expect(f.store.list().receipts).toHaveLength(1);
  });
  it.each([
    { workflowId: 'other' },
    { workflowVersionId: 'other' },
    { invocationKey: 'other' },
    { id: 'other' },
  ])('身份不匹配 %j 不恢复、不覆盖 receipt', async (change) => {
    const f = fixture();
    f.store.save({ ...metadata, workflowRunId: 'run-a' });
    f.lookup.mockResolvedValue({ run: run(change) });
    await f.recovery.refresh();
    expect(f.recovery.getSnapshot().selected).toBeNull();
    expect(f.recovery.getSnapshot().entries[0]?.phase).toBe('conflict');
    expect(f.store.list().receipts[0]?.workflowRunId).toBe('run-a');
  });
  it.each(['completed', 'failed', 'cancelled', 'waiting'] as const)(
    '%s 先持有页面身份；只有 terminal 清理',
    async (status) => {
      const f = fixture();
      f.store.save(metadata);
      f.lookup.mockResolvedValue({ run: run({ status }) });
      await f.recovery.refresh();
      expect(f.recovery.getSnapshot().selected).toMatchObject({ id: 'run-a', status });
      expect(f.store.list().receipts).toHaveLength(status === 'waiting' ? 1 : 0);
      await f.recovery.refresh();
      expect(f.recovery.getSnapshot().selected?.id).toBe('run-a');
    },
  );
  it('Status 确认 terminal 清理且当前页面身份仍保留', async () => {
    const f = fixture();
    await f.recovery.submit(request);
    f.recovery.observe(run({ status: 'completed' }));
    expect(f.store.list().receipts).toEqual([]);
    expect(f.recovery.getSnapshot().selected?.status).toBe('completed');
  });
  it('Logout 后晚到的 POST 不能重新写回', async () => {
    const f = fixture();
    let resolve!: (run: WorkflowRunResponse) => void;
    f.start.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const pending = f.recovery.submit(request);
    clearUserInvocationReceipts(scope.userId, f.storage);
    resolve(run());
    await pending;
    expect(new InvocationReceiptStore(scope, () => f.storage).list().receipts).toEqual([]);
  });
});
