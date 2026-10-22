'use client';
import { useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  useReactFlow,
  type Connection,
  type OnMove,
} from '@xyflow/react';
import { useQuery } from '@tanstack/react-query';
import { App, Button } from 'antd';
import type { NodeTypeManifest, Project, WorkflowDefinition } from '@dramaflow/contracts';
import { createWorkflowNode } from '../node-catalog/create-workflow-node';
import { NodePicker } from '../node-catalog/node-picker';
import { nodeTypeApi, nodeTypeKeys } from '../node-catalog/node-type-api';
import {
  WorkflowModelActionsContext,
  type ModelSelectionIntent,
  type ModelSelectionResume,
} from '../model-selection/model-selector';
import { replaceNodeInput } from '../inputs/template-input';
import { WorkflowInputContext } from '../inputs/workflow-input-context';
import { WorkflowManifestProvider, workflowNodeTypes } from './workflow-node';
import { areWorkflowHandlesCompatible } from './workflow-handles';
import {
  applyWorkflowNodePositions,
  connectWorkflowNodes,
  disconnectWorkflowEdge,
  reconnectWorkflowEdge,
  staticBindingForDataConnection,
  toReactFlowEdges,
  toReactFlowNodes,
  type WorkflowEdge,
  type WorkflowNode,
} from './react-flow-adapter';

export function WorkflowCanvas({
  projectId,
  workflow,
  onEdit,
  onOpenProvider,
  modelResume = null,
  onModelResumeConsumed,
  reloading,
  interactionLocked = false,
  defaultViewport,
  onMoveEnd,
}: {
  projectId: string;
  workflow: WorkflowDefinition;
  onEdit: (apply: (current: WorkflowDefinition) => WorkflowDefinition) => void;
  onOpenProvider: (
    providerDefinitionId: string,
    mode: 'configure' | 'manage',
    intent?: ModelSelectionIntent,
  ) => void;
  modelResume?: ModelSelectionResume | null;
  onModelResumeConsumed?: () => void;
  reloading: boolean;
  interactionLocked?: boolean;
  defaultViewport: Project['viewport'];
  onMoveEnd: OnMove;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const { screenToFlowPosition } = useReactFlow<WorkflowNode, WorkflowEdge>();
  const locked = reloading || interactionLocked;
  const { modal } = App.useApp();
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

  function addNode(selection: NodeTypeManifest) {
    if (locked || nodeTypes.isPending || nodeTypes.isError || !stageRef.current) return;
    // 只接受当前目录中精确匹配的版本，目录失败时不使用兜底节点。
    const manifest = nodeTypes.data.find(
      (item) => item.type === selection.type && item.version === selection.version,
    );
    if (!manifest) return;
    const bounds = stageRef.current.getBoundingClientRect();
    // 连续新增稍微错开，避免多个新节点初始完全重叠。
    const offset = (workflow.nodes.length % 5) * 24;
    const position = screenToFlowPosition({
      x: bounds.left + Math.max(24, (bounds.width - 300) / 2) + offset,
      y: bounds.top + Math.min(120, bounds.height / 3) + offset,
    });
    const node = createWorkflowNode(
      manifest,
      `node_${crypto.randomUUID()}`,
      manifest.metadata.name,
      position,
    );
    onEdit((current) => ({ ...current, nodes: [...current.nodes, node] }));
  }

  function commitDataConnection(
    connection: Connection,
    apply: (current: WorkflowDefinition, replaceBinding: boolean) => WorkflowDefinition,
  ) {
    if (!staticBindingForDataConnection(workflow, connection)) {
      onEdit((current) => apply(current, false));
      return;
    }
    modal.confirm({
      title: '该输入已有内容。连接后将改为使用上游节点输出，当前内容将被替换。',
      okText: '确认替换',
      cancelText: '取消',
      okButtonProps: { autoInsertSpace: false },
      cancelButtonProps: { autoInsertSpace: false },
      onOk: () => onEdit((current) => apply(current, true)),
    });
  }

  return (
    <div className="canvas-stage" ref={stageRef}>
      <NodePicker
        manifests={nodeTypes.data ?? []}
        disabled={locked || nodeTypes.isPending || nodeTypes.isError || !nodeTypes.data?.length}
        onSelect={addNode}
      />
      <WorkflowModelActionsContext.Provider
        value={{
          projectId,
          disabled: locked,
          onOpenProvider,
          resume: modelResume,
          onResumeConsumed: onModelResumeConsumed ?? (() => undefined),
          onSelectModel: (nodeId, modelConfigurationId) =>
            onEdit((current) => ({
              ...current,
              nodes: current.nodes.map((node) =>
                node.id === nodeId
                  ? { ...node, config: { ...node.config, modelConfigurationId } }
                  : node,
              ),
            })),
        }}
      >
        <WorkflowInputContext.Provider
          value={{
            disabled: locked,
            definition: workflow,
            manifests: nodeTypes.data ?? [],
            onReplaceInput: (nodeId, portKey, binding) =>
              onEdit((current) => replaceNodeInput(current, nodeId, portKey, binding)),
          }}
        >
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
                if (
                  !locked &&
                  changes.some((change) => change.type === 'position' && change.position)
                )
                  onEdit((current) => applyWorkflowNodePositions(current, changes));
              }}
              onConnect={(connection) =>
                commitDataConnection(connection, (current, replaceBinding) =>
                  connectWorkflowNodes(current, connection, nodeTypes.data ?? [], {
                    replaceBinding,
                  }),
                )
              }
              onReconnect={(edge, connection) =>
                commitDataConnection(connection, (current, replaceBinding) =>
                  reconnectWorkflowEdge(current, edge, connection, nodeTypes.data ?? [], {
                    replaceBinding,
                  }),
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
        </WorkflowInputContext.Provider>
      </WorkflowModelActionsContext.Provider>
      {workflow.nodes.length === 0 ? (
        <div className="canvas-empty">
          <p>空白画布</p>
          <span role="status">
            {nodeTypes.isPending
              ? '正在加载节点目录…'
              : nodeTypes.isError
                ? '节点目录加载失败，请重试加载目录。'
                : nodeTypes.data.length === 0
                  ? '当前暂无可用节点。'
                  : '点击左上角“添加节点”，开始编排工作流。'}
          </span>
        </div>
      ) : null}
      {nodeTypes.isError ? (
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
