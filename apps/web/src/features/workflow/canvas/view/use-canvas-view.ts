'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { NodeTypeManifest } from '@dramaflow/contracts';
import type { ReactFlowProps, XYPosition } from '@xyflow/react';
import type { InspectorContextMode } from '../../inspector/workflow-node-inspector';
import type { resolveWorkflowRuntimeNodes } from '../../runtime/runtime-status';
import { projectWorkflowEnd, removeWorkflowNodes } from '../../outputs/workflow-outputs';
import { projectBodyInputBoundary } from '../../iteration/body-input-boundary';
import { findNodeManifest } from '../rendering/workflow-node';
import { applyWorkflowNodePositions, toReactFlowNodes } from '../adapter/node-adapter';
import { toReactFlowEdges } from '../adapter/edge-adapter';
import type { WorkflowNode } from '../adapter/types';
import type { CanvasNode, CanvasEdge, WorkflowCanvasProps } from './canvas-types';

export function useCanvasView({
  workflow,
  manifests,
  locked,
  modelResume,
  runtimeNodes,
  end,
  inputBoundary,
  onBoundaryPositionChange,
  onEdit,
  initialSelectedNodeId = null,
  initialSelectedEdgeIds = [],
  onSelectionChange,
}: Pick<
  WorkflowCanvasProps,
  | 'workflow'
  | 'modelResume'
  | 'onEdit'
  | 'initialSelectedNodeId'
  | 'initialSelectedEdgeIds'
  | 'onSelectionChange'
> & {
  manifests: readonly NodeTypeManifest[];
  locked: boolean;
  runtimeNodes: ReturnType<typeof resolveWorkflowRuntimeNodes>;
  end: ReturnType<typeof projectWorkflowEnd>;
  inputBoundary: ReturnType<typeof projectBodyInputBoundary>;
  onBoundaryPositionChange: (id: string, position: XYPosition) => void;
}) {
  const [nodeView, setNodeView] = useState<
    ReadonlyMap<string, Pick<WorkflowNode, 'selected' | 'measured'>>
  >(new Map());
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(initialSelectedNodeId);
  const [inspectorMode, setInspectorMode] = useState<InspectorContextMode>('design');
  const [selectedEdgeIds, setSelectedEdgeIds] = useState<ReadonlySet<string>>(
    () => new Set(initialSelectedEdgeIds),
  );
  const onSelectionChangeRef = useRef(onSelectionChange);
  useEffect(() => {
    onSelectionChangeRef.current = onSelectionChange;
  });
  useEffect(() => {
    onSelectionChangeRef.current?.({
      selectedNodeId,
      selectedEdgeIds: [...selectedEdgeIds],
    });
  }, [selectedEdgeIds, selectedNodeId]);
  const selectNode = useCallback(
    (nodeId: string, preferredMode?: InspectorContextMode) => {
      setSelectedNodeId(nodeId);
      setNodeView((current) => {
        const next = new Map<string, Pick<WorkflowNode, 'selected' | 'measured'>>();
        for (const [id, view] of current.entries()) {
          next.set(id, { ...view, selected: id === nodeId });
        }
        next.set(nodeId, { ...next.get(nodeId), selected: true });
        return next;
      });
      if (preferredMode) {
        setInspectorMode(preferredMode);
        return;
      }
      const nodeRuntime = runtimeNodes.get(nodeId);
      if (nodeRuntime?.status === 'waiting' || nodeRuntime?.isWaitingHumanReview) {
        setInspectorMode('runtime');
      } else if (selectedNodeId === null) {
        setInspectorMode('design');
      }
    },
    [runtimeNodes, selectedNodeId],
  );

  if (
    modelResume &&
    selectedNodeId !== modelResume.nodeId &&
    workflow.nodes.some((node) => node.id === modelResume.nodeId)
  ) {
    setSelectedNodeId(modelResume.nodeId);
    setInspectorMode('design');
  }

  const activeSelectedNode = useMemo(
    () =>
      selectedNodeId ? (workflow.nodes.find((node) => node.id === selectedNodeId) ?? null) : null,
    [workflow.nodes, selectedNodeId],
  );

  const activeSelectedManifest = useMemo(
    () =>
      activeSelectedNode
        ? findNodeManifest(manifests, activeSelectedNode.type, activeSelectedNode.typeVersion)
        : undefined,
    [activeSelectedNode, manifests],
  );

  const nodes = useMemo(
    () =>
      [...toReactFlowNodes(workflow), ...(inputBoundary ? [inputBoundary.node] : []), end.node].map(
        (node) => ({
          ...node,
          ...nodeView.get(node.id),
          selected:
            node.id === activeSelectedNode?.id || (nodeView.get(node.id)?.selected ?? false),
          deletable: node.type === 'workflowNode',
        }),
      ),
    [workflow, nodeView, end.node, inputBoundary, activeSelectedNode?.id],
  );
  const edges = useMemo(
    () =>
      [...toReactFlowEdges(workflow), ...(inputBoundary?.edges ?? []), ...end.edges].map(
        (edge) => ({
          ...edge,
          selected: selectedEdgeIds.has(edge.id),
        }),
      ),
    [workflow, selectedEdgeIds, end.edges, inputBoundary],
  );

  const onNodesChange: NonNullable<ReactFlowProps<CanvasNode, CanvasEdge>['onNodesChange']> = (
    changes,
  ) => {
    // 受控 React Flow 仍需接收测量结果；仅缓存在视图，不回写领域草稿。
    setNodeView((current) => {
      const viewChanges = changes.filter(
        (change) => change.type === 'select' || change.type === 'dimensions',
      );
      if (!viewChanges.length) return current;
      const next = new Map(current);
      for (const change of viewChanges) {
        if (change.type === 'select')
          next.set(change.id, {
            ...next.get(change.id),
            selected: change.selected,
          });
        else if (change.type === 'dimensions' && change.dimensions)
          next.set(change.id, {
            ...next.get(change.id),
            measured: change.dimensions,
          });
      }
      return next;
    });
    const viewOnly = (id: string) => id === end.node.id || id === inputBoundary?.node.id;
    for (const change of changes) {
      if (change.type === 'select' && change.selected && !viewOnly(change.id)) {
        selectNode(change.id);
      }
    }
    if (locked) return;
    const domainChanges = changes.filter(
      (change) => change.type !== 'add' && change.type !== 'replace' && !viewOnly(change.id),
    );
    for (const change of changes) {
      if (change.type !== 'position' || !change.position) continue;
      onBoundaryPositionChange(change.id, change.position);
    }
    const removedIds = domainChanges.flatMap((change) =>
      change.type === 'remove' ? [change.id] : [],
    );
    if (removedIds.length && selectedNodeId && removedIds.includes(selectedNodeId)) {
      setSelectedNodeId(null);
    }
    if (
      removedIds.length ||
      domainChanges.some((change) => change.type === 'position' && change.position)
    ) {
      onEdit((current) =>
        applyWorkflowNodePositions(
          removeWorkflowNodes(current, removedIds),
          domainChanges.flatMap((change) => (change.type === 'position' ? [change] : [])),
        ),
      );
    }
  };
  const onEdgesChange: NonNullable<ReactFlowProps<CanvasNode, CanvasEdge>['onEdgesChange']> = (
    changes,
  ) => {
    setSelectedEdgeIds((current) => {
      const next = new Set(current);
      for (const change of changes) {
        if (change.type === 'select') {
          if (change.selected) next.add(change.id);
          else next.delete(change.id);
        } else if (change.type === 'remove') next.delete(change.id);
      }
      return next;
    });
  };
  return {
    nodes,
    edges,
    activeSelectedNode,
    activeSelectedManifest,
    inspectorMode,
    setInspectorMode,
    selectedNodeId,
    setSelectedNodeId,
    selectNode,
    onNodesChange,
    onEdgesChange,
  };
}
