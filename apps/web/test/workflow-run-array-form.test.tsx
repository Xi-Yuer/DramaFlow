// @vitest-environment happy-dom
import { App, ConfigProvider } from 'antd';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BooleanType,
  NumberType,
  StringType,
  type DataType,
  type GraphInputDefinition,
  type StartWorkflowRunRequest,
  type WorkflowVersionResponse,
} from '@dramaflow/contracts';
import { useWorkflowRun } from '../src/features/workflow/run/use-workflow-run';
import { WorkflowRunControls } from '../src/features/workflow/run/workflow-run-controls';

vi.mock('../src/features/auth/use-identity', () => ({
  useIdentity: () => ({ data: { id: 'array-form-user' } }),
}));

const list = (itemType: DataType): DataType => ({ kind: 'array', itemType });
const input = (name: string, type: DataType, required = true): GraphInputDefinition => ({
  name,
  type,
  required,
});
let client: QueryClient;

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  cleanup();
  client?.clear();
  vi.unstubAllGlobals();
});

async function setup(inputs: GraphInputDefinition[]) {
  const version: WorkflowVersionResponse = {
    id: 'version-array',
    workflowId: 'workflow-array',
    projectId: '7ac10b00-33cc-4e50-9a2b-05ef764c44f4',
    version: 1,
    sourceRevision: 2,
    publishedAt: '2026-10-26T00:00:00.000Z',
    definition: { inputs, nodes: [], edges: [], outputs: [] },
  };
  const requests: StartWorkflowRunRequest[] = [];
  const fetch = vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith('/versions')) {
      const summary = {
        id: version.id,
        workflowId: version.workflowId,
        projectId: version.projectId,
        version: version.version,
        sourceRevision: version.sourceRevision,
        publishedAt: version.publishedAt,
      };
      return Response.json({ items: [summary], nextBeforeVersion: null });
    }
    if (url.endsWith(`/workflow-versions/${version.id}`)) return Response.json(version);
    if (url.endsWith('/workflow-runs') && options?.method === 'POST') {
      const request = JSON.parse(options.body as string) as StartWorkflowRunRequest;
      requests.push(request);
      return Response.json(
        {
          ...request,
          id: 'run-array',
          workflowId: version.workflowId,
          status: 'pending',
          createdAt: version.publishedAt,
        },
        { status: 202 },
      );
    }
    if (url.endsWith('/workflow-runs/run-array')) {
      return Response.json({
        ...requests[0],
        id: 'run-array',
        workflowId: version.workflowId,
        status: 'pending',
        createdAt: version.publishedAt,
      });
    }
    throw new Error(`非预期请求 ${url}`);
  });
  vi.stubGlobal('fetch', fetch);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  function RunForm() {
    const run = useWorkflowRun(version.projectId, version.workflowId, null);
    return (
      <WorkflowRunControls
        {...run}
        draftDirty={false}
        submissionDisabled={run.recovery.checking || !!run.recovery.storageError}
        onSelectVersion={run.selectVersion}
        onChangeInput={run.changeInput}
        onRun={() => void run.run()}
        onRetry={() => void run.retry()}
        onRetryVersions={() => void run.retryVersions()}
        onRetryVersion={() => void run.retryVersion()}
        onRefreshRunStatus={() => void run.refreshRunStatus()}
      />
    );
  }
  render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <App>
        <QueryClientProvider client={client}>
          <RunForm />
        </QueryClientProvider>
      </App>
    </ConfigProvider>,
  );
  await screen.findByText('运行已发布版本 v1（保存修订 2），不是当前 Draft');
  return { requests, fetch };
}

function add(name: string) {
  fireEvent.click(screen.getByRole('button', { name: `添加 ${name} 一项` }));
}
function change(name: string, index: number, value: string, numeric = false) {
  fireEvent.change(
    screen.getByRole(numeric ? 'spinbutton' : 'textbox', { name: `${name} 第 ${index} 项` }),
    {
      target: { value },
    },
  );
}
function runButton() {
  return screen.getByRole('button', { name: /^运\s*行$/ });
}

