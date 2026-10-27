import { renderToStaticMarkup } from 'react-dom/server';
import { getBezierPath, Position, MarkerType, type EdgeProps } from '@xyflow/react';
import { describe, expect, it } from 'vitest';
import {
  fromReactFlowEdge,
  toReactFlowEdge,
  toReactFlowEdges,
  type WorkflowEdge,
} from '../../../src/features/workflow/canvas/react-flow-adapter';
import { getWorkflowEdgePresentation } from '../../../src/features/workflow/canvas/rendering/edge-presentation';
import { WorkflowCanvasEdge } from '../../../src/features/workflow/canvas/rendering/workflow-edge';
import { candidateWorkflow } from '../../fixtures/candidate-input';
import { templateWorkflow } from '../../fixtures/template-input';

const points = {
  sourceX: 240,
  sourceY: 80,
  sourcePosition: Position.Right,
  targetX: 520,
  targetY: 180,
  targetPosition: Position.Left,
};
function renderEdge(edge: WorkflowEdge, geometry = points, selected = false) {
  const props: EdgeProps<WorkflowEdge> = {
    ...edge,
    ...geometry,
    selected,
    selectable: true,
    deletable: edge.deletable ?? true,
    sourceHandleId: edge.sourceHandle,
    targetHandleId: edge.targetHandle,
    markerStart: undefined,
    markerEnd: 'url(#direction)',
  };
  return renderToStaticMarkup(
    <svg>
      <WorkflowCanvasEdge {...props} />
    </svg>,
  );
}

describe('Data / Control / Projection Edge Presentation', () => {
  const definitions = {
    data: {
      id: 'data-1',
      kind: 'data',
      source: { nodeId: 'a', portKey: 'text' },
      target: { nodeId: 'b', portKey: 'prompt' },
    },
    control: {
      id: 'control-1',
      kind: 'control',
      source: { nodeId: 'a' },
      target: { nodeId: 'b' },
    },
  } as const;

  it.each([points, { ...points, sourceX: 520, targetX: 240 }])(
    'DataEdge 共用官方 source → target 路径绘制低强度 overlay，保留箭头和命中区域 $sourceX → $targetX',
    (geometry) => {
      const edge = toReactFlowEdge(definitions.data);
      expect(edge.type).toBe('workflowEdge');
      expect(edge.animated).toBe(false);
      expect(edge.markerEnd).toMatchObject({ type: MarkerType.ArrowClosed });
      expect(getWorkflowEdgePresentation(edge.data!).flowing).toBe(true);
      const html = renderEdge(edge, geometry);
      const [path] = getBezierPath(geometry);
      // overlay / BaseEdge / 命中区域完全共用同一条路径，不重新实现 routing。
      expect(html.split(`d="${path}"`)).toHaveLength(4);
      expect(html).toMatch(/class="[^"]*flow[^"]*"/);
      expect(html).toContain('aria-hidden="true"');
      expect(html).toContain('marker-end="url(#direction)"');
      expect(html).toContain('react-flow__edge-interaction');
      expect(fromReactFlowEdge(edge)).toEqual(definitions.data);
    },
  );

  it('ControlEdge 在普通和选中时始终是带箭头的实线，没有流动 overlay', () => {
    const edge = toReactFlowEdge(definitions.control);
    expect(edge.animated).toBe(false);
    expect(edge.style?.strokeDasharray).toBeUndefined();
    expect(getWorkflowEdgePresentation(edge.data!).flowing).toBe(false);
    for (const selected of [false, true]) {
      const html = renderEdge(edge, points, selected);
      expect(html).toContain('data-edge-kind="control"');
      expect(html).toContain('marker-end="url(#direction)"');
      expect(html).not.toContain('stroke-dasharray');
      expect(html).not.toContain('aria-hidden="true"');
    }
    expect(fromReactFlowEdge(edge)).toEqual(definitions.control);
  });

  it.each([
    ['template-input', undefined, templateWorkflow, false],
    ['candidate-input', '候选', candidateWorkflow, true],
  ] as const)(
    '%s 保留流动、投影标识、交互权限和纯视图身份',
    (projection, label, fixture, deletable) => {
      const workflow = fixture();
      const snapshot = structuredClone(workflow);
      const edges = toReactFlowEdges(workflow).filter(
        (edge) => edge.data?.projection === projection,
      );
      expect(edges.length).toBeGreaterThan(0);
      for (const edge of edges) {
        expect(edge.type).toBe('workflowEdge');
        expect(edge.reconnectable).toBe(false);
        expect(edge.deletable ?? true).toBe(deletable);
        const html = renderEdge(edge);
        expect(html).toContain(`data-projection="${projection}"`);
        if (label) expect(html).toContain(`>${label}</text>`);
        else expect(html).not.toContain('<text');
        expect(html).toContain('stroke-dasharray:3 5');
        expect(html).toContain('aria-hidden="true"');
        expect(() => fromReactFlowEdge(edge)).toThrow('不能导出为 DataEdge');
      }
      expect(workflow).toEqual(snapshot);
      expect(toReactFlowEdges(JSON.parse(JSON.stringify(workflow)))).toEqual(
        toReactFlowEdges(workflow),
      );
    },
  );
});
