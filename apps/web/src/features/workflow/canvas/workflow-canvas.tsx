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
  type XYPosition,
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
import { WorkflowEnd, WorkflowOutputActions, WorkflowOutputDialog } from '../outputs/workflow-end';
import {
  addWorkflowOutput,
  setWorkflowOutput,
  removeWorkflowOutput,
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
  const { screenToFlowPosition } = useReactFlow<CanvasNode, CanvasEdge>();
  const locked = reloading || interactionLocked;
  const { modal } = App.useApp();
  const nodeTypes = useQuery({ queryKey: nodeTypeKeys.list, queryFn: nodeTypeApi.list });
  const [nodeView, setNodeView] = useState<
    ReadonlyMap<string, Pick<WorkflowNode, 'selected' | 'measured'>>
  >(new Map());
  const [endPosition, setEndPosition] = useState<XYPosition>(
    () => projectWorkflowEnd(workflow).node.position,
  );
  const [outputEditor, setOutputEditor] = useState<{ name?: string } | null>(null);
  const end = useMemo(() => projectWorkflowEnd(workflow, endPosition), [workflow, endPosition]);
  const [selectedEdgeIds, setSelectedEdgeIds] = useState<ReadonlySet<string>>(new Set());
  const nodes = useMemo(
    () =>
      [...toReactFlowNodes(workflow), end.node].map((node) => ({
        ...node,
        ...nodeView.get(node.id),
        deletable: node.type !== 'workflowEnd',
      })),
    [workflow, nodeView, end.node],
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
          <WorkflowOutputActions.Provider
            value={{
              disabled: locked,
              onConfigure: (name) => setOutputEditor(name === undefined ? {} : { name }),
              onRemove: (name) => {
                if (!locked) onEdit((current) => removeWorkflowOutput(current, name));
              },
            }}
          >
            <WorkflowConditionActions.Provider
              value={{
                disabled: locked,
                onChange: (nodeId, condition) => {
                  if (!locked) onEdit((current) => setIfCondition(current, nodeId, condition));
                },
              }}
            >
              <WorkflowManifestProvider manifests={nodeTypes.data ?? []}>
                <ReactFlow<CanvasNode, CanvasEdge>
                  nodeTypes={canvasNodeTypes}
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
                      removedIds.length ||
                      domainChanges.some((change) => change.type === 'position' && change.position)
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
                      if (connection.targetHandle !== END_INPUT_HANDLE || !sourceHandle) return;
                      onEdit((current) =>
                        addWorkflowOutput(
                          current,
                          { nodeId: connection.source, outputKey: sourceHandle },
                          nodeTypes.data ?? [],
                        ),
                      );
                      return;
                    }
                    commitDataConnection(connection, (current, replaceBinding) =>
                      connectWorkflowNodes(current, connection, nodeTypes.data ?? [], {
                        replaceBinding,
                      }),
                    );
                  }}
                  onReconnect={(edge, connection) => {
                    if (
                      locked ||
                      edge.data?.kind === 'workflow-output' ||
                      connection.target === end.node.id ||
                      connection.source === end.node.id
                    )
                      return;
                    commitDataConnection(connection, (current, replaceBinding) =>
                      reconnectWorkflowEdge(current, edge, connection, nodeTypes.data ?? [], {
                        replaceBinding,
                      }),
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
                        return output?.source.nodeId === edge.source &&
                          output.source.outputKey === edge.sourceHandle
                          ? removeWorkflowOutput(definition, output.name)
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
                      const node = workflow.nodes.find((node) => node.id === connection.source);
                      return (
                        connection.targetHandle === END_INPUT_HANDLE &&
                        !!nodeTypes.data
                          ?.find(
                            (manifest) =>
                              manifest.type === node?.type && manifest.version === node.typeVersion,
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
              </WorkflowManifestProvider>
            </WorkflowConditionActions.Provider>
          </WorkflowOutputActions.Provider>
        </WorkflowInputContext.Provider>
      </WorkflowModelActionsContext.Provider>
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
