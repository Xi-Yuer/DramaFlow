'use client';
import { useEffect, useMemo, useRef } from 'react';
import { Background, BackgroundVariant, Controls, ReactFlow, useReactFlow } from '@xyflow/react';
import { useQuery } from '@tanstack/react-query';
import { Button } from 'antd';
import type { NodeTypeManifest } from '@dramaflow/contracts';
import { NodePicker } from '../node-catalog/node-picker';
import { createWorkflowNode } from '../node-catalog/create-workflow-node';
import { nodeTypeApi, nodeTypeKeys } from '../node-catalog/node-type-api';
import { WorkflowEnd } from '../outputs/workflow-end';
import { WorkflowBodyInputs } from '../iteration/body-input-boundary-node';
import { WorkflowNodeInspector } from '../inspector/workflow-node-inspector';
import { resolveWorkflowRuntimeNodes, WorkflowRuntimeProvider } from '../runtime/runtime-status';
import { canEnterIterationBody } from '../editor/graph-navigation';
import { workflowNodeTypes } from './rendering/workflow-node';
import { workflowEdgeTypes } from './rendering/workflow-edge';
import { CanvasEditingProviders } from './editing/canvas-editing-providers';
import { useCanvasBoundaries } from './editing/use-canvas-boundaries';
import { useCanvasView } from './view/use-canvas-view';
import { useCanvasConnections } from './editing/use-canvas-connections';
import type { CanvasNode, CanvasEdge, WorkflowCanvasProps } from './view/canvas-types';

