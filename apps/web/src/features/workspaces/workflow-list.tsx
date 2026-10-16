'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, ArrowUpRight, Clapperboard, Loader2, Plus, Workflow } from 'lucide-react';
import type { Workspace } from '@dramaflow/contracts';
import { api, queryKeys } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { EmptyState, ErrorNotice, FormField } from '@/components/ui/form-field';

export function WorkflowList({
  workspace,
  onOpen,
}: {
  workspace: Workspace;
  onOpen: (workflowId: string) => void;
}) {
  const client = useQueryClient();
  const workflows = useQuery({
    queryKey: queryKeys.workflows(workspace.id),
    queryFn: () => api.workflows(workspace.id),
  });
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const create = useMutation({
    mutationFn: () => api.createWorkflow(workspace.id, name),
    onSuccess: (draft) => {
      client.setQueryData(queryKeys.workflow(draft.id), draft);
      void client.invalidateQueries({ queryKey: queryKeys.workflows(workspace.id) });
      setCreating(false);
      onOpen(draft.id);
    },
  });
  return (
    <section className="workspace-home">
      <div className="section-heading">
        <div>
          <span className="eyebrow">
            <i /> THE CREATION ROOM
          </span>
          <h1>每个故事，都有自己的路径。</h1>
          <p>连接模型与创意，编排属于你的生成方式。</p>
        </div>
        <Button disabled={workspace.role === 'viewer'} onClick={() => setCreating(true)}>
          <Plus size={15} />
          新建工作流
        </Button>
      </div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '10px 0 17px',
          marginTop: 20,
          borderBottom: '1px solid var(--border)',
          marginBottom: 24,
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
          <Workflow size={14} className="accent" />
          我的工作流{' '}
          <span className="badge" style={{ marginLeft: 4 }}>
            {workflows.data?.items.length ?? '—'}
          </span>
        </span>
        <span className="eyebrow" style={{ fontSize: 8 }}>
          WORKSPACE / {workspace.name}
        </span>
      </div>
      {workflows.error && (
        <ErrorNotice error={workflows.error} onRetry={() => void workflows.refetch()} />
      )}
      {workflows.isPending && (
        <div className="loading-row">
          <Loader2 className="animate-spin" size={16} />
          正在读取工作流…
        </div>
      )}
      {workflows.data?.items.length === 0 ? (
        <EmptyState
          icon={<Clapperboard />}
          title="下一部作品，从这里开始。"
          action={
            <Button
              variant="outline"
              disabled={workspace.role === 'viewer'}
              onClick={() => setCreating(true)}
            >
              创建第一个工作流
              <ArrowRight size={13} />
            </Button>
          }
        >
          从输入到剧本、画面，再到人工确认。
          <br />
          你可以自由搭建，也可以随时重写路径。
        </EmptyState>
      ) : (
        <div className="workflow-grid">
          {workflows.data?.items.map((workflow) => (
            <button
              key={workflow.id}
              type="button"
              className="workflow-card"
              onClick={() => onOpen(workflow.id)}
            >
              <div className="workflow-card-visual">
                <div style={{ display: 'flex', alignItems: 'center', gap: 13 }}>
                  <span className="node-icon" style={{ width: 38, height: 38 }}>
                    <Clapperboard size={18} />
                  </span>
                  <span style={{ borderTop: '1px dashed #5b7956', width: 30 }} />
                  <span className="node-icon" style={{ width: 38, height: 38 }}>
                    <Workflow size={18} />
                  </span>
                  <span style={{ borderTop: '1px dashed #5b7956', width: 30 }} />
                  <span className="node-icon" style={{ width: 38, height: 38 }}>
                    <ArrowUpRight size={18} />
                  </span>
                </div>
              </div>
              <div className="workflow-card-body">
                <h3>{workflow.name}</h3>
                <p>{workflow.description || '尚未添加描述'}</p>
                <div className="workflow-card-meta">
                  <span>
                    {workflow.publishedVersionId ? 'PUBLISHED' : 'DRAFT'} · r{workflow.revision}
                  </span>
                  <span>{new Date(workflow.updatedAt).toLocaleDateString('zh-CN')}</span>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
      {creating && (
        <Dialog
          title="创建工作流"
          onClose={() => {
            if (!create.isPending) setCreating(false);
          }}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              create.mutate();
            }}
          >
            <p className="muted text-xs leading-relaxed" style={{ margin: '0 0 22px' }}>
              给这条创作路径起个名字。你可以在画布中自由添加节点，配置自己的模型能力。
            </p>
            <FormField label="工作流名称">
              <input
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={120}
                minLength={1}
                required
                placeholder="例如：短篇漫剧创作"
              />
            </FormField>
            {create.error && <ErrorNotice error={create.error} />}
            <Button type="submit" disabled={!name.trim() || create.isPending}>
              {create.isPending && <Loader2 className="animate-spin" />}创建工作流
              <ArrowRight />
            </Button>
          </form>
        </Dialog>
      )}
    </section>
  );
}
