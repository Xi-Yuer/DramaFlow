'use client';
import { useMemo, useState } from 'react';
import { Background, BackgroundVariant, Controls, ReactFlow, type OnMove } from '@xyflow/react';
import { useQuery } from '@tanstack/react-query';
import { App } from 'antd';
import type { Project, WorkflowDefinition } from '@dramaflow/contracts';
import { nodeTypeApi, nodeTypeKeys } from './node-type-api';
import { WorkflowManifestProvider, workflowNodeTypes } from './workflow-node';
import { areWorkflowHandlesCompatible } from './workflow-handles';
import {
  connectWorkflowNodes,
  disconnectWorkflowEdge,
  reconnectWorkflowEdge,
  toReactFlowEdges,
  toReactFlowNodes,
  type WorkflowEdge,
  type WorkflowNode,
} from './react-flow-adapter';

export function WorkflowCanvas({
  defaultViewport,
  onMoveEnd,
}: {
  defaultViewport: Project['viewport'];
  onMoveEnd: OnMove;
}) {
  const { message } = App.useApp();
  const nodeTypes = useQuery({ queryKey: nodeTypeKeys.list, queryFn: nodeTypeApi.list });
  // 项目接口尚不保存 Workflow；图关系只在该定义中维护，React Flow 是派生视图。
  const [workflow, setWorkflow] = useState<WorkflowDefinition>({
    inputs: [],
    nodes: [],
    edges: [],
    outputs: [],
  });
  const [selectedEdgeIds, setSelectedEdgeIds] = useState<ReadonlySet<string>>(new Set());
  const nodes = useMemo(() => toReactFlowNodes(workflow), [workflow]);
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
          onConnect={(connection) => {
            try {
              setWorkflow(connectWorkflowNodes(workflow, connection, nodeTypes.data ?? []));
            } catch (error) {
              void message.error(error instanceof Error ? error.message : '连线失败');
            }
          }}
          onReconnect={(edge, connection) => {
            try {
              setWorkflow(reconnectWorkflowEdge(workflow, edge, connection, nodeTypes.data ?? []));
            } catch (error) {
              void message.error(error instanceof Error ? error.message : '重连失败');
            }
          }}
          onEdgesDelete={(deleted) => {
            setWorkflow((current) => deleted.reduce(disconnectWorkflowEdge, current));
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
      <div className="canvas-empty">
        <p>空白画布</p>
        <span role="status">
          {nodeTypes.isPending
            ? '正在加载节点目录…'
            : nodeTypes.isError
              ? '节点目录加载失败，请重新加载项目。'
              : nodeTypes.data.length === 0
                ? '当前暂无可用节点。'
                : '已加载节点目录，工作流编辑与保存尚未开放。'}
        </span>
      </div>
    </div>
  );
}
