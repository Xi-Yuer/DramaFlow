import { renderToStaticMarkup } from 'react-dom/server';
import { ReactFlowProvider, type NodeProps } from '@xyflow/react';
import { describe, expect, it } from 'vitest';
import type { NodeRun, WorkflowDefinition } from '@dramaflow/contracts';
import {
  GenericWorkflowNode,
  WorkflowManifestProvider,
} from '../../../src/features/workflow/canvas/rendering/workflow-node';
import {
  toReactFlowNode,
  type WorkflowNode,
} from '../../../src/features/workflow/canvas/react-flow-adapter';
import { RuntimeCanvasStatus } from '../../../src/features/workflow/runtime/presentation/runtime-canvas-status';
import { getRuntimeNodePresentation } from '../../../src/features/workflow/runtime/presentation/runtime-presentation';
import {
  WorkflowRuntimeProvider,
  type RuntimeNodeStatus,
} from '../../../src/features/workflow/runtime/runtime-status';
import { humanReviewManifest, pendingReview, waitingRun } from '../../fixtures/human-review';

const workflow: WorkflowDefinition = {
  nodes: [
    {
      id: 'review-1',
      type: 'flow.human_review',
      typeVersion: 1,
      name: '角色审核',
      inputs: {},
      config: {},
      ui: { position: { x: 0, y: 0 } },
    },
  ],
  edges: [],
  inputs: [],
  outputs: [],
};

function renderNode(status: RuntimeNodeStatus, selected = false) {
  const node = toReactFlowNode(workflow.nodes[0]);
  const nodeRuns: NodeRun[] =
    status === 'running' || status === 'waiting' || status === 'completed' || status === 'failed'
      ? [
          {
            id: 'node-run-1',
            workflowRunId: waitingRun.id,
            nodeId: node.id,
            occurrenceId: `occurrence-${node.id}`,
            scopeKey: 'root',
            attempt: 1,
            status: status === 'waiting' ? 'running' : status,
            startedAt: '2026-10-24T00:00:00.000Z',
          },
        ]
      : [];
  const props: NodeProps<WorkflowNode> = {
    id: node.id,
    data: node.data,
    type: 'workflowNode',
    selected,
    dragging: false,
    zIndex: 0,
    selectable: true,
    deletable: true,
    draggable: true,
    isConnectable: true,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
  };
  return renderToStaticMarkup(
    <ReactFlowProvider>
      <WorkflowRuntimeProvider
        workflow={workflow}
        runStatus={
          status === 'idle'
            ? null
            : {
                phase: 'ready',
                runId: waitingRun.id,
                run: { ...waitingRun, status: status === 'pending' ? 'running' : status },
                nodeRuns,
                refreshing: false,
                error: null,
                review:
                  status === 'waiting'
                    ? {
                        phase: 'ready',
                        item: pendingReview,
                        feedback: '',
                        notice: null,
                      }
                    : null,
              }
        }
      >
        <WorkflowManifestProvider manifests={[humanReviewManifest]}>
          <GenericWorkflowNode {...props} />
        </WorkflowManifestProvider>
      </WorkflowRuntimeProvider>
    </ReactFlowProvider>,
  );
}

describe('Canvas 运行态融入节点，不再展示状态胶囊', () => {
  it.each([
    ['idle', 'clock', 'hidden'],
    ['pending', 'clock', 'icon'],
    ['running', 'loader', 'label'],
    ['waiting', 'review', 'label'],
    ['completed', 'check', 'icon'],
    ['failed', 'alert', 'label'],
  ] as const)('%s 集中映射为 %s 图标与 %s 显示', (status, icon, display) => {
    expect(getRuntimeNodePresentation(status).canvas).toEqual({ icon, display });
    const html = renderNode(status);
    expect(html).toContain(`data-runtime-status="${status}"`);
    expect(html).toMatch(new RegExp(`class="[^"]*node_${status}`));
    expect(html).not.toMatch(/class="[^"]*(?:badge|rounded-full)/);
    if (display === 'hidden') {
      expect(html).not.toContain('节点状态：');
    } else {
      const header = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
      expect(header).toContain(`data-tone="${status}"`);
      expect(header).toContain('节点状态：');
    }
  });

  it('running / failed 在标题区保留图标与简短状态文字，选中后仍保留运行态样式', () => {
    for (const status of ['running', 'failed'] as const) {
      const label = getRuntimeNodePresentation(status).canvasLabel;
      const html = renderNode(status, true);
      expect(html).toContain(`>${label}</span>`);
      expect(html).toMatch(new RegExp(`class="[^"]*node_${status}[^"]*selected`));
      expect(html).toContain(status === 'running' ? 'lucide-loader-circle' : 'lucide-circle-alert');
    }
  });

  it('waiting 保留人工操作提示、真实内容摘要与 CTA，不展示审核身份', () => {
    const html = renderNode('waiting');
    expect(html).toContain('等待人工审核');
    expect(html).toContain('等待你的审核');
    expect(html).toContain('主角站在窗前。');
    expect(html).toContain('查看并审核 →');
    expect(html).not.toContain(pendingReview.interruptId);
    expect(html).not.toContain('<script>');
  });

  it('completed 只保留可访问状态和小勾，不出现可见成功标签或完成动画', () => {
    const html = renderToStaticMarkup(<RuntimeCanvasStatus status="completed" />);
    expect(html).toContain('aria-label="节点状态：执行完成"');
    expect(html).toContain('lucide-check');
    expect(html).not.toContain('>执行完成<');
    expect(html).not.toContain('loader');
  });
});
