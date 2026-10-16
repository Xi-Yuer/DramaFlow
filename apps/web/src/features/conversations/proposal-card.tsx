'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, FileDiff, Loader2 } from 'lucide-react';
import type { WorkflowChangeProposal, WorkflowDraft } from '@dramaflow/contracts';
import { api, queryKeys } from '@/lib/api';
import { useEditorStore, isEditorDirty } from '@/features/editor/editor-store';
import { Button } from '@/components/ui/button';
import { ErrorNotice } from '@/components/ui/form-field';

export function ProposalCard({
  proposal,
  readOnly,
  onApplied,
}: {
  proposal: WorkflowChangeProposal;
  readOnly: boolean;
  onApplied: (draft: WorkflowDraft) => void;
}) {
  const state = useEditorStore();
  const client = useQueryClient();
  const dirty = isEditorDirty(state);
  const conflict = proposal.baseRevision !== state.revision;
  const apply = useMutation({
    mutationFn: () => api.applyProposal(proposal.id, proposal.baseRevision),
    onSuccess: async (draft) => {
      onApplied(draft);
      client.setQueryData(queryKeys.workflow(draft.id), draft);
      await client.invalidateQueries({ queryKey: queryKeys.proposals(proposal.conversationId) });
    },
  });
  return (
    <div className="suggestion-card">
      <h4>
        <FileDiff size={13} style={{ display: 'inline', marginRight: 6 }} />
        {proposal.title}
      </h4>
      <p style={{ color: '#9eb08c', fontSize: 11, lineHeight: 1.7 }}>{proposal.explanation}</p>
      <span className="field-hint">
        基于工作流 r{proposal.baseRevision} · {proposal.changes.length} 项变更
      </span>
      <details style={{ margin: '11px 0', fontSize: 10 }}>
        <summary>审核配置变更</summary>
        <pre>
          {proposal.changes
            .map((change) => {
              const node = state.definition.nodes.find((entry) => entry.id === change.nodeId);
              const before =
                change.kind === 'updateNodeConfig'
                  ? node?.config
                  : change.kind === 'renameNode'
                    ? node?.title
                    : change.kind === 'removeNode'
                      ? node
                      : change.kind === 'removeControlEdge' || change.kind === 'addControlEdge'
                        ? state.definition.controlEdges
                        : change.kind === 'setBinding' || change.kind === 'removeBinding'
                          ? state.definition.bindings.filter(
                              (binding) => binding.nodeId === change.nodeId,
                            )
                          : null;
              return `${change.kind}${node ? ` · ${node.title}` : ''}\n− ${JSON.stringify(before, null, 2)}\n+ ${JSON.stringify(change.value, null, 2)}`;
            })
            .join('\n\n')}
        </pre>
      </details>
      {apply.error && <ErrorNotice error={apply.error} />}
      {proposal.status === 'pending' ? (
        <>
          <Button
            size="sm"
            onClick={() => apply.mutate()}
            disabled={readOnly || dirty || conflict || apply.isPending}
          >
            {apply.isPending ? <Loader2 className="animate-spin" /> : <Check />}确认应用到草稿
          </Button>
          {dirty && (
            <p className="field-hint" style={{ marginTop: 8 }}>
              请先保存或放弃本地修改，再应用建议。
            </p>
          )}
          {conflict && (
            <p className="field-error" style={{ marginTop: 8 }}>
              基础版本已改变，请在当前版本重新提出建议。
            </p>
          )}
        </>
      ) : (
        <span className="badge">{proposal.status === 'applied' ? '已应用到草稿' : '已拒绝'}</span>
      )}
    </div>
  );
}
