import {
  BooleanType,
  NumberType,
  StringType,
  type DataType,
  type WorkflowInputDefinition,
  type WorkflowRunResponse,
} from '@dramaflow/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../src/lib/http';
import { workflowApi } from '../src/features/workflow/workflow-api';
import {
  WorkflowRunController,
  buildWorkflowRunInputs,
  workflowInputEditor,
} from '../src/features/workflow/workflow-run';

const input = (name: string, type: DataType, required = true): WorkflowInputDefinition => ({
  name,
  type,
  required,
});
const nullableString: DataType = {
  kind: 'union',
  types: [StringType, { kind: 'primitive', name: 'null' }],
};
const accepted = (request: {
  workflowVersionId: string;
  invocationKey: string;
  inputs: Record<string, unknown>;
}): WorkflowRunResponse => ({
  id: `run-${request.invocationKey}`,
  workflowId: 'workflow-1',
  workflowVersionId: request.workflowVersionId,
  invocationKey: request.invocationKey,
  status: 'pending',
  inputs: request.inputs as WorkflowRunResponse['inputs'],
  createdAt: '2026-10-22T02:00:00.000Z',
});

afterEach(() => vi.unstubAllGlobals());

describe('Workflow Version 输入表单转换', () => {
  it('无 inputs 可以 Start，optional string missing 完全省略', () => {
    expect(buildWorkflowRunInputs([], {})).toEqual({ ok: true, inputs: {} });
    expect(
      buildWorkflowRunInputs([input('note', StringType, false)], {
        note: { provided: false, explicitNull: false, value: '不应发送' },
      }),
    ).toEqual({ ok: true, inputs: {} });
  });

  it.each([
    ['required string', input('value', StringType), '', StringType],
    ['number 0', input('value', NumberType), 0, NumberType],
    ['boolean false', input('value', BooleanType), false, BooleanType],
  ] as const)('%s 保留存在性并构造成 inline RuntimeValue', (_, definition, value, type) => {
    expect(
      buildWorkflowRunInputs([definition], {
        value: { provided: true, explicitNull: false, value },
      }),
    ).toEqual({
      ok: true,
      inputs: { value: { storage: 'inline', type, value } },
    });
  });

  it('optional empty string 在明确提供后是实际值', () => {
    expect(
      buildWorkflowRunInputs([input('note', StringType, false)], {
        note: { provided: true, explicitNull: false, value: '' },
      }),
    ).toEqual({
      ok: true,
      inputs: { note: { storage: 'inline', type: StringType, value: '' } },
    });
  });

  it('nullable 与 optional 独立，required nullable 缺失仍拒绝但可明确传 null', () => {
    expect(buildWorkflowRunInputs([input('value', nullableString)], {})).toMatchObject({
      ok: false,
      issues: [{ name: 'value', code: 'required' }],
    });
    expect(
      buildWorkflowRunInputs([input('value', nullableString)], {
        value: { provided: true, explicitNull: true, value: '旧值' },
      }),
    ).toEqual({
      ok: true,
      inputs: {
        value: {
          storage: 'inline',
          type: { kind: 'primitive', name: 'null' },
          value: null,
        },
      },
    });
    expect(buildWorkflowRunInputs([input('value', nullableString, false)], {})).toEqual({
      ok: true,
      inputs: {},
    });
  });

  const unsupportedTypes: DataType[] = [
    { kind: 'any' },
    { kind: 'named', name: 'media.image' },
    { kind: 'array', itemType: StringType },
    { kind: 'object', properties: { value: StringType } },
    { kind: 'union', types: [StringType, NumberType] },
  ];
  it.each(unsupportedTypes)('unsupported DataType %j 不伪造 string 编辑器并阻止提交', (type) => {
    expect(workflowInputEditor(type)).toEqual({ kind: 'unsupported', nullable: false });
    expect(buildWorkflowRunInputs([input('value', type)], {})).toMatchObject({
      ok: false,
      issues: [{ name: 'value', code: 'unsupported' }],
    });
  });
});

