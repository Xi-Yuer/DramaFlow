// @vitest-environment happy-dom
import { cleanup, render, screen, within } from '@testing-library/react';
import {
  AnyType,
  StringType,
  type RuntimeValue,
  type WorkflowRunResponse,
} from '@dramaflow/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkflowRunStatusView } from '../../../../src/features/workflow/run/status/workflow-run-status-controls';

afterEach(cleanup);

function showRun(overrides: Partial<WorkflowRunResponse> = {}) {
  const run: WorkflowRunResponse = {
    id: 'run-result',
    workflowId: 'workflow-result',
    workflowVersionId: 'version-result',
    invocationKey: 'invocation-result',
    status: 'completed',
    inputs: {},
    createdAt: '2026-10-22T01:00:00.000Z',
    outputs: { summary: { storage: 'inline', type: StringType, value: '最终摘要' } },
    ...overrides,
  };
  return render(
    <WorkflowRunStatusView
      state={{ phase: 'ready', runId: run.id, run, error: null, refreshing: false, review: null }}
      onRefresh={() => undefined}
    />,
  );
}

function output(name: string) {
  return within(screen.getByRole('region', { name: '运行结果' })).getByRole('article', { name });
}

describe('Workflow Run Result 展示', () => {
  it('completed 的长文本保留原始换行，HTML / Markdown 只作为文本展示', () => {
    const text = `第一行\n<script>window.resultExecuted = true</script>\n**业务文本**\n${'长文本'.repeat(1000)}`;
    showRun({ outputs: { script: { storage: 'inline', type: StringType, value: text } } });
    const content = output('script').querySelector('pre');
    expect(content?.textContent).toBe(text);
    expect(content?.querySelector('script, strong')).toBeNull();
    expect(screen.queryByText('此运行没有工作流输出')).toBeNull();
  });

  it.each(['', 0, false, null] as const)('保留 inline 值 %j，不误判为空输出或缺失输出', (value) => {
    showRun({ outputs: { value: { storage: 'inline', type: AnyType, value } } });
    expect(output('value').querySelector('pre')?.textContent).toBe(
      typeof value === 'string' ? value : JSON.stringify(value),
    );
    if (value === '') expect(within(output('value')).getByText('空字符串')).toBeTruthy();
    expect(screen.queryByText('此运行没有工作流输出')).toBeNull();
    expect(screen.queryByText('运行结果不可用')).toBeNull();
  });

  it.each([
    { value: [1, false, null] },
    { value: { title: '<img src=x onerror=alert(1)>', nested: { count: 0 } } },
  ])('array / object 以安全 pretty JSON 展示：$value', ({ value }) => {
    showRun({ outputs: { data: { storage: 'inline', type: AnyType, value } } });
    const content = output('data').querySelector('pre');
    expect(content?.textContent).toBe(JSON.stringify(value, null, 2));
    expect(content?.querySelector('img')).toBeNull();
  });

  it.each([
    { kind: 'artifact', id: 'artifact-id' },
    { kind: 'asset', id: 'asset-id', versionId: 'asset-version-id' },
  ] as const)('reference $kind 仅展示类型与完整 identity，不生成 URL 或预览', (reference) => {
    showRun({
      outputs: {
        video: { storage: 'reference', type: { kind: 'named', name: 'media.video' }, reference },
      },
    });
    const item = output('video');
    expect(within(item).getByText('引用结果')).toBeTruthy();
    expect(within(item).getByText('media.video')).toBeTruthy();
    expect(within(item).getByText(reference.kind)).toBeTruthy();
    expect(within(item).getByText(reference.id)).toBeTruthy();
    if (reference.kind === 'asset') {
      expect(within(item).getByText(reference.versionId)).toBeTruthy();
    }
    expect(within(item).getByText('暂不支持预览')).toBeTruthy();
    expect(item.querySelector('a, img, video, audio, iframe')).toBeNull();
    expect(item.innerHTML).not.toMatch(/https?:\/\//);
  });

  it('按实际 output name 展示全部结果，不依赖 result 这个名字', () => {
    const outputs: Record<string, RuntimeValue> = Object.fromEntries(
      ['title', 'summary', 'script'].map((name) => [
        name,
        { storage: 'inline', type: StringType, value: `${name} 内容` },
      ]),
    );
    showRun({ outputs });
    for (const name of Object.keys(outputs)) {
      expect(within(output(name)).getByText(`${name} 内容`)).toBeTruthy();
    }
    expect(
      within(screen.getByRole('region', { name: '运行结果' })).getAllByRole('article'),
    ).toHaveLength(3);
  });

  it('outputs = {} 是有效空结果', () => {
    showRun({ outputs: {} });
    expect(screen.getByText('此运行没有工作流输出')).toBeTruthy();
    expect(screen.queryByText('运行结果不可用')).toBeNull();
  });

  it('completed 缺少 outputs 时显示不可用，与有效空结果区分', () => {
    showRun({ outputs: undefined });
    expect(screen.getByText('运行结果不可用')).toBeTruthy();
    expect(screen.queryByText('此运行没有工作流输出')).toBeNull();
  });

  it.each(['pending', 'running', 'waiting', 'failed', 'cancelled'] as const)(
    '%s 即使携带 outputs 也不展示最终 Result，failed 保留安全错误',
    (status) => {
      showRun({
        status,
        ...(status === 'failed'
          ? { error: { stage: 'invoke', code: 'GRAPH_FAILED', message: '安全错误摘要' } }
          : {}),
      });
      expect(screen.queryByRole('region', { name: '运行结果' })).toBeNull();
      expect(screen.queryByText('最终摘要')).toBeNull();
      if (status === 'failed') expect(screen.getByText('安全错误摘要')).toBeTruthy();
    },
  );
});

it('集合运行表示只显示兼容提示，不展开引用身份', () => {
  showRun({
    outputs: {
      collection: {
        storage: 'collection',
        type: { kind: 'array', itemType: StringType },
        elements: [
          {
            storage: 'reference',
            type: StringType,
            reference: { kind: 'artifact', id: 'private-element-id' },
          },
        ],
      },
    },
  });
  expect(screen.getByText('集合值暂不支持展示')).toBeTruthy();
  expect(screen.queryByText('private-element-id')).toBeNull();
});
