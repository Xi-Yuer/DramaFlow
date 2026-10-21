'use client';
import { useMemo, useState } from 'react';
import { Background, BackgroundVariant, Controls, ReactFlow, type OnMove } from '@xyflow/react';
import { useQuery } from '@tanstack/react-query';
import { Button } from 'antd';
import type { Project, WorkflowDefinition } from '@dramaflow/contracts';
import { nodeTypeApi, nodeTypeKeys } from './node-type-api';
import { WorkflowManifestProvider, workflowNodeTypes } from './workflow-node';
import { areWorkflowHandlesCompatible } from './workflow-handles';
import {
  applyWorkflowNodePositions,
  connectWorkflowNodes,
  disconnectWorkflowEdge,
  reconnectWorkflowEdge,
  toReactFlowEdges,
  toReactFlowNodes,
  type WorkflowEdge,
  type WorkflowNode,
} from './react-flow-adapter';

export function WorkflowCanvas({
  workflow,
  onEdit,
  reloading,
  interactionLocked = false,
  defaultViewport,
  onMoveEnd,
}: {
  workflow: WorkflowDefinition;
  onEdit: (apply: (current: WorkflowDefinition) => WorkflowDefinition) => void;
  reloading: boolean;
  interactionLocked?: boolean;
  defaultViewport: Project['viewport'];
  onMoveEnd: OnMove;
}) {
  const locked = reloading || interactionLocked;
  const nodeTypes = useQuery({ queryKey: nodeTypeKeys.list, queryFn: nodeTypeApi.list });
  const [nodeView, setNodeView] = useState<
    ReadonlyMap<string, Pick<WorkflowNode, 'selected' | 'measured'>>
  >(new Map());
  const [selectedEdgeIds, setSelectedEdgeIds] = useState<ReadonlySet<string>>(new Set());
  const nodes = useMemo(
    () =>
      toReactFlowNodes(workflow).map((node) => ({
        ...node,
        ...nodeView.get(node.id),
        deletable: false,
      })),
    [workflow, nodeView],
  );
  const edges = useMemo(
    () =>
      toReactFlowEdges(workflow).map((edge) => ({
        ...edge,
        selected: selectedEdgeIds.has(edge.id),
      })),
    [workflow, selectedEdgeIds],
  );

  return (
    <div className="canvas-stage">
      <WorkflowManifestProvider manifests={nodeTypes.data ?? []}>
        <ReactFlow<WorkflowNode, WorkflowEdge>
          nodeTypes={workflowNodeTypes}
          nodes={nodes}
          edges={edges}
          nodesDraggable={!locked}
          nodesConnectable={!locked && !nodeTypes.isPending && !nodeTypes.isError}
          edgesReconnectable={!locked}
          deleteKeyCode={locked ? null : ['Backspace', 'Delete']}
          onNodesChange={(changes) => {
            // 受控 React Flow 仍需接收测量结果；仅缓存在视图，不回写领域草稿。
            setNodeView((current) => {
              const viewChanges = changes.filter(
                (change) => change.type === 'select' || change.type === 'dimensions',
              );
              if (!viewChanges.length) return current;
              const next = new Map(current);
              for (const change of viewChanges) {
                if (change.type === 'select')
                  next.set(change.id, { ...next.get(change.id), selected: change.selected });
                else if (change.type === 'dimensions' && change.dimensions)
                  next.set(change.id, { ...next.get(change.id), measured: change.dimensions });
              }
              return next;
            });
            if (!locked && changes.some((change) => change.type === 'position' && change.position))
              onEdit((current) => applyWorkflowNodePositions(current, changes));
          }}
          onConnect={(connection) =>
            onEdit((current) => connectWorkflowNodes(current, connection, nodeTypes.data ?? []))
          }
          onReconnect={(edge, connection) =>
            onEdit((current) =>
              reconnectWorkflowEdge(current, edge, connection, nodeTypes.data ?? []),
            )
          }
          onEdgesDelete={(deleted) => {
            onEdit((current) => deleted.reduce(disconnectWorkflowEdge, current));
          }}
          onEdgesChange={(changes) => {
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
          }}
          isValidConnection={(connection) =>
            areWorkflowHandlesCompatible(connection.sourceHandle, connection.targetHandle)
          }
          onMoveEnd={onMoveEnd}
          defaultViewport={defaultViewport}
          minZoom={0.1}
          maxZoom={3}
          colorMode="dark"
          fitView={false}
          proOptions={{ hideAttribution: false }}
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} color="#ffffff18" />
          <Controls showInteractive={false} position="bottom-left" />
        </ReactFlow>
      </WorkflowManifestProvider>
      {workflow.nodes.length === 0 ? (
        <div className="canvas-empty">
          <p>空白画布</p>
          <span role="status">
            {nodeTypes.isPending
              ? '正在加载节点目录…'
              : nodeTypes.isError
                ? '节点目录加载失败，请重新加载项目。'
                : nodeTypes.data.length === 0
                  ? '当前暂无可用节点。'
                  : '当前草稿还没有节点。节点添加与配置尚未开放。'}
          </span>
        </div>
      ) : null}
      {workflow.nodes.length > 0 && nodeTypes.isError ? (
        <div className="canvas-catalog-error" role="status">
          节点目录加载失败，已有草稿仍保留。
          <Button size="small" onClick={() => void nodeTypes.refetch()}>
            重试加载目录
          </Button>
        </div>
      ) : null}
    </div>
  );
}
