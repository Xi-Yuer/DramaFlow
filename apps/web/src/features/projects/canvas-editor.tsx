'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type NodeMouseHandler,
  type OnMove,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { App, Button } from 'antd';
import { ArrowLeft } from 'lucide-react';
import {
  saveProjectSchema,
  validateWorkflow,
  type NodeDefinition,
  type Project,
  type WorkflowDefinition,
} from '@dramaflow/contracts';
import { ApiError } from '@/lib/http';
import { AccountMenuButton } from '@/features/auth/account-menu';
import { CatalogContext, canvasNodeTypes } from './flow-node';
import {
  clampViewport,
  connectionIssue,
  draftSignature,
  toCanvasEdges,
  toCanvasNodes,
  toWorkflow,
  type CanvasNode,
} from './graph';
import { NodeMenu, type CanvasMenu } from './node-menu';
import { projectApi } from './project-api';

const edgeDefaults = {
  type: 'smoothstep',
  markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: '#8a8a96' },
} as const;

export function CanvasEditor({
  project,
  catalog,
  onReload,
}: {
  project: Project;
  catalog: NodeDefinition[];
  onReload: () => void;
}) {
  const catalogMap = useMemo(
    () => new Map(catalog.map((item) => [`${item.type}@${item.version}`, item])),
    [catalog],
  );
  return (
    <CatalogContext.Provider value={catalogMap}>
      <ReactFlowProvider>
        <CanvasBoard project={project} catalog={catalog} onReload={onReload} />
      </ReactFlowProvider>
    </CatalogContext.Provider>
  );
}

