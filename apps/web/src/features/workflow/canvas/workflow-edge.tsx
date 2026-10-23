'use client';

import { memo } from 'react';
import { BaseEdge, getBezierPath, type EdgeProps, type EdgeTypes } from '@xyflow/react';
import type { WorkflowEdge } from './react-flow-adapter';
import { getWorkflowEdgePresentation } from './edge-presentation';
import styles from './workflow-edge.module.css';

export const WorkflowCanvasEdge = memo(function WorkflowCanvasEdge({
  id,
  data,
  sourceX,
  sourceY,
  sourcePosition,
  targetX,
  targetY,
  targetPosition,
  markerStart,
  markerEnd,
  interactionWidth,
  selected,
  style,
}: EdgeProps<WorkflowEdge>) {
  if (!data) return null;
  const presentation = getWorkflowEdgePresentation(data);
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  const stroke = selected ? 'var(--accent, #67ded5)' : presentation.color;
  return (
    <g data-edge-kind={data.kind} data-projection={data.projection}>
      {presentation.flowing ? (
        <path className={styles.flow} d={path} style={{ stroke }} fill="none" aria-hidden="true" />
      ) : null}
      <BaseEdge
        id={id}
        path={path}
        className={styles.base}
        style={{
          ...style,
          stroke,
          strokeWidth: selected ? 2 : 1.4,
          strokeOpacity: presentation.flowing ? 0.45 : 1,
          strokeDasharray: data.projection ? '3 5' : undefined,
        }}
        markerStart={markerStart}
        markerEnd={markerEnd}
        interactionWidth={interactionWidth}
        label={presentation.projectionLabel}
        labelX={labelX}
        labelY={labelY}
        labelStyle={{ fill: '#a4b6b4', fontSize: 10 }}
        labelBgStyle={{ fill: '#18191d' }}
        labelBgPadding={[5, 3]}
        labelBgBorderRadius={3}
      />
    </g>
  );
});

export const workflowEdgeTypes = { workflowEdge: WorkflowCanvasEdge } satisfies EdgeTypes;
