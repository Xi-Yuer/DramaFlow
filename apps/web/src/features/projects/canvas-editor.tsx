'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type OnConnect,
  type OnEdgesChange,
  type OnEdgesDelete,
  type OnMove,
  type OnReconnect,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { App, Button } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { saveProjectSchema, type Project, type WorkflowDefinition } from '@dramaflow/contracts';
import { ApiError } from '@/lib/http';
import { AccountMenuButton } from '@/features/auth/account-menu';
import { nodeTypeApi, nodeTypeKeys } from '@/features/workflow/node-type-api';
import { WorkflowManifestProvider, workflowNodeTypes } from '@/features/workflow/workflow-node';
import { areWorkflowHandlesCompatible } from '@/features/workflow/workflow-handles';
import {
  connectWorkflowNodes,
  disconnectWorkflowEdge,
  reconnectWorkflowEdge,
  toReactFlowEdges,
  toReactFlowNodes,
  type WorkflowEdge,
  type WorkflowNode,
} from '@/features/workflow/react-flow-adapter';
import { projectApi } from './project-api';
import { clampViewport, draftSignature } from './viewport';

export function CanvasEditor({ project, onReload }: { project: Project; onReload: () => void }) {
  return (
    <ReactFlowProvider>
      <CanvasBoard project={project} onReload={onReload} />
    </ReactFlowProvider>
  );
}

function CanvasBoard({ project, onReload }: { project: Project; onReload: () => void }) {
  const router = useRouter();
  const { message, modal } = App.useApp();
  const { getViewport } = useReactFlow();
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
  const onConnect: OnConnect = (connection) => {
    try {
      setWorkflow(connectWorkflowNodes(workflow, connection, nodeTypes.data ?? []));
    } catch (error) {
      void message.error(error instanceof Error ? error.message : '连线失败');
    }
  };
  const onReconnect: OnReconnect<WorkflowEdge> = (edge, connection) => {
    try {
      setWorkflow(reconnectWorkflowEdge(workflow, edge, connection, nodeTypes.data ?? []));
    } catch (error) {
      void message.error(error instanceof Error ? error.message : '重连失败');
    }
  };
  const onEdgesDelete: OnEdgesDelete<WorkflowEdge> = (deleted) => {
    setWorkflow((current) => deleted.reduce(disconnectWorkflowEdge, current));
  };
  const onEdgesChange: OnEdgesChange<WorkflowEdge> = (changes) => {
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
  const [name, setName] = useState(project.name);
  const [viewport, setViewport] = useState(project.viewport);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [revision, setRevision] = useState(project.revision);
  const [savedSignature, setSavedSignature] = useState(() =>
    draftSignature(project.name, project.viewport),
  );
  const signature = draftSignature(name, viewport);
  const dirty = signature !== savedSignature;

  useEffect(() => {
    if (!dirty) return;
    const onLeave = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onLeave);
    return () => window.removeEventListener('beforeunload', onLeave);
  }, [dirty]);

  const onMoveEnd = useCallback<OnMove>((_, next) => {
    const view = clampViewport(next);
    setViewport((current) =>
      current.x.toFixed(2) === view.x.toFixed(2) &&
      current.y.toFixed(2) === view.y.toFixed(2) &&
      current.zoom.toFixed(3) === view.zoom.toFixed(3)
        ? current
        : view,
    );
  }, []);

  const savingLock = useRef(false);
  const save = useCallback(async () => {
    if (savingLock.current || !dirty) return;
    const trimmed = name.trim();
    if (!trimmed) {
      void message.error('请填写项目名称');
      return;
    }
    const view = clampViewport(getViewport());
    const payload = { revision, name: trimmed, viewport: view };
    const parsed = saveProjectSchema.safeParse(payload);
    if (!parsed.success) {
      void message.error(parsed.error.issues[0]?.message ?? '画布内容不符合保存协议');
      return;
    }
    savingLock.current = true;
    setSaving(true);
    try {
      const result = await projectApi.save(project.id, parsed.data);
      setRevision(result.revision);
      setViewport(view);
      setSavedSignature(draftSignature(trimmed, view));
      setName(trimmed);
      setConflict(false);
      void message.success('画布已保存');
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setConflict(true);
        void message.error(error.message);
        return;
      }
      void message.error(error instanceof Error ? error.message : '保存失败');
    } finally {
      savingLock.current = false;
      setSaving(false);
    }
  }, [dirty, getViewport, message, name, project.id, revision]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void save();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save]);

  function leave() {
    if (!dirty) {
      router.push('/projects');
      return;
    }
    modal.confirm({
      title: '离开会放弃未保存的修改',
      okText: '离开',
      cancelText: '继续编辑',
      onOk: () => router.push('/projects'),
    });
  }

  function reload() {
    if (!dirty) {
      onReload();
      return;
    }
    modal.confirm({
      title: '重新加载会放弃未保存的修改',
      okText: '重新加载',
      cancelText: '继续编辑',
      onOk: onReload,
    });
  }

  return (
    <main className="canvas-shell" onContextMenu={(event) => event.preventDefault()}>
      <header className="canvas-top">
        <Button type="text" icon={<ArrowLeft size={16} />} onClick={leave} aria-label="返回项目">
          项目
        </Button>
        <input
          className="canvas-name"
          value={name}
          maxLength={80}
          aria-label="项目名称"
          onChange={(event) => setName(event.target.value)}
        />
        <span className="canvas-status">
          {conflict ? '修订冲突' : dirty ? '未保存' : `已保存 · 修订 ${revision}`}
        </span>
        {conflict ? (
          <Button size="small" onClick={reload}>
            重新加载
          </Button>
        ) : null}
        <Button
          type="primary"
          size="small"
          loading={saving}
          disabled={!dirty && !saving}
          onClick={() => void save()}
        >
          保存
        </Button>
        <div className="canvas-actions">
          <AccountMenuButton />
        </div>
      </header>
      <div className="canvas-stage">
        <WorkflowManifestProvider manifests={nodeTypes.data ?? []}>
          <ReactFlow<WorkflowNode, WorkflowEdge>
            nodeTypes={workflowNodeTypes}
            nodes={nodes}
            edges={edges}
            onConnect={onConnect}
            onReconnect={onReconnect}
            onEdgesDelete={onEdgesDelete}
            onEdgesChange={onEdgesChange}
            isValidConnection={(connection) =>
              areWorkflowHandlesCompatible(connection.sourceHandle, connection.targetHandle)
            }
            onMoveEnd={onMoveEnd}
            defaultViewport={project.viewport}
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
    </main>
  );
}
