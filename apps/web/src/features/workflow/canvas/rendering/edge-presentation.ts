import { MarkerType } from '@xyflow/react';
import type { WorkflowEdge, WorkflowEdgeData } from '../adapter/types';

// 连线样式只表达依赖类型；不根据 DAG 或节点状态推断实际数据传输。
export function getWorkflowEdgePresentation(data: WorkflowEdgeData) {
  if (data.kind === 'control') {
    return { flowing: false, color: '#777b85', projectionLabel: undefined };
  }
  return {
    flowing: true,
    color: '#729d99',
    projectionLabel: data.projection === 'candidate-input' ? '候选' : undefined,
  };
}

export function workflowEdgeViewOptions(
  data: WorkflowEdgeData,
): Pick<WorkflowEdge, 'type' | 'animated' | 'markerEnd'> {
  const presentation = getWorkflowEdgePresentation(data);
  return {
    type: 'workflowEdge',
    // 方向动画由 SVG overlay 负责，不启用 React Flow 自带的整条虚线动画。
    animated: false,
    markerEnd: {
      type: MarkerType.ArrowClosed,
      width: 14,
      height: 14,
      color: presentation.color,
    },
  };
}
