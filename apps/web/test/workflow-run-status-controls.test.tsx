import { renderToStaticMarkup } from 'react-dom/server';
import { StringType, type WorkflowRunResponse, type WorkflowRunStatus } from '@dramaflow/contracts';
import { describe, expect, it } from 'vitest';
import { WorkflowRunStatusView } from '../src/features/workflow/workflow-run-status-controls';
import type { WorkflowRunStatusState } from '../src/features/workflow/workflow-run-status';

function run(status: WorkflowRunStatus): WorkflowRunResponse {
  return {
    id: 'run-1',
    workflowId: 'workflow-1',
    workflowVersionId: 'version-3',
    invocationKey: 'invocation-1',
    status,
    inputs: {
      secretPrompt: { storage: 'inline', type: StringType, value: '不得展示' },
    },
    outputs: {
      secretResult: { storage: 'inline', type: StringType, value: '本阶段不得展示' },
    },
    createdAt: '2026-10-22T01:00:00.000Z',
    startedAt: '2026-10-22T01:00:02.000Z',
    completedAt: '2026-10-22T01:00:05.000Z',
    ...(status === 'failed'
      ? { error: { stage: 'invoke', code: 'GRAPH_FAILED', message: '安全错误摘要' } }
      : {}),
  };
}

const state = (status: WorkflowRunStatus): WorkflowRunStatusState => ({
  phase: 'ready',
  runId: 'run-1',
  run: run(status),
  error: null,
  refreshing: false,
});

describe('Workflow Run Status 基础界面（静态组件测试）', () => {
  it.each([
    ['pending', '等待执行'],
    ['running', '运行中'],
    ['waiting', '等待继续'],
    ['completed', '已完成'],
    ['failed', '失败'],
    ['cancelled', '已取消'],
  ] as const)('明确区分 %s 状态', (status, label) => {
    const html = renderToStaticMarkup(
      <WorkflowRunStatusView state={state(status)} onRefresh={() => undefined} />,
    );
    expect(html).toContain(label);
    expect(html).toContain('run-1');
    expect(html).toContain('version-3');
    expect(html).toContain('invocation-1');
  });

  it('waiting 明确提示等待外部或人工继续，但不提供 Resume', () => {
    const html = renderToStaticMarkup(
      <WorkflowRunStatusView state={state('waiting')} onRefresh={() => undefined} />,
    );
    expect(html).toContain('工作流正在等待外部/人工继续');
    expect(html).not.toContain('Resume');
    expect(html).not.toContain('继续运行');
  });

  it('failed 展示安全错误和统一结束时间，不展示内部数据', () => {
    const html = renderToStaticMarkup(
      <WorkflowRunStatusView state={state('failed')} onRefresh={() => undefined} />,
    );
    expect(html).toContain('安全错误摘要');
    expect(html).toContain('GRAPH_FAILED');
    expect(html).toContain('invoke');
    expect(html).toContain('结束时间');
    expect(html).not.toContain('完成时间');
    expect(html).not.toContain('不得展示');
    expect(html).not.toContain('本阶段不得展示');
    expect(html).not.toContain('threadId');
  });

  it('completed 仅展示状态与时间，不解析 outputs', () => {
    const html = renderToStaticMarkup(
      <WorkflowRunStatusView state={state('completed')} onRefresh={() => undefined} />,
    );
    expect(html).toContain('已完成');
    expect(html).toContain('创建时间');
    expect(html).toContain('开始时间');
    expect(html).toContain('结束时间');
    expect(html).not.toContain('secretResult');
    expect(html).not.toContain('本阶段不得展示');
  });

  it('查询错误提供手动刷新入口', () => {
    const html = renderToStaticMarkup(
      <WorkflowRunStatusView
        state={{
          phase: 'error',
          runId: 'run-1',
          run: null,
          error: { message: '状态读取失败', status: 503 },
          refreshing: false,
        }}
        onRefresh={() => undefined}
      />,
    );
    expect(html).toContain('状态读取失败');
    expect(html).toContain('手动刷新');
  });
});
