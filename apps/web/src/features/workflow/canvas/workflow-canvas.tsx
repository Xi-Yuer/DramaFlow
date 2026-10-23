'use client';
import { WorkflowNodeSettingsActions } from '../node-catalog/human-review-settings';
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  useReactFlow,
  type Connection,
  type OnMove,
  type XYPosition,
} from '@xyflow/react';
import { useQuery } from '@tanstack/react-query';
import { App, Button, Radio, Space } from 'antd';
import {
  workflowOutputSources,
  type NodeRun,
  type NodeTypeManifest,
  type Project,
  type WorkflowDefinition,
  type WorkflowOutputSource,
} from '@dramaflow/contracts';
import { WorkflowOutputTargetDialog } from '../outputs/workflow-output-target-dialog';
import { createWorkflowNode } from '../node-catalog/create-workflow-node';
import { NodePicker } from '../node-catalog/node-picker';
import { nodeTypeApi, nodeTypeKeys } from '../node-catalog/node-type-api';
import {
  WorkflowModelActionsContext,
  type ModelSelectionIntent,
  type ModelSelectionResume,
} from '../model-selection/model-selector';
import { WorkflowEnd, WorkflowOutputActions, WorkflowOutputDialog } from '../outputs/workflow-end';
import {
  addWorkflowOutput,
  setWorkflowOutput,
  removeWorkflowOutput,
  appendWorkflowOutputCandidate,
  removeWorkflowOutputCandidate,
  removeWorkflowNodes,
  projectWorkflowEnd,
  END_INPUT_HANDLE,
  type WorkflowEndNode,
  type WorkflowOutputEdge,
} from '../outputs/workflow-outputs';
import { replaceNodeInput } from '../inputs/template-input';
import { WorkflowInputContext } from '../inputs/workflow-input-context';
import { WorkflowConditionActions } from '../conditions/if-condition-editor';
import { setIfCondition } from '../conditions/if-condition';
import {
  WorkflowNodeInspector,
  type InspectorContextMode,
} from '../inspector/workflow-node-inspector';
import type { HumanReviewActions, WorkflowRunStatusState } from '../run/status/workflow-run-status';
import { resolveWorkflowRuntimeNodes, WorkflowRuntimeProvider } from '../runtime/runtime-status';
import {
  findNodeManifest,
  WorkflowManifestProvider,
  WorkflowNodeSelectionContext,
  workflowNodeTypes,
} from './workflow-node';
import { areWorkflowHandlesCompatible } from './workflow-handles';
import { workflowEdgeTypes } from './workflow-edge';
import {
  applyWorkflowNodePositions,
  connectWorkflowNodes,
  disconnectWorkflowEdge,
  reconnectWorkflowEdge,
  staticBindingForDataConnection,
  sourcesForDataConnection,
  type ConnectWorkflowOptions,
  toReactFlowEdges,
  toReactFlowNodes,
  type WorkflowEdge,
  type WorkflowNode,
} from './react-flow-adapter';

