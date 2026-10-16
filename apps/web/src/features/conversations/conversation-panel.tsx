'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bot,
  Loader2,
  MessageSquare,
  Paperclip,
  Plus,
  ScanEye,
  Send,
  Sparkles,
} from 'lucide-react';
import {
  modelSelectionSchema,
  type ModelSelection,
  type PluginConnection,
  type PluginInstallation,
  type WorkflowDraft,
} from '@dramaflow/contracts';
import { api, queryKeys } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { EmptyState, ErrorNotice } from '@/components/ui/form-field';
import { ModelSelector } from '@/features/plugins/model-selector';
import { ContextPreview } from './context-preview';
import { ProposalCard } from './proposal-card';

interface ConversationPanelProps {
  workflowId: string;
  workspaceId: string;
  nodeId: string | null;
  plugins: PluginInstallation[];
  connections: PluginConnection[];
  readOnly: boolean;
  onApplied: (draft: WorkflowDraft) => void;
  runId?: string;
}

export function ConversationPanel(props: ConversationPanelProps) {
  const [scope, setScope] = useState<'workflow' | 'node'>('workflow');
  const effectiveScope = scope === 'node' && !props.nodeId ? 'workflow' : scope;
  return (
    <div className="conversation">
      <div className="conversation-scope">
        <button
          type="button"
          className={effectiveScope === 'workflow' ? 'active' : ''}
          onClick={() => setScope('workflow')}
        >
          工作流全局对话
        </button>
        <button
          type="button"
          className={effectiveScope === 'node' ? 'active' : ''}
          disabled={!props.nodeId}
          onClick={() => setScope('node')}
        >
          当前节点对话
        </button>
      </div>
      <ConversationThread
        key={`${props.workflowId}:${effectiveScope}:${effectiveScope === 'node' ? props.nodeId : 'global'}`}
        {...props}
        scope={effectiveScope}
      />
    </div>
  );
}

