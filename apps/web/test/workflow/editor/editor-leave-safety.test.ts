import { describe, expect, it, vi } from 'vitest';
import {
  editorLeavingUnsafe,
  type EditorLeaveState,
} from '../../../src/features/workflow/editor/navigation/editor-leave-safety';
import { WorkflowRunController } from '../../../src/features/workflow/run/workflow-run';
import { ApiError } from '../../../src/lib/http';

const safe: EditorLeaveState = {
  draftDirty: false,
  metadataDirty: false,
  draftOperation: 'idle',
  savingMetadata: false,
  reloadingMetadata: false,
  publishing: false,
  run: { phase: 'idle', request: null, accepted: null, error: null },
};

describe('Editor session 离开安全语义', () => {
  it.each([
    { draftDirty: true },
    { metadataDirty: true },
    { savingMetadata: true },
    { reloadingMetadata: true },
    { draftOperation: 'saving' as const },
    { draftOperation: 'reloading' as const },
    { publishing: true },
  ])('保留现有本地修改和操作保护 %j', (change) => {
    expect(editorLeavingUnsafe({ ...safe, ...change })).toBe(true);
  });

  it.each([
    [new Error('网络中断'), true],
    [new ApiError('响应格式异常', 202), true],
    [new ApiError('请求超时', 408), true],
    [new ApiError('服务器异常', 500), true],
    [
      new ApiError('队列未确认', 503, {
        code: 'WORKFLOW_QUEUE_UNAVAILABLE',
        workflowRunId: 'run-1',
        invocationKey: 'key-1',
      }),
      true,
    ],
    [new ApiError('队列未确认且没有 ID', 503, { code: 'WORKFLOW_QUEUE_UNAVAILABLE' }), true],
    [new ApiError('已有运行身份', 409, { workflowRunId: 'run-1' }), true],
    [new ApiError('参数错误', 400), false],
    [new ApiError('没有权限', 403), false],
    [new ApiError('版本不存在', 404), false],
    [new ApiError('请求冲突', 409), false],
    [new ApiError('频率限制', 429), false],
  ])('沿用真实 Controller 的错误状态 %s，unsafe=%s', async (error, unsafe) => {
    const start = vi.fn().mockRejectedValue(error);
    const controller = new WorkflowRunController({ createInvocationKey: () => 'key-1', start });
    await controller.startNew({ workflowVersionId: 'version-1', inputs: {} });
    expect(editorLeavingUnsafe({ ...safe, run: controller.getSnapshot() })).toBe(unsafe);
    expect(start).toHaveBeenCalledOnce();
    expect(controller.getSnapshot().request?.invocationKey).toBe('key-1');
  });

  it.each(['pending', 'running', 'completed'] as const)('已受理的 %s 不要求留在页面', (status) => {
    expect(
      editorLeavingUnsafe({
        ...safe,
        run: {
          phase: 'accepted',
          request: null,
          error: null,
          accepted: { id: 'run-1', workflowVersionId: 'version-1', invocationKey: 'key-1', status },
        },
      }),
    ).toBe(false);
  });
});
