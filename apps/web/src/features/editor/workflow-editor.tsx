'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDownToLine, Loader2, MessageSquare, Settings2, X } from 'lucide-react';
import type { WorkflowDraft, Workspace } from '@dramaflow/contracts';
import { api, queryKeys } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { ErrorNotice } from '@/components/ui/form-field';
import { useEditorStore, isEditorDirty } from './editor-store';
import { EditorHeader, SaveNotice } from './editor-header';
import { NodeLibrary } from './node-library';
import { NodeInspector } from './node-inspector';
import { WorkflowCanvas } from './workflow-canvas';
import { ConversationPanel } from '@/features/conversations/conversation-panel';
import { RunInputDialog } from '@/features/runs/run-input-dialog';
import { RunPanel, useRun } from '@/features/runs/run-panel';
import { ResultsPanel } from '@/features/runs/results-panel';
import { cn } from '@/lib/utils';

export function WorkflowEditor({
  workflowId,
  workspace,
  workspacePicker,
  onBack,
  onPlugins,
}: {
  workflowId: string;
  workspace: Workspace;
  workspacePicker: React.ReactNode;
  onBack: () => void;
  onPlugins: () => void;
}) {
  const client = useQueryClient();
  const state = useEditorStore();
  const workflow = useQuery({
    queryKey: queryKeys.workflow(workflowId),
    queryFn: () => api.workflow(workflowId),
  });
  const catalog = useQuery({ queryKey: queryKeys.catalog, queryFn: api.catalog });
  const plugins = useQuery({
    queryKey: queryKeys.plugins(workspace.id),
    queryFn: () => api.plugins(workspace.id),
  });
  const connections = useQuery({
    queryKey: queryKeys.connections(workspace.id),
    queryFn: () => api.connections(workspace.id),
  });
  const [tab, setTab] = useState<'config' | 'chat' | 'results'>('config');
  const [libraryCollapsed, setLibraryCollapsed] = useState(true);
  const [inspectorCollapsed, setInspectorCollapsed] = useState(true);
  const [runsOpen, setRunsOpen] = useState(false);
  const [runDialog, setRunDialog] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const run = useRun(runId);
  const dirty = isEditorDirty(state);
  useEffect(() => {
    if (workflow.data && state.workflowId !== workflowId) state.load(workflow.data);
  }, [workflow.data, workflowId, state]);
  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);
  const save = useMutation({
    mutationFn: () =>
      api.saveWorkflow({
        id: workflowId,
        revision: state.revision,
        name: state.name,
        description: state.description,
        definition: state.definition,
      }),
    onSuccess: (draft) => {
      state.acceptSaved(draft);
      client.setQueryData(queryKeys.workflow(workflowId), draft);
      void client.invalidateQueries({ queryKey: queryKeys.workflows(workspace.id) });
      setMessage('草稿已保存');
    },
  });
  const validate = useMutation({
    mutationFn: () => api.validate(workflowId, state.definition),
    onSuccess: (result) => setMessage(result.valid ? '工作流校验通过' : null),
  });
  const publish = useMutation({
    mutationFn: async () => {
      if (dirty) {
        const draft = await api.saveWorkflow({
          id: workflowId,
          revision: state.revision,
          name: state.name,
          description: state.description,
          definition: state.definition,
        });
        state.acceptSaved(draft);
        client.setQueryData(queryKeys.workflow(workflowId), draft);
      }
      return api.publish(workflowId);
    },
    onSuccess: async (version) => {
      await client.invalidateQueries({ queryKey: queryKeys.workflow(workflowId) });
      await client.invalidateQueries({ queryKey: queryKeys.workflows(workspace.id) });
      setMessage(`已发布 v${version.number}，可以开始运行`);
    },
  });
  const pending = save.isPending || publish.isPending;
  const readOnly = workspace.role === 'viewer' || pending;
  function applied(draft: WorkflowDraft) {
    state.load(draft);
    setMessage('建议已应用到草稿；生成与运行需要你手动启动。');
  }
  const selectedNode = state.definition.nodes.find((node) => node.id === state.selectedNodeId);
  const errors = [
    workflow.error,
    catalog.error,
    plugins.error,
    connections.error,
    save.error,
    validate.error,
    publish.error,
    run.error,
  ].filter(Boolean);
  if (workflow.isPending || catalog.isPending || state.workflowId !== workflowId)
    return (
      <div className="workspace-main">
        <div className="workspace-header">
          {workspacePicker}
          <Button variant="ghost" onClick={onBack}>
            返回工作流
          </Button>
        </div>
        {workflow.error || catalog.error ? (
          <div style={{ padding: 24 }}>
            <ErrorNotice
              error={workflow.error ?? catalog.error}
              onRetry={() => {
                void workflow.refetch();
                void catalog.refetch();
              }}
            />
          </div>
        ) : (
          <div className="loading-row">
            <Loader2 size={15} className="animate-spin" />
            正在打开工作流…
          </div>
        )}
      </div>
    );
  return (
    <div className="workspace-main">
      <EditorHeader
        workspacePicker={workspacePicker}
        name={state.name}
        dirty={dirty}
        revision={state.revision}
        readOnly={readOnly}
        pending={pending}
        published={!!workflow.data?.publishedVersionId}
        onBack={onBack}
        onSave={() => save.mutate()}
        onValidate={() => validate.mutate()}
        onPublish={() => publish.mutate()}
        onRun={() => setRunDialog(true)}
        onRuns={() => setRunsOpen(!runsOpen)}
        onLibrary={() => setLibraryCollapsed(!libraryCollapsed)}
        onInspector={() => setInspectorCollapsed(!inspectorCollapsed)}
        onPlugins={onPlugins}
      />
      {message && (
        <div className="notice-bar" style={{ background: '#21351f', borderColor: '#3e5633' }}>
          <SaveNotice message={message} valid />
          <button
            type="button"
            onClick={() => setMessage(null)}
            aria-label="关闭提示"
            style={{ background: 'transparent' }}
          >
            <X size={12} />
          </button>
        </div>
      )}
      {errors.length > 0 && (
        <div style={{ padding: '10px 15px 0', maxHeight: 170, overflow: 'auto' }}>
          {errors.map((error, index) => (
            <ErrorNotice key={index} error={error} />
          ))}
        </div>
      )}
      {validate.data && !validate.data.valid && (
        <div className="notice-bar" style={{ maxHeight: 130, overflow: 'auto', display: 'block' }}>
          {validate.data.issues.map((issue, index) => (
            <button
              type="button"
              key={index}
              onClick={() => {
                if (issue.nodeId) state.select(issue.nodeId);
              }}
              style={{
                display: 'block',
                textAlign: 'left',
                color: 'inherit',
                background: 'transparent',
                padding: '4px 0',
              }}
            >
              {issue.nodeId ? `${issue.nodeId}：` : ''}
              {issue.message}
            </button>
          ))}
        </div>
      )}
      <div className="workspace-content">
        <div className="editor-layout">
          <NodeLibrary
            catalog={catalog.data?.items ?? []}
            readOnly={readOnly}
            collapsed={libraryCollapsed}
          />
          <div style={{ display: 'flex', minWidth: 0, flex: 1, position: 'relative' }}>
            <WorkflowCanvas
              catalog={catalog.data?.items ?? []}
              readOnly={readOnly}
              results={run.data?.nodeResults}
            />
            {runsOpen && (
              <RunPanel
                workflowId={workflowId}
                runId={runId}
                onSelect={setRunId}
                onClose={() => setRunsOpen(false)}
                readOnly={readOnly}
              />
            )}
          </div>
          <aside
            className={cn('inspector', inspectorCollapsed && 'collapsed')}
            aria-label="节点属性与对话"
          >
            <div className="inspector-tabs">
              <button
                type="button"
                onClick={() => setTab('config')}
                className={tab === 'config' ? 'active' : ''}
              >
                <Settings2 size={12} />
                配置
              </button>
              <button
                type="button"
                onClick={() => setTab('chat')}
                className={tab === 'chat' ? 'active' : ''}
              >
                <MessageSquare size={12} />
                对话
              </button>
              <button
                type="button"
                onClick={() => setTab('results')}
                className={tab === 'results' ? 'active' : ''}
              >
                <ArrowDownToLine size={12} />
                结果
              </button>
            </div>
            {tab === 'config' ? (
              <NodeInspector
                catalog={catalog.data?.items ?? []}
                plugins={plugins.data?.items ?? []}
                connections={connections.data?.items ?? []}
                readOnly={readOnly}
              />
            ) : tab === 'chat' ? (
              <ConversationPanel
                workflowId={workflowId}
                workspaceId={workspace.id}
                nodeId={state.selectedNodeId}
                plugins={plugins.data?.items ?? []}
                connections={connections.data?.items ?? []}
                readOnly={readOnly}
                onApplied={applied}
                runId={runId ?? undefined}
              />
            ) : (
              <ResultsPanel
                run={run.data}
                nodeId={state.selectedNodeId}
                nodeType={selectedNode?.type}
                catalog={catalog.data?.items ?? []}
                readOnly={readOnly}
                onRegenerated={(next) => {
                  setRunId(next.id);
                  setRunsOpen(true);
                }}
              />
            )}
          </aside>
        </div>
      </div>
      {runDialog && workflow.data?.publishedVersionId && (
        <RunInputDialog
          workflowId={workflowId}
          versionId={workflow.data.publishedVersionId}
          onClose={() => setRunDialog(false)}
          onStarted={(next) => {
            setRunId(next.id);
            setRunDialog(false);
            setRunsOpen(true);
            client.setQueryData(queryKeys.run(next.id), next);
            void client.invalidateQueries({ queryKey: queryKeys.runs(workflowId) });
          }}
        />
      )}
    </div>
  );
}