describe('Start Run 请求控制器', () => {
  function fixture() {
    const requests: Parameters<typeof accepted>[0][] = [];
    let release: ((result: WorkflowRunResponse) => void) | undefined;
    const start = vi.fn(
      (request: Parameters<typeof accepted>[0]) =>
        new Promise<WorkflowRunResponse>((resolve) => {
          requests.push(structuredClone(request));
          release = resolve;
        }),
    );
    const keys = ['invocation-1', 'invocation-2'];
    const controller = new WorkflowRunController({
      createInvocationKey: () => keys.shift() ?? 'unexpected-key',
      start,
    });
    return {
      controller,
      start,
      requests,
      resolve: () => release?.(accepted(requests.at(-1)!)),
    };
  }

  it('请求使用明确 workflowVersionId；submitting 防重复；accepted 保存 Run identity', async () => {
    const f = fixture();
    const first = f.controller.startNew({
      workflowVersionId: 'version-explicit',
      inputs: {},
    });
    expect(f.controller.getSnapshot()).toMatchObject({
      phase: 'submitting',
      request: {
        workflowVersionId: 'version-explicit',
        invocationKey: 'invocation-1',
        inputs: {},
      },
    });
    await f.controller.startNew({ workflowVersionId: 'version-other', inputs: {} });
    expect(f.start).toHaveBeenCalledOnce();
    f.resolve();
    await first;
    expect(f.controller.getSnapshot()).toMatchObject({
      phase: 'accepted',
      accepted: {
        id: 'run-invocation-1',
        workflowVersionId: 'version-explicit',
        invocationKey: 'invocation-1',
        status: 'pending',
      },
    });
  });

  it('同一请求重试复用冻结的版本、inputs 和 invocationKey；新 Run 才生成新 key', async () => {
    const starts: Parameters<typeof accepted>[0][] = [];
    const start = vi
      .fn()
      .mockImplementationOnce(async (request: Parameters<typeof accepted>[0]) => {
        starts.push(structuredClone(request));
        throw new Error('网络未确认');
      })
      .mockImplementation(async (request: Parameters<typeof accepted>[0]) => {
        starts.push(structuredClone(request));
        return accepted(request);
      });
    const keys = ['invocation-1', 'invocation-2'];
    const controller = new WorkflowRunController({
      createInvocationKey: () => keys.shift()!,
      start,
    });
    const inputs = {
      prompt: { storage: 'inline' as const, type: StringType, value: '初始内容' },
    };
    await controller.startNew({ workflowVersionId: 'version-1', inputs });
    inputs.prompt.value = '后来修改';
    await controller.retry();
    expect(starts[1]).toEqual(starts[0]);
    expect(starts[1]).toMatchObject({
      workflowVersionId: 'version-1',
      invocationKey: 'invocation-1',
      inputs: { prompt: { value: '初始内容' } },
    });
    await controller.startNew({ workflowVersionId: 'version-2', inputs: {} });
    expect(starts[2]?.invocationKey).toBe('invocation-2');
  });

  it('queue confirmation 不确定时保留 workflowRunId / invocationKey，不生成新 key', async () => {
    const start = vi.fn().mockRejectedValue(
      new ApiError('执行命令已持久保存，入队结果尚未确认', 503, {
        code: 'WORKFLOW_QUEUE_UNAVAILABLE',
        workflowRunId: 'run-persisted',
        invocationKey: 'invocation-1',
      }),
    );
    const createInvocationKey = vi.fn(() => 'invocation-1');
    const controller = new WorkflowRunController({ createInvocationKey, start });
    await controller.startNew({ workflowVersionId: 'version-1', inputs: {} });
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'error',
      error: {
        code: 'WORKFLOW_QUEUE_UNAVAILABLE',
        workflowRunId: 'run-persisted',
        invocationKey: 'invocation-1',
      },
      request: { invocationKey: 'invocation-1' },
    });
    expect(createInvocationKey).toHaveBeenCalledOnce();
  });
});

describe('Start Run HTTP', () => {
  it('提交固定的 workflowVersionId、invocationKey、inputs', async () => {
    const request = {
      workflowVersionId: 'version-1',
      invocationKey: 'invocation-1',
      inputs: {
        count: { storage: 'inline' as const, type: NumberType, value: 0 },
      },
    };
    const response = accepted(request);
    const fetch = vi.fn().mockResolvedValue(Response.json(response, { status: 202 }));
    vi.stubGlobal('fetch', fetch);
    expect(await workflowApi.startRun(request)).toEqual(response);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      '/api/v1/workflow-runs',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify(request),
        credentials: 'same-origin',
      }),
    );
  });
});