describe('Run Form 通用数组输入 → Hook → HTTP payload', () => {
  it('text[] 可以增删，删除中间项后保持顺序，并实际提交 A / B / C', async () => {
    const view = await setup([input('fruits', list(StringType))]);
    expect(screen.queryAllByRole('textbox')).toHaveLength(0);
    expect(runButton()).toHaveProperty('disabled', true);
    for (const [index, value] of ['A', '待删', 'B'].entries()) {
      add('fruits');
      change('fruits', index + 1, value);
    }
    fireEvent.click(screen.getByRole('button', { name: '删除 fruits 第 2 项' }));
    expect(screen.getByRole('textbox', { name: 'fruits 第 2 项' })).toHaveProperty('value', 'B');
    add('fruits');
    change('fruits', 3, 'C');
    expect(runButton()).toHaveProperty('disabled', false);
    fireEvent.click(runButton());
    await waitFor(() => expect(view.requests).toHaveLength(1));
    expect(view.requests[0]?.workflowVersionId).toBe('version-array');
    expect(view.requests[0]?.inputs.fruits).toEqual({
      storage: 'inline',
      type: list(StringType),
      value: ['A', 'B', 'C'],
    });
  });

  it('number[] 拒绝空项，不回退旧值或制造 0，提交真正的 number[]', async () => {
    const view = await setup([input('counts', list(NumberType))]);
    add('counts');
    change('counts', 1, '12', true);
    change('counts', 1, '', true);
    expect(runButton()).toHaveProperty('disabled', true);
    fireEvent.click(runButton());
    expect(view.requests).toEqual([]);
    change('counts', 1, '0', true);
    add('counts');
    change('counts', 2, '-2.5', true);
    add('counts');
    change('counts', 3, '3', true);
    fireEvent.click(runButton());
    await waitFor(() => expect(view.requests).toHaveLength(1));
    expect(view.requests[0]?.inputs.counts).toEqual({
      storage: 'inline',
      type: list(NumberType),
      value: [0, -2.5, 3],
    });
  });

  it('空白文本项阻止提交，删除全部项后 required 数组仍不可运行', async () => {
    const view = await setup([input('lines', list(StringType))]);
    add('lines');
    change('lines', 1, '   ');
    expect(screen.getByRole('alert').textContent).toContain('第 1 项不能为空白');
    expect(runButton()).toHaveProperty('disabled', true);
    fireEvent.click(runButton());
    fireEvent.click(screen.getByRole('button', { name: '删除 lines 第 1 项' }));
    expect(runButton()).toHaveProperty('disabled', true);
    expect(view.requests).toEqual([]);
  });

  it.each([false, true])('optional 数组为空，provided=%s 沿用存在性约定', async (provided) => {
    const view = await setup([input('notes', list(StringType), false)]);
    expect(screen.queryAllByRole('textbox')).toHaveLength(0);
    expect(screen.getByRole('button', { name: '添加 notes 一项' })).toHaveProperty(
      'disabled',
      true,
    );
    if (provided) fireEvent.click(screen.getByRole('checkbox', { name: '提供此输入' }));
    await waitFor(() => expect(runButton()).toHaveProperty('disabled', false));
    fireEvent.click(runButton());
    await waitFor(() => expect(view.requests).toHaveLength(1));
    expect(view.requests[0]?.inputs).toEqual(
      provided
        ? {
            notes: { storage: 'inline', type: list(StringType), value: [] },
          }
        : {},
    );
  });

  it('scalar text 空字符串、number 0、boolean false 继续原样提交', async () => {
    const view = await setup([
      input('text', StringType),
      input('count', NumberType),
      input('enabled', BooleanType),
    ]);
    fireEvent.change(screen.getByRole('spinbutton', { name: 'count 输入' }), {
      target: { value: '0' },
    });
    await waitFor(() => expect(runButton()).toHaveProperty('disabled', false));
    fireEvent.click(runButton());
    await waitFor(() => expect(view.requests).toHaveLength(1));
    expect(view.requests[0]?.inputs).toEqual({
      text: { storage: 'inline', type: StringType, value: '' },
      count: { storage: 'inline', type: NumberType, value: 0 },
      enabled: { storage: 'inline', type: BooleanType, value: false },
    });
  });
});