const canvasNodeTypes = {
  ...workflowNodeTypes,
  workflowEnd: WorkflowEnd,
  workflowBodyInputs: WorkflowBodyInputs,
};

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
  initialSelectedNodeId = null,
  initialSelectedEdgeIds = [],
  onSelectionChange,
  manifestFilter,
  onEnterBody,
  navigation = null,
  viewportControllerRef,
  runStatus = null,
  reviewActions,
  nodeRuns,
  onRefreshRunStatus,
}: WorkflowCanvasProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const { screenToFlowPosition, getViewport, setViewport } = useReactFlow<CanvasNode, CanvasEdge>();
  const locked = reloading || interactionLocked;
  const nodeTypes = useQuery({ queryKey: nodeTypeKeys.list, queryFn: nodeTypeApi.list });
  const atRoot = navigation === null;
  const boundaries = useCanvasBoundaries({
    workflow,
    manifests: nodeTypes.data ?? [],
    locked,
    atRoot,
    catalogUnavailable: nodeTypes.isPending || nodeTypes.isError,
    onEdit,
  });
  useEffect(() => {
    if (!viewportControllerRef) return;
    viewportControllerRef.current = { getViewport, setViewport };
    return () => {
      viewportControllerRef.current = null;
    };
  }, [getViewport, setViewport, viewportControllerRef]);
  const catalog = useMemo(
    () => (manifestFilter ? (nodeTypes.data ?? []).filter(manifestFilter) : (nodeTypes.data ?? [])),
    [manifestFilter, nodeTypes.data],
  );

  const runtimeNodes = useMemo(
    () => resolveWorkflowRuntimeNodes({ workflow, runStatus, nodeRuns }),
    [workflow, runStatus, nodeRuns],
  );

  const view = useCanvasView({
    workflow,
    manifests: nodeTypes.data ?? [],
    locked,
    modelResume,
    runtimeNodes,
    end: boundaries.end,
    inputBoundary: boundaries.inputBoundary,
    onBoundaryPositionChange: boundaries.setBoundaryPosition,
    onEdit,
    initialSelectedNodeId,
    initialSelectedEdgeIds,
    onSelectionChange,
  });
  const {
    activeSelectedNode,
    activeSelectedManifest,
    inspectorMode,
    setInspectorMode,
    setSelectedNodeId,
    selectNode,
  } = view;
  const connections = useCanvasConnections({
    workflow,
    manifests: nodeTypes.data ?? [],
    locked,
    atRoot,
    end: boundaries.end,
    inputBoundary: boundaries.inputBoundary,
    requestOutputSource: boundaries.requestOutputSource,
    onEdit,
  });

  function addNode(selection: NodeTypeManifest) {
    if (locked || nodeTypes.isPending || nodeTypes.isError || !stageRef.current) return;
    // 只接受当前目录中精确匹配的版本，目录失败时不使用兜底节点。
    const manifest = nodeTypes.data.find(
      (item) => item.type === selection.type && item.version === selection.version,
    );
    if (!manifest || (manifestFilter && !manifestFilter(manifest))) return;
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
    selectNode(node.id, 'design');
  }

  return (
    <div className="canvas-stage" data-graph-location={navigation ? 'body' : 'root'}>
      {navigation ? (
        <nav className="canvas-breadcrumb" aria-label="图位置">
          <button type="button" onClick={navigation.onBackToRoot} aria-label="返回工作流">
            工作流
          </button>
          <span aria-hidden="true">/</span>
          <span>{navigation.ownerName}</span>
          <span aria-hidden="true">/</span>
          <span aria-current="page">Body</span>
        </nav>
      ) : null}
      <WorkflowRuntimeProvider
        workflow={workflow}
        runStatus={runStatus}
        nodeRuns={nodeRuns}
        reviewActions={reviewActions}
        onRefreshRunStatus={onRefreshRunStatus}
      >
        <CanvasEditingProviders
          projectId={projectId}
          workflow={workflow}
          manifests={nodeTypes.data ?? []}
          locked={locked}
          selectedNodeId={activeSelectedNode?.id ?? null}
          selectNode={selectNode}
          onEdit={onEdit}
          onOpenProvider={onOpenProvider}
          modelResume={modelResume}
          onModelResumeConsumed={onModelResumeConsumed}
          outputActions={boundaries.outputActions}
        >
          <div className="canvas-flow" ref={stageRef}>
            <NodePicker
              manifests={catalog}
              disabled={locked || nodeTypes.isPending || nodeTypes.isError || catalog.length === 0}
              onSelect={addNode}
            />
            <ReactFlow<CanvasNode, CanvasEdge>
              nodeTypes={canvasNodeTypes}
              edgeTypes={workflowEdgeTypes}
              nodes={view.nodes}
              edges={view.edges}
              nodesDraggable={!locked}
              nodesConnectable={!locked && !nodeTypes.isPending && !nodeTypes.isError}
              edgesReconnectable={!locked}
              deleteKeyCode={locked ? null : ['Backspace', 'Delete']}
              onNodeClick={(_, node) => {
                if (node.type === 'workflowNode') {
                  selectNode(node.id);
                }
              }}
              onPaneClick={() => {
                setSelectedNodeId(null);
              }}
              onNodesChange={view.onNodesChange}
              onConnect={connections.onConnect}
              onReconnect={connections.onReconnect}
              onEdgesDelete={connections.onEdgesDelete}
              onEdgesChange={view.onEdgesChange}
              isValidConnection={connections.isValidConnection}
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
                        : navigation
                          ? '点击左上角“添加节点”，开始编排 Body。'
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
          {activeSelectedNode ? (
            <WorkflowNodeInspector
              node={activeSelectedNode}
              manifest={activeSelectedManifest}
              mode={inspectorMode}
              onModeChange={setInspectorMode}
              onClose={() => setSelectedNodeId(null)}
              onUpdateNode={(next) =>
                onEdit((current) => ({
                  ...current,
                  nodes: current.nodes.map((item) => (item.id === next.id ? next : item)),
                }))
              }
              bodyEntry={
                onEnterBody &&
                activeSelectedNode.type === 'flow.iteration' &&
                activeSelectedNode.typeVersion === 1
                  ? {
                      enabled: canEnterIterationBody(activeSelectedNode),
                      onEnter: () => onEnterBody(activeSelectedNode.id),
                    }
                  : undefined
              }
            />
          ) : null}
        </CanvasEditingProviders>
      </WorkflowRuntimeProvider>
      {boundaries.dialogs}
    </div>
  );
}