function CanvasBoard({
  project,
  catalog,
  onReload,
}: {
  project: Project;
  catalog: NodeDefinition[];
  onReload: () => void;
}) {
  const router = useRouter();
  const { message, modal } = App.useApp();
  const { screenToFlowPosition, getViewport } = useReactFlow();
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>(
    toCanvasNodes(project.definition),
  );
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(
    toCanvasEdges(project.definition).map((edge) => ({ ...edge, ...edgeDefaults })),
  );
  const [bindings, setBindings] = useState<WorkflowDefinition['bindings']>(
    project.definition.bindings,
  );
  const [name, setName] = useState(project.name);
  const [viewport, setViewport] = useState(project.viewport);
  const [menu, setMenu] = useState<CanvasMenu | null>(null);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [revision, setRevision] = useState(project.revision);
  const [savedSignature, setSavedSignature] = useState(() =>
    draftSignature(
      project.name,
      toCanvasNodes(project.definition),
      toCanvasEdges(project.definition),
      project.definition.bindings,
      project.viewport,
    ),
  );
  const signature = draftSignature(name, nodes, edges, bindings, viewport);
  const dirty = signature !== savedSignature;
  const selected = nodes.filter((node) => node.selected);
  const active = selected.length === 1 ? selected[0] : undefined;
  const activeDefinition = active
    ? catalog.find(
        (item) => item.type === active.data.nodeType && item.version === active.data.version,
      )
    : undefined;

  useEffect(() => {
    if (!dirty) return;
    const onLeave = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onLeave);
    return () => window.removeEventListener('beforeunload', onLeave);
  }, [dirty]);

  const closeMenu = useCallback(() => setMenu(null), []);

  function updateNode(id: string, patch: Partial<CanvasNode['data']>) {
    setNodes((current) =>
      current.map((node) =>
        node.id === id ? { ...node, data: { ...node.data, ...patch } } : node,
      ),
    );
  }

  function removeNode(id: string) {
    setNodes((current) => current.filter((node) => node.id !== id));
    setEdges((current) => current.filter((edge) => edge.source !== id && edge.target !== id));
    setMenu(null);
  }

  function addNode(definition: NodeDefinition, flow: { x: number; y: number }) {
    const id = crypto.randomUUID();
    setNodes((current) => [
      ...current.map((node) => ({ ...node, selected: false })),
      {
        id,
        type: 'canvas',
        selected: true,
        position: { x: flow.x - 110, y: flow.y - 36 },
        data: {
          nodeType: definition.type,
          version: definition.version,
          title: definition.title,
          config: structuredClone(definition.defaultConfig),
        },
      },
    ]);
    setMenu(null);
  }

  const onConnect = useCallback(
    (connection: Connection) => {
      const source = connection.source;
      const target = connection.target;
      if (!source || !target) return;
      const issue = connectionIssue(toWorkflow(nodes, edges, bindings), catalog, {
        source,
        target,
      });
      if (issue) {
        void message.warning(issue);
        return;
      }
      setEdges((current) => [
        ...current,
        { id: crypto.randomUUID(), source, target, ...edgeDefaults },
      ]);
    },
    [bindings, catalog, edges, message, nodes, setEdges],
  );

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

  const onNodeContextMenu = useCallback<NodeMouseHandler<CanvasNode>>((event, node) => {
    event.preventDefault();
    setMenu({ kind: 'node', x: event.clientX, y: event.clientY, nodeId: node.id });
  }, []);

  function openPaneMenu(event: MouseEvent | React.MouseEvent) {
    event.preventDefault();
    setMenu({
      kind: 'pane',
      x: event.clientX,
      y: event.clientY,
      flow: screenToFlowPosition({ x: event.clientX, y: event.clientY }),
    });
  }

  const savingLock = useRef(false);
  const save = useCallback(async () => {
    if (savingLock.current || !dirty) return;
    const trimmed = name.trim();
    if (!trimmed) {
      void message.error('请填写项目名称');
      return;
    }
    if (nodes.some((node) => !node.data.title.trim())) {
      void message.error('请为每个节点填写标题');
      return;
    }
    const definition = toWorkflow(nodes, edges, bindings);
    const view = clampViewport(getViewport());
    const payload = { revision, name: trimmed, definition, viewport: view };
    const parsed = saveProjectSchema.safeParse(payload);
    if (!parsed.success) {
      void message.error(parsed.error.issues[0]?.message ?? '画布内容不符合保存协议');
      return;
    }
    const issues = validateWorkflow(definition, catalog);
    if (issues.length) {
      void message.error([...new Set(issues.map((item) => item.message))].join('；'));
      return;
    }
    savingLock.current = true;
    setSaving(true);
    try {
      const result = await projectApi.save(project.id, parsed.data);
      setRevision(result.revision);
      setBindings(definition.bindings);
      setViewport(view);
      setSavedSignature(draftSignature(trimmed, nodes, edges, definition.bindings, view));
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
  }, [bindings, catalog, dirty, edges, getViewport, message, name, nodes, project.id, revision]);

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

  const notes =
    active && typeof active.data.config.notes === 'string' ? active.data.config.notes : null;

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
          {conflict ? '版本冲突' : dirty ? '未保存' : `已保存 · 版本 ${revision}`}
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
        <AccountMenuButton />
      </header>
      <div className="canvas-stage">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={canvasNodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onMoveEnd={onMoveEnd}
          onPaneClick={closeMenu}
          onPaneContextMenu={openPaneMenu}
          onNodeContextMenu={onNodeContextMenu}
          isValidConnection={(connection) =>
            connectionIssue(toWorkflow(nodes, edges, bindings), catalog, connection) === null
          }
          defaultViewport={project.viewport}
          minZoom={0.1}
          maxZoom={3}
          colorMode="dark"
          deleteKeyCode={['Backspace', 'Delete']}
          edgesReconnectable={false}
          fitView={false}
          proOptions={{ hideAttribution: false }}
          defaultEdgeOptions={edgeDefaults}
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} color="#ffffff18" />
          <Controls showInteractive={false} position="bottom-left" />
        </ReactFlow>
        {nodes.length === 0 ? (
          <div className="canvas-empty">
            <p>右击画布，添加流程节点</p>
            <span>当前节点只负责编排。生成、运行和具体能力后续再接入。</span>
          </div>
        ) : null}
        {menu ? (
          <NodeMenu
            menu={menu}
            catalog={catalog}
            onAdd={addNode}
            onDelete={removeNode}
            onClose={closeMenu}
          />
        ) : null}
        {active ? (
          <aside className="node-inspector" aria-label="节点设置">
            <span className="flow-kicker">
              {activeDefinition?.executable === false
                ? '编排节点'
                : (activeDefinition?.title ?? '节点')}
            </span>
            <label>
              标题
              <input
                value={active.data.title}
                maxLength={80}
                onChange={(event) => updateNode(active.id, { title: event.target.value })}
              />
            </label>
            {notes !== null ? (
              <label>
                备注
                <textarea
                  value={notes}
                  maxLength={2000}
                  rows={5}
                  placeholder="给这个步骤留一点说明"
                  onChange={(event) =>
                    updateNode(active.id, {
                      config: { ...active.data.config, notes: event.target.value },
                    })
                  }
                />
              </label>
            ) : null}
            <p>{activeDefinition?.description ?? '这个节点类型当前未安装，保存时会被拒绝。'}</p>
            <Button size="small" danger onClick={() => removeNode(active.id)}>
              删除节点
            </Button>
          </aside>
        ) : null}
      </div>
    </main>
  );
}