function ConversationThread({
  workflowId,
  workspaceId,
  nodeId,
  plugins,
  connections,
  readOnly,
  onApplied,
  runId,
  scope,
}: ConversationPanelProps & { scope: 'workflow' | 'node' }) {
  const client = useQueryClient();
  const conversations = useQuery({
    queryKey: queryKeys.conversations(workflowId),
    queryFn: () => api.conversations(workflowId),
  });
  const available =
    conversations.data?.items.filter(
      (conversation) =>
        conversation.scope === scope && (scope !== 'node' || conversation.nodeId === nodeId),
    ) ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = available.find((conversation) => conversation.id === selectedId) ?? available[0];
  const [newConversation, setNewConversation] = useState(false);
  const [model, setModel] = useState<ModelSelection>();
  const [content, setContent] = useState('');
  const [showAssets, setShowAssets] = useState(false);
  const [assetIds, setAssetIds] = useState<string[]>([]);
  const [includeRun, setIncludeRun] = useState(false);
  const assets = useQuery({
    queryKey: queryKeys.assets(workspaceId),
    queryFn: () => api.assets(workspaceId),
    enabled: showAssets,
  });
  const messages = useQuery({
    queryKey: queryKeys.messages(selected?.id ?? ''),
    queryFn: () => api.messages(selected!.id),
    enabled: !!selected,
  });
  const proposals = useQuery({
    queryKey: queryKeys.proposals(selected?.id ?? ''),
    queryFn: () => api.proposals(selected!.id),
    enabled: !!selected,
  });
  const summaries = useQuery({
    queryKey: queryKeys.summaries(selected?.id ?? ''),
    queryFn: () => api.summaries(selected!.id),
    enabled: !!selected,
  });
  const summarize = useMutation({
    mutationFn: () => api.summarize(selected!.id, crypto.randomUUID()),
    onSuccess: async () => {
      preview.reset();
      await client.invalidateQueries({ queryKey: queryKeys.summaries(selected!.id) });
    },
  });
  const create = useMutation({
    mutationFn: () =>
      api.createConversation(
        workflowId,
        scope,
        modelSelectionSchema.parse(model),
        scope === 'node' ? (nodeId ?? undefined) : undefined,
      ),
    onSuccess: async (conversation) => {
      await client.invalidateQueries({ queryKey: queryKeys.conversations(workflowId) });
      setSelectedId(conversation.id);
      setNewConversation(false);
    },
  });
  const preview = useMutation({
    mutationFn: () =>
      api.previewContext(selected!.id, content, assetIds, includeRun ? runId : undefined),
  });
  const send = useMutation({
    mutationFn: () => api.chat(selected!.id, content, assetIds, includeRun ? runId : undefined),
    onSuccess: async () => {
      setContent('');
      preview.reset();
      await Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.messages(selected!.id) }),
        client.invalidateQueries({ queryKey: queryKeys.proposals(selected!.id) }),
      ]);
    },
  });
  const showSetup = !selected || newConversation;
  return (
    <>
      <div className="chat-messages">
        {conversations.error && (
          <ErrorNotice error={conversations.error} onRetry={() => void conversations.refetch()} />
        )}
        {conversations.isPending && (
          <div className="loading-row">
            <Loader2 size={14} className="animate-spin" />
            读取会话…
          </div>
        )}
        {available.length > 0 && (
          <div className="inline-form" style={{ marginBottom: 18 }}>
            <select
              aria-label="选择会话"
              value={selected?.id ?? ''}
              style={{ fontSize: 10 }}
              onChange={(event) => {
                setSelectedId(event.target.value);
                setNewConversation(false);
                preview.reset();
              }}
            >
              {available.map((conversation) => (
                <option key={conversation.id} value={conversation.id}>
                  {conversation.model.modelId} ·{' '}
                  {new Date(conversation.createdAt).toLocaleString('zh-CN', {
                    month: '2-digit',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </option>
              ))}
            </select>
            <Button
              variant="ghost"
              size="icon"
              aria-label="创建独立会话"
              disabled={readOnly}
              onClick={() => setNewConversation(true)}
            >
              <Plus size={13} />
            </Button>
          </div>
        )}
        {showSetup ? (
          <>
            <EmptyState
              icon={<MessageSquare />}
              title={scope === 'node' ? '与这个节点一起思考' : '从想法开始对话'}
            >
              讨论需求、理解流程，或提出配置修改建议。
              <br />
              确认应用后，草稿才会改变。
            </EmptyState>
            {!readOnly && (
              <>
                <ModelSelector
                  capability="chat"
                  value={model}
                  onChange={setModel}
                  plugins={plugins}
                  connections={connections}
                />
                <Button
                  size="sm"
                  disabled={!modelSelectionSchema.safeParse(model).success || create.isPending}
                  onClick={() => create.mutate()}
                >
                  {create.isPending ? <Loader2 className="animate-spin" /> : <Sparkles />}创建会话
                </Button>
                {newConversation && (
                  <Button variant="ghost" size="sm" onClick={() => setNewConversation(false)}>
                    取消
                  </Button>
                )}
                {create.error && <ErrorNotice error={create.error} />}
              </>
            )}
            {readOnly && <p className="field-hint">查看者可阅读已有会话，创建对话需要编辑权限。</p>}
          </>
        ) : (
          <>
            <div style={{ marginBottom: 16 }}>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={
                  readOnly ||
                  summarize.isPending ||
                  send.isPending ||
                  (messages.data?.items.length ?? 0) < 8
                }
                onClick={() => summarize.mutate()}
              >
                {summarize.isPending ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <Sparkles size={13} />
                )}
                压缩会话记忆
              </Button>
              <p className="field-hint">
                使用本会话模型生成摘要，原文保留；至少 8 条新消息，最近 4 条保持完整。
              </p>
              {summaries.data?.items[0] && (
                <details className="context-preview">
                  <summary>
                    会话记忆 · 已覆盖 {summaries.data.items[0].messageIds.length} 条消息
                  </summary>
                  <div className="chat-message-content">{summaries.data.items[0].content}</div>
                </details>
              )}
              {summarize.error && <ErrorNotice error={summarize.error} />}
              {summaries.error && <ErrorNotice error={summaries.error} />}
            </div>
            {messages.error && <ErrorNotice error={messages.error} />}
            {messages.data?.items.length === 0 && (
              <EmptyState icon={<Bot />} title="会话已经就绪">
                该会话使用 {selected.model.modelId}。<br />
                聊天不会自动触发生成或运行。
              </EmptyState>
            )}
            {messages.data?.items.map((message) => (
              <article key={message.id} className={`chat-message ${message.role}`}>
                <div className="chat-message-role">
                  {message.role === 'user'
                    ? 'YOU'
                    : message.role === 'assistant'
                      ? 'ASSISTANT'
                      : message.role.toUpperCase()}
                  <span style={{ marginLeft: 'auto' }}>
                    {new Date(message.createdAt).toLocaleTimeString('zh-CN', {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                </div>
                <div className="chat-message-content">{message.content}</div>
              </article>
            ))}
            {send.isPending && (
              <div className="loading-row">
                <Loader2 size={14} className="animate-spin" />
                正在构建上下文并回复…
              </div>
            )}
            {proposals.data?.items.map((proposal) => (
              <ProposalCard
                key={proposal.id}
                proposal={proposal}
                readOnly={readOnly}
                onApplied={onApplied}
              />
            ))}
            {proposals.error && <ErrorNotice error={proposals.error} />}
          </>
        )}
        {preview.data && <ContextPreview bundle={preview.data} />}
        {preview.error && <ErrorNotice error={preview.error} />}
        {send.error && <ErrorNotice error={send.error} />}
      </div>
      {!showSetup && (
        <form
          className="chat-composer"
          onSubmit={(event) => {
            event.preventDefault();
            if (content.trim() && !readOnly && !send.isPending) send.mutate();
          }}
        >
          <textarea
            aria-label="对话内容"
            value={content}
            onChange={(event) => setContent(event.target.value)}
            maxLength={50_000}
            disabled={send.isPending}
            placeholder={
              scope === 'node'
                ? '描述这个节点的需求，或一起优化提示词…'
                : '描述你的想法，或询问工作流如何改进…'
            }
          />
          <div className="composer-actions">
            <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                title="选择上下文素材"
                aria-label="选择上下文素材"
                onClick={() => setShowAssets(!showAssets)}
              >
                <Paperclip size={13} />
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => preview.mutate()}
                disabled={!content.trim() || preview.isPending}
              >
                <ScanEye size={13} />
                上下文
              </Button>
            </div>
            <Button
              type="submit"
              size="icon"
              aria-label="发送消息"
              disabled={readOnly || !content.trim() || send.isPending}
            >
              <Send size={13} />
            </Button>
          </div>
          {runId && (
            <label className="check-field" style={{ margin: '5px 0', fontSize: 10 }}>
              <input
                type="checkbox"
                checked={includeRun}
                onChange={(event) => setIncludeRun(event.target.checked)}
              />
              引用当前选中运行状态
            </label>
          )}
          {showAssets && (
            <div style={{ maxHeight: 140, overflow: 'auto', padding: '5px 3px' }}>
              {assets.error && <ErrorNotice error={assets.error} />}
              {assets.data?.items.length === 0 && (
                <p className="field-hint">当前工作空间还没有素材。</p>
              )}
              {assets.data?.items.map((asset) => (
                <label
                  key={asset.versionId}
                  className="check-field"
                  style={{ fontSize: 10, margin: '7px 0' }}
                >
                  <input
                    type="checkbox"
                    checked={assetIds.includes(asset.versionId)}
                    onChange={(event) =>
                      setAssetIds(
                        event.target.checked
                          ? [...assetIds, asset.versionId].slice(0, 30)
                          : assetIds.filter((id) => id !== asset.versionId),
                      )
                    }
                  />
                  {asset.name ?? asset.assetId} · {asset.type}
                </label>
              ))}
            </div>
          )}
          <small>对话只提供建议 · 生成与运行需要明确操作</small>
        </form>
      )}
    </>
  );
}