type CanvasNode = WorkflowNode | WorkflowEndNode;
type CanvasEdge = WorkflowEdge | WorkflowOutputEdge;
const canvasNodeTypes = { ...workflowNodeTypes, workflowEnd: WorkflowEnd };

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
  runStatus = null,
  reviewActions,
  nodeRuns,
  onRefreshRunStatus,
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
  runStatus?: WorkflowRunStatusState | null;
  reviewActions?: HumanReviewActions;
  nodeRuns?: readonly NodeRun[];
  onRefreshRunStatus?: () => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const { screenToFlowPosition } = useReactFlow<CanvasNode, CanvasEdge>();
  const locked = reloading || interactionLocked;
  const { modal } = App.useApp();
  const nodeTypes = useQuery({ queryKey: nodeTypeKeys.list, queryFn: nodeTypeApi.list });
  const [nodeView, setNodeView] = useState<
    ReadonlyMap<string, Pick<WorkflowNode, 'selected' | 'measured'>>
  >(new Map());
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [inspectorMode, setInspectorMode] = useState<InspectorContextMode>('design');
  const [endPosition, setEndPosition] = useState<XYPosition>(
    () => projectWorkflowEnd(workflow).node.position,
  );
  const [outputEditor, setOutputEditor] = useState<{ name?: string } | null>(null);
  const [pendingOutputSource, setPendingOutputSource] = useState<WorkflowOutputSource | null>(null);
  const end = useMemo(() => projectWorkflowEnd(workflow, endPosition), [workflow, endPosition]);
  const [selectedEdgeIds, setSelectedEdgeIds] = useState<ReadonlySet<string>>(new Set());

  const runtimeNodes = useMemo(
    () => resolveWorkflowRuntimeNodes({ workflow, runStatus, nodeRuns }),
    [workflow, runStatus, nodeRuns],
  );

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
        ? findNodeManifest(
            nodeTypes.data ?? [],
            activeSelectedNode.type,
            activeSelectedNode.typeVersion,
          )
        : undefined,
    [activeSelectedNode, nodeTypes.data],
  );

  const nodes = useMemo(
    () =>
      [...toReactFlowNodes(workflow), end.node].map((node) => ({
        ...node,
        ...nodeView.get(node.id),
        selected: node.id === activeSelectedNode?.id || (nodeView.get(node.id)?.selected ?? false),
        deletable: node.type !== 'workflowEnd',
      })),
    [workflow, nodeView, end.node, activeSelectedNode?.id],
  );
  const edges = useMemo(
    () =>
      [...toReactFlowEdges(workflow), ...end.edges].map((edge) => ({
        ...edge,
        selected: selectedEdgeIds.has(edge.id),
      })),
    [workflow, selectedEdgeIds, end.edges],
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
    selectNode(node.id, 'design');
  }

  function commitDataConnection(
    connection: Connection,
    apply: (current: WorkflowDefinition, options: ConnectWorkflowOptions) => WorkflowDefinition,
    previousEdge?: CanvasEdge,
  ) {
    // 重连的原关系不属于新目标的占用来源，确认与提交基于相同的断连后视图。
    const available = previousEdge ? disconnectWorkflowEdge(workflow, previousEdge) : workflow;
    const sources = sourcesForDataConnection(available, connection);
    if (
      sources.some(
        (source) =>
          source.nodeId === connection.source && source.portKey === connection.sourceHandle,
      )
    )
      return;
    if (
      sources.length ||
      staticBindingForDataConnection(available, connection)?.type === 'candidate'
    ) {
      let addCandidate = false;
      modal.confirm({
        title: '该输入已有数据来源',
        content: (
          <Space orientation="vertical">
            <Radio.Group
              defaultValue="replace"
              onChange={(event) => {
                addCandidate = event.target.value === 'candidate';
              }}
            >
              <Space orientation="vertical">
                <Radio value="replace">替换现有来源</Radio>
                <Radio value="candidate" disabled={sources.length >= 2}>
                  添加为候选来源
                </Radio>
              </Space>
            </Radio.Group>
            <span>
              {sources.length >= 2
                ? '当前候选输入最多支持两个来源，请先删除一个来源再添加。'
                : '候选输入使用实际执行分支产生的值，分支是否合法由发布时验证。'}
            </span>
          </Space>
        ),
        okText: '确认',
        cancelText: '取消',
        onOk: () =>
          onEdit((current) =>
            apply(current, addCandidate ? { addCandidate: true } : { replaceBinding: true }),
          ),
      });
      return;
    }
    if (!staticBindingForDataConnection(available, connection)) {
      onEdit((current) => apply(current, {}));
      return;
    }
    modal.confirm({
      title: '该输入已有内容。连接后将改为使用上游节点输出，当前内容将被替换。',
      okText: '确认替换',
      cancelText: '取消',
      okButtonProps: { autoInsertSpace: false },
      cancelButtonProps: { autoInsertSpace: false },
      onOk: () => onEdit((current) => apply(current, { replaceBinding: true })),
    });
  }

  return (
    <div className="canvas-stage">
      <WorkflowRuntimeProvider
        workflow={workflow}
        runStatus={runStatus}
        nodeRuns={nodeRuns}
        reviewActions={reviewActions}
        onRefreshRunStatus={onRefreshRunStatus}
      >
        <WorkflowNodeSelectionContext.Provider
          value={{
            selectedNodeId: activeSelectedNode?.id ?? null,
            onSelectNode: (nodeId) => selectNode(nodeId),
          }}
        >
          <WorkflowNodeSettingsActions.Provider
            value={{
              disabled: locked,
              onRename: (nodeId, name) => {
                if (!locked && name.trim())
                  onEdit((current) => ({
                    ...current,
                    nodes: current.nodes.map((node) =>
                      node.id === nodeId ? { ...node, name: name.trim() } : node,
                    ),
                  }));
              },
              onConfigChange: (nodeId, key, value) => {
                if (!locked)
                  onEdit((current) => ({
                    ...current,
                    nodes: current.nodes.map((node) => {
                      if (node.id !== nodeId) return node;
                      const config = { ...node.config };
                      if (value === undefined) delete config[key];
                      else config[key] = value;
                      return { ...node, config };
                    }),
                  }));
              },
            }}
          >
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
                <WorkflowOutputActions.Provider
                  value={{
                    disabled: locked,
                    onConfigure: (name) => setOutputEditor(name === undefined ? {} : { name }),
                    onRemove: (name) => {
                      if (!locked) onEdit((current) => removeWorkflowOutput(current, name));
                    },
                    onRemoveCandidate: (name, source) => {
                      if (!locked)
                        onEdit((current) => removeWorkflowOutputCandidate(current, name, source));
                    },
                  }}
                >
                  <WorkflowConditionActions.Provider
                    value={{
                      disabled: locked,
                      onChange: (nodeId, condition) => {
                        if (!locked)
                          onEdit((current) => setIfCondition(current, nodeId, condition));
                      },
                    }}
                  >
                    <WorkflowManifestProvider manifests={nodeTypes.data ?? []}>
                      <div className="canvas-flow" ref={stageRef}>
                        <NodePicker
                          manifests={nodeTypes.data ?? []}
                          disabled={
                            locked ||
                            nodeTypes.isPending ||
                            nodeTypes.isError ||
                            !nodeTypes.data?.length
                          }
                          onSelect={addNode}
                        />
                        <ReactFlow<CanvasNode, CanvasEdge>
                          nodeTypes={canvasNodeTypes}
                          edgeTypes={workflowEdgeTypes}
                          nodes={nodes}
                          edges={edges}
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
                          onNodesChange={(changes) => {
                            // 受控 React Flow 仍需接收测量结果；仅缓存在视图，不回写领域草稿。
                            setNodeView((current) => {
                              const viewChanges = changes.filter(
                                (change) =>
                                  change.type === 'select' || change.type === 'dimensions',
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
                            for (const change of changes) {
                              if (
                                change.type === 'select' &&
                                change.selected &&
                                change.id !== end.node.id
                              ) {
                                selectNode(change.id);
                              }
                            }
                            if (locked) return;
                            const domainChanges = changes.filter(
                              (change) =>
                                change.type !== 'add' &&
                                change.type !== 'replace' &&
                                change.id !== end.node.id,
                            );
                            for (const change of changes) {
                              if (
                                change.type === 'position' &&
                                change.id === end.node.id &&
                                change.position
                              )
                                setEndPosition(change.position);
                            }
                            const removedIds = domainChanges.flatMap((change) =>
                              change.type === 'remove' ? [change.id] : [],
                            );
                            if (
                              removedIds.length &&
                              selectedNodeId &&
                              removedIds.includes(selectedNodeId)
                            ) {
                              setSelectedNodeId(null);
                            }
                            if (
                              removedIds.length ||
                              domainChanges.some(
                                (change) => change.type === 'position' && change.position,
                              )
                            ) {
                              onEdit((current) =>
                                applyWorkflowNodePositions(
                                  removeWorkflowNodes(current, removedIds),
                                  domainChanges.flatMap((change) =>
                                    change.type === 'position' ? [change] : [],
                                  ),
                                ),
                              );
                            }
                          }}
                          onConnect={(connection) => {
                            if (locked) return;
                            if (connection.target === end.node.id) {
                              const sourceHandle = connection.sourceHandle;
                              if (connection.targetHandle !== END_INPUT_HANDLE || !sourceHandle)
                                return;
                              if (workflow.outputs.length) {
                                setPendingOutputSource({
                                  nodeId: connection.source,
                                  outputKey: sourceHandle,
                                });
                                return;
                              }
                              onEdit((current) =>
                                addWorkflowOutput(
                                  current,
                                  { nodeId: connection.source, outputKey: sourceHandle },
                                  nodeTypes.data ?? [],
                                ),
                              );
                              return;
                            }
                            commitDataConnection(connection, (current, options) =>
                              connectWorkflowNodes(
                                current,
                                connection,
                                nodeTypes.data ?? [],
                                options,
                              ),
                            );
                          }}
                          onReconnect={(edge, connection) => {
                            if (
                              locked ||
                              edge.data?.kind === 'workflow-output' ||
                              edge.data?.projection !== undefined ||
                              connection.target === end.node.id ||
                              connection.source === end.node.id
                            )
                              return;
                            commitDataConnection(
                              connection,
                              (current, options) =>
                                reconnectWorkflowEdge(
                                  current,
                                  edge,
                                  connection,
                                  nodeTypes.data ?? [],
                                  options,
                                ),
                              edge,
                            );
                          }}
                          onEdgesDelete={(deleted) => {
                            if (locked) return;
                            onEdit((current) =>
                              deleted.reduce((definition, edge) => {
                                if (edge.data?.kind !== 'workflow-output')
                                  return disconnectWorkflowEdge(definition, edge);
                                const outputName = edge.data.outputName;
                                const output = definition.outputs.find(
                                  (output) => output.name === outputName,
                                );
                                return output &&
                                  workflowOutputSources(output).some(
                                    (source) =>
                                      source.nodeId === edge.source &&
                                      source.outputKey === edge.sourceHandle,
                                  )
                                  ? removeWorkflowOutputCandidate(definition, output.name, {
                                      nodeId: edge.source,
                                      outputKey: edge.sourceHandle!,
                                    })
                                  : definition;
                              }, current),
                            );
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
                          isValidConnection={(connection) => {
                            if (connection.source === end.node.id) return false;
                            if (connection.target === end.node.id) {
                              const node = workflow.nodes.find(
                                (node) => node.id === connection.source,
                              );
                              return (
                                connection.targetHandle === END_INPUT_HANDLE &&
                                !!nodeTypes.data
                                  ?.find(
                                    (manifest) =>
                                      manifest.type === node?.type &&
                                      manifest.version === node.typeVersion,
                                  )
                                  ?.outputs.some((port) => port.key === connection.sourceHandle)
                              );
                            }
                            return areWorkflowHandlesCompatible(
                              connection.sourceHandle,
                              connection.targetHandle,
                            );
                          }}
                          onMoveEnd={onMoveEnd}
                          defaultViewport={defaultViewport}
                          minZoom={0.1}
                          maxZoom={3}
                          colorMode="dark"
                          fitView={false}
                          proOptions={{ hideAttribution: false }}
                        >
                          <Background
                            variant={BackgroundVariant.Dots}
                            gap={22}
                            size={1.2}
                            color="#ffffff18"
                          />
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
                        />
                      ) : null}
                    </WorkflowManifestProvider>
                  </WorkflowConditionActions.Provider>
                </WorkflowOutputActions.Provider>
              </WorkflowInputContext.Provider>
            </WorkflowModelActionsContext.Provider>
          </WorkflowNodeSettingsActions.Provider>
        </WorkflowNodeSelectionContext.Provider>
      </WorkflowRuntimeProvider>
      {pendingOutputSource ? (
        <WorkflowOutputTargetDialog
          outputs={workflow.outputs}
          disabled={locked || nodeTypes.isPending || nodeTypes.isError}
          onCancel={() => setPendingOutputSource(null)}
          onCreate={() => {
            if (locked) return;
            onEdit((current) =>
              addWorkflowOutput(current, pendingOutputSource, nodeTypes.data ?? []),
            );
            setPendingOutputSource(null);
          }}
          onAppend={(name) => {
            if (locked) return;
            onEdit((current) =>
              appendWorkflowOutputCandidate(
                current,
                name,
                pendingOutputSource,
                nodeTypes.data ?? [],
              ),
            );
            setPendingOutputSource(null);
          }}
        />
      ) : null}
      {outputEditor && (
        <WorkflowOutputDialog
          definition={workflow}
          manifests={nodeTypes.data ?? []}
          previousName={outputEditor.name}
          disabled={locked || nodeTypes.isPending || nodeTypes.isError}
          onCancel={() => setOutputEditor(null)}
          onSave={(value) => {
            if (locked) return;
            onEdit((current) =>
              setWorkflowOutput(current, value, nodeTypes.data ?? [], outputEditor.name),
            );
            setOutputEditor(null);
          }}
        />
      )}
    </div>
  );
}
