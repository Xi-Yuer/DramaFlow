import { renderToStaticMarkup } from 'react-dom/server';
import { StringType, type WorkflowVersionResponse } from '@dramaflow/contracts';
import { describe, expect, it } from 'vitest';
import { WorkflowRunControls } from '../src/features/workflow/workflow-run-controls';

const version: WorkflowVersionResponse = {
  id: 'version-explicit',
  workflowId: 'workflow-1',
  projectId: '7ac10b00-33cc-4e50-9a2b-05ef764c44f4',
  version: 3,
  sourceRevision: 7,
  publishedAt: '2026-10-22T01:00:00.000Z',
  definition: {
    inputs: [{ name: 'prompt', type: StringType, required: true }],
    nodes: [],
    edges: [],
    outputs: [],
  },
};
const props: Parameters<typeof WorkflowRunControls>[0] = {
  versions: [
    {
      id: version.id,
      workflowId: version.workflowId,
      projectId: version.projectId,
      version: version.version,
      sourceRevision: version.sourceRevision,
      publishedAt: version.publishedAt,
    },
  ],
  selectedVersionId: version.id,
  version,
  versionsLoading: false,
  versionLoading: false,
  versionsError: false,
  versionError: false,
  draftDirty: false,
  values: {
    prompt: { provided: true, explicitNull: false, value: '' },
  },
  state: {
    phase: 'idle',
    request: null,
    accepted: null,
    error: null,
  },
  runStatus: {
    phase: 'idle',
    runId: null,
    run: null,
    error: null,
    refreshing: false,
  },
  onSelectVersion: () => undefined,
  onChangeInput: () => undefined,
  onRun: () => undefined,
  onRetry: () => undefined,
  onRetryVersions: () => undefined,
  onRetryVersion: () => undefined,
  onRefreshRunStatus: () => undefined,
};

describe('Workflow Run 基础界面（静态组件测试）', () => {
  it('明确显示运行已发布版本而非 Draft，并显示 required 输入', () => {
    const html = renderToStaticMarkup(<WorkflowRunControls {...props} draftDirty />);
    expect(html).toContain('运行已发布版本 v3');
    expect(html).toContain('不是当前 Draft');
    expect(html).toContain('当前 Draft 有未保存或未发布修改');
    expect(html).toContain('prompt');
    expect(html).toContain('必填');
  });

  it('无 inputs 时允许直接运行', () => {
    const html = renderToStaticMarkup(
      <WorkflowRunControls
        {...props}
        version={{ ...version, definition: { ...version.definition, inputs: [] } }}
        values={{}}
      />,
    );
    expect(html).toContain('此版本没有 Workflow Inputs，可直接运行');
    expect(html).not.toContain('disabled=');
  });

  it('unsupported DataType 显示不支持并禁用提交', () => {
    const unsupported = {
      ...version,
      definition: {
        ...version.definition,
        inputs: [
          {
            name: 'image',
            type: { kind: 'named' as const, name: 'media.image' },
            required: true,
          },
        ],
      },
    };
    const html = renderToStaticMarkup(
      <WorkflowRunControls {...props} version={unsupported} values={{}} />,
    );
    expect(html).toContain('不支持当前类型输入');
    expect(html).toContain('disabled=');
  });

  it('submitting 禁止重复，accepted 展示保存的 WorkflowRun identity', () => {
    const submitting = renderToStaticMarkup(
      <WorkflowRunControls
        {...props}
        state={{
          phase: 'submitting',
          request: {
            workflowVersionId: version.id,
            invocationKey: 'invocation-1',
            inputs: {},
          },
          accepted: null,
          error: null,
        }}
      />,
    );
    expect(submitting).toContain('正在发起运行…');
    expect(submitting).toContain('ant-btn-loading');
    expect(submitting).toContain('disabled=');
    const accepted = renderToStaticMarkup(
      <WorkflowRunControls
        {...props}
        state={{
          phase: 'accepted',
          request: {
            workflowVersionId: version.id,
            invocationKey: 'invocation-1',
            inputs: {},
          },
          accepted: {
            id: 'run-1',
            workflowVersionId: version.id,
            invocationKey: 'invocation-1',
            status: 'pending',
          },
          error: null,
        }}
      />,
    );
    expect(accepted).toContain('运行请求已受理');
    expect(accepted).toContain('run-1');
    expect(accepted).toContain('invocation-1');
  });

  it('queue confirmation 不确定错误保留服务端身份并提供同请求重试', () => {
    const html = renderToStaticMarkup(
      <WorkflowRunControls
        {...props}
        state={{
          phase: 'error',
          request: {
            workflowVersionId: version.id,
            invocationKey: 'invocation-1',
            inputs: {},
          },
          accepted: null,
          error: {
            message: '执行命令已持久保存，入队结果尚未确认',
            status: 503,
            code: 'WORKFLOW_QUEUE_UNAVAILABLE',
            workflowRunId: 'run-persisted',
            invocationKey: 'invocation-1',
          },
        }}
      />,
    );
    expect(html).toContain('run-persisted');
    expect(html).toContain('invocation-1');
    expect(html).toContain('重试同一次请求');
  });
});
