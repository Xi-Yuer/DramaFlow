import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { WorkflowPublishControls } from '../../../src/features/workflow/publish/workflow-publish-controls';
import type { PublishedWorkflowVersion } from '../../../src/features/workflow/publish/workflow-publish';
import { workflowPublishError } from '../../../src/features/workflow/publish/workflow-publish';
import { ApiError } from '../../../src/lib/http';

const identity: PublishedWorkflowVersion = {
  id: 'version-explicit-id',
  workflowId: 'workflow-1',
  projectId: '7ac10b00-33cc-4e50-9a2b-05ef764c44f4',
  version: 3,
  sourceRevision: 7,
  publishedAt: '2026-10-22T01:00:00.000Z',
};
const props = {
  revision: 7,
  revisionConflict: false,
  dirty: false,
  disabledReason: null,
  publishing: false,
  current: null,
  latest: null,
  error: null,
  versionsError: false,
  versionsLoading: false,
  onPublish: () => undefined,
  onRetryVersions: () => undefined,
};

describe('Publish 基础界面（静态组件测试）', () => {
  it.each([
    ['IF_TOPOLOGY_UNSUPPORTED', '分支入口'],
    ['IF_CONVERGENCE_INPUT_UNSUPPORTED', '候选输入须分别来自同一条件节点'],
    ['CONDITIONAL_WORKFLOW_OUTPUT_UNSUPPORTED', '保证执行的节点作为候选来源'],
    ['NODE_EXECUTION_KIND_UNSUPPORTED', '暂不支持运行此类节点'],
    ['CONTROL_OUTPUT_BRANCH_MISSING', '连接 true 和 false 两个分支'],
    ['SUBWORKFLOW_GRAPH_CAPABILITY_UNSUPPORTED', '子流程目前只支持普通操作'],
    ['SUBWORKFLOW_GRAPH_CANDIDATE_UNSUPPORTED', '子流程目前不支持候选输入'],
  ])('发布拒绝 %s 使用用户文案并保留安全定位', (code, message) => {
    const error = workflowPublishError(
      new ApiError('内部执行能力限制', 400, {
        code: 'WORKFLOW_PUBLISH_VALIDATION_FAILED',
        details: [{ code, nodeId: 'if_1' }],
      }),
    );
    const html = renderToStaticMarkup(<WorkflowPublishControls {...props} error={error} />);
    expect(html).toContain(message);
    expect(html).toContain('if_1');
    expect(html).not.toContain(code);
    expect(html).not.toContain('内部执行能力限制');
  });
  it('紧凑工具栏不把已发布版本误报为无版本，也不重复显示相同最新版本', () => {
    const html = renderToStaticMarkup(
      <WorkflowPublishControls {...props} compact current={identity} latest={identity} />,
    );
    expect(html).toContain('保存修订 7 已发布 · v3');
    expect(html).not.toContain('暂无已发布版本');
    expect(html).not.toContain('最新发布 v3');
  });
  it('clean 空草稿提供发布入口，不引入 Run 或历史管理入口', () => {
    const html = renderToStaticMarkup(<WorkflowPublishControls {...props} />);
    expect(html).toContain('保存修订 7 尚未发布');
    expect(html).toContain('暂无已发布版本');
    expect(html).not.toContain('disabled=');
    expect(html).not.toContain('版本历史');
    expect(html).not.toContain('开始运行');
  });
  it('dirty 明确提示先保存；publishing 禁用并显示 loading', () => {
    const dirty = renderToStaticMarkup(
      <WorkflowPublishControls {...props} dirty disabledReason="请先保存草稿，再发布" />,
    );
    expect(dirty).toContain('请先保存草稿，再发布');
    expect(dirty).toContain('disabled=');
    const publishing = renderToStaticMarkup(
      <WorkflowPublishControls {...props} publishing disabledReason="正在发布，请稍候" />,
    );
    expect(publishing).toContain('正在发布…');
    expect(publishing).toContain('ant-btn-loading');
  });
  it('当前保存修订与最新版本分开展示，后续未保存修改不冒充已发布', () => {
    const html = renderToStaticMarkup(
      <WorkflowPublishControls
        {...props}
        current={identity}
        latest={{ ...identity, version: 4, sourceRevision: 8 }}
        dirty
      />,
    );
    expect(html).toContain('保存修订 7 已发布 · v3，当前修改尚未保存');
    expect(html).toContain('最新发布 v4');
    expect(html).toContain('2026-10-22T01:00:00.000Z');
  });
  it('状态查询失败不冒充尚未发布，给出独立重试入口', () => {
    const html = renderToStaticMarkup(<WorkflowPublishControls {...props} versionsError />);
    expect(html).toContain('当前修订的发布状态待核对');
    expect(html).toContain('版本列表读取失败');
    expect(html).toContain('刷新版本状态');
    expect(html).not.toContain('暂无已发布版本');
  });
});

it('修订冲突不显示成当前草稿已发布，即使旧修订有已发布记录', () => {
  const html = renderToStaticMarkup(
    <WorkflowPublishControls
      {...props}
      revisionConflict
      current={identity}
      latest={identity}
      disabledReason="草稿修订冲突，请重新读取服务器草稿"
    />,
  );
  expect(html).toContain('草稿修订冲突，请重新读取服务器草稿');
  expect(html).not.toContain('保存修订 7 已发布');
});
