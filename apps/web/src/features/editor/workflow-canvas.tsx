'use client';

import { useCallback, useMemo, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type NodeChange,
  type Edge,
  type Node,
} from '@xyflow/react';
import { Undo2, Redo2, Workflow, X } from 'lucide-react';
import type { NodeDefinition, NodeResult } from '@dramaflow/contracts';
import '@xyflow/react/dist/style.css';
import { useEditorStore } from './editor-store';
import { connectionError, toCanvas, type WorkflowCanvasNode } from './graph-adapter';
import { WorkflowNodeView } from './workflow-node';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/form-field';
import { creationPresets } from './creation-presets';

const nodeTypes = { workflow: WorkflowNodeView };

function Canvas({
  catalog,
  readOnly,
  results,
}: {
  catalog: NodeDefinition[];
  readOnly: boolean;
  results?: Record<string, NodeResult>;
}) {
  const state = useEditorStore();
  const flow = useReactFlow();
  const [mode, setMode] = useState<'control' | 'data'>('control');
  const [notice, setNotice] = useState<string | null>(null);
  const canvas = useMemo(
    () => toCanvas(state.definition, catalog, state.selectedNodeId, results),
    [state.definition, state.selectedNodeId, catalog, results],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      const error = connectionError(connection, state.definition, catalog);
      if (error) {
        setNotice(error);
        return;
      }
      const sourcePort = connection.sourceHandle?.split(':').slice(1).join(':');
      const targetPort = connection.targetHandle?.split(':').slice(1).join(':');
      if (!sourcePort || !targetPort) return;
      if (connection.sourceHandle?.startsWith('control:')) {
        if (
          state.definition.controlEdges.some(
            (edge) =>
              edge.source === connection.source &&
              edge.target === connection.target &&
              edge.sourcePort === sourcePort,
          )
        )
          return;
        state.commit({
          ...state.definition,
          controlEdges: [
            ...state.definition.controlEdges,
            {
              id: crypto.randomUUID(),
              source: connection.source,
              target: connection.target,
              sourcePort,
            },
          ],
        });
      } else
        state.setBinding({
          nodeId: connection.target,
          port: targetPort,
          source: { kind: 'node', nodeId: connection.source, port: sourcePort },
          optional: false,
        });
    },
    [state, catalog],
  );

  function changeNodes(changes: NodeChange<WorkflowCanvasNode>[]) {
    const positions = changes.flatMap((change) =>
      change.type === 'position' && change.position
        ? [{ id: change.id, x: change.position.x, y: change.position.y }]
        : [],
    );
    if (positions.length) state.moveNodes(positions);
  }
  function deleteEdges(edges: Edge[]) {
    const ids = new Set(edges.map((edge) => edge.id));
    state.commit({
      ...state.definition,
      controlEdges: state.definition.controlEdges.filter((edge) => !ids.has(`control:${edge.id}`)),
      bindings: state.definition.bindings.filter(
        (binding) => !ids.has(`binding:${binding.nodeId}:${binding.port}`),
      ),
    });
  }
  function drop(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    if (readOnly) return;
    const nodeType = event.dataTransfer.getData('application/dramaflow-node');
    const entry = catalog.find((node) => node.type === nodeType);
    if (entry)
      state.addNode(
        entry,
        flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }),
        creationPresets.find(
          (preset) => preset.id === event.dataTransfer.getData('application/dramaflow-preset'),
        ),
      );
  }

  return (
    <div
      className={`canvas-wrap mode-${mode}`}
      onDrop={drop}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
      }}
    >
      <div className="canvas-topbar">
        <div className="canvas-mode-switch">
          <button
            type="button"
            className={mode === 'control' ? 'active' : ''}
            onClick={() => setMode('control')}
          >
            执行连线
          </button>
          <button
            type="button"
            className={mode === 'data' ? 'active' : ''}
            onClick={() => setMode('data')}
          >
            数据绑定
          </button>
        </div>
        <div className="canvas-mode-switch">
          <Button
            size="icon"
            variant="ghost"
            title="撤销"
            aria-label="撤销"
            onClick={state.undo}
            disabled={readOnly || !state.past.length}
          >
            <Undo2 size={14} />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            title="重做"
            aria-label="重做"
            onClick={state.redo}
            disabled={readOnly || !state.future.length}
          >
            <Redo2 size={14} />
          </Button>
        </div>
      </div>
      {notice && (
        <div
          role="alert"
          className="notice-bar"
          style={{ position: 'absolute', zIndex: 8, left: 18, right: 18, top: 68, borderRadius: 5 }}
        >
          {notice}
          <button
            type="button"
            onClick={() => setNotice(null)}
            aria-label="关闭提示"
            style={{ background: 'transparent' }}
          >
            <X size={13} />
          </button>
        </div>
      )}
      <ReactFlow<WorkflowCanvasNode>
        nodes={canvas.nodes}
        edges={canvas.edges}
        nodeTypes={nodeTypes}
        onConnect={onConnect}
        onNodesChange={readOnly ? undefined : changeNodes}
        onNodesDelete={
          readOnly
            ? undefined
            : (nodes: Node[]) => {
                for (const node of nodes) state.removeNode(node.id);
              }
        }
        onEdgesDelete={readOnly ? undefined : deleteEdges}
        onNodeClick={(_, node) => state.select(node.id)}
        onPaneClick={() => state.select(null)}
        onNodeDragStart={() => state.commit(state.definition)}
        nodesDraggable={!readOnly}
        nodesConnectable={!readOnly}
        deleteKeyCode={readOnly ? null : ['Backspace', 'Delete']}
        fitView
        fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
        minZoom={0.25}
        maxZoom={1.75}
        colorMode="dark"
        defaultEdgeOptions={{ type: 'smoothstep' }}
      >
        <Background variant={BackgroundVariant.Dots} color="#314139" gap={20} size={1} />
        <Controls position="bottom-right" showInteractive={false} />
        <MiniMap
          position="bottom-right"
          style={{ marginBottom: 140, width: 135, height: 85 }}
          nodeColor="#4d6950"
          maskColor="#0c1619a0"
        />
      </ReactFlow>
      {!state.definition.nodes.length && (
        <div className="canvas-empty">
          <EmptyState icon={<Workflow />} title="搭建你的创作流程">
            从左侧添加第一个节点。
            <br />
            让输入、模型与灵感在这里连接。
          </EmptyState>
        </div>
      )}
      <div className="canvas-legend">
        <span>
          <i /> 执行顺序
        </span>
        <span>
          <i className="data" /> 数据绑定
        </span>
        <span>
          {state.definition.nodes.length} NODES · {state.definition.controlEdges.length} EDGES
        </span>
      </div>
    </div>
  );
}

export function WorkflowCanvas(props: {
  catalog: NodeDefinition[];
  readOnly: boolean;
  results?: Record<string, NodeResult>;
}) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}
