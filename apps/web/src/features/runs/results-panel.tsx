'use client';

import { ArrowDownToLine, RefreshCcw } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { NodeDefinition, WorkflowRun } from '@dramaflow/contracts';
import { api, queryKeys } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { EmptyState, ErrorNotice } from '@/components/ui/form-field';
import { AssetPreview } from './asset-preview';

export function ResultsPanel({
  run,
  nodeId,
  catalog,
  nodeType,
  readOnly,
  onRegenerated,
}: {
  run?: WorkflowRun;
  nodeId: string | null;
  catalog: NodeDefinition[];
  nodeType?: string;
  readOnly: boolean;
  onRegenerated: (run: WorkflowRun) => void;
}) {
  const client = useQueryClient();
  const regenerate = useMutation({
    mutationFn: (continueDownstream: boolean) =>
      api.regenerate(run!.id, nodeId!, continueDownstream),
    onSuccess: (next) => {
      client.setQueryData(queryKeys.run(next.id), next);
      void client.invalidateQueries({ queryKey: queryKeys.runs(next.workflowId) });
      onRegenerated(next);
    },
  });
  const selected = nodeId && run?.nodeResults[nodeId];
  const definition = catalog.find((entry) => entry.type === nodeType);
  const canRegenerate =
    !!selected &&
    definition?.actions.regenerate &&
    !!run &&
    ['succeeded', 'failed', 'canceled', 'waiting'].includes(run.status);
  return (
    <div className="panel-scroll" style={{ padding: 16 }}>
      {!run ? (
        <EmptyState icon={<ArrowDownToLine />} title="等待第一份成果">
          运行完成的节点会在这里展示真实产物。可以从运行记录选择历史执行。
        </EmptyState>
      ) : (
        <>
          {run.invalidatedNodeIds.length > 0 && (
            <p className="config-section-note">
              {run.invalidatedNodeIds.length} 个下游节点待重新计算。
            </p>
          )}
          {selected && (
            <>
              <h3 style={{ fontSize: 12, marginBottom: 12 }}>当前节点 · {selected.status}</h3>
              {Object.entries(selected.outputs).map(([key, value]) => (
                <div key={key} style={{ marginBottom: 12 }}>
                  <AssetPreview value={value} label={key} />
                </div>
              ))}
              {selected.error && <ErrorNotice error={new Error(selected.error.message)} />}
              {canRegenerate && (
                <div style={{ margin: '15px 0 23px', display: 'flex', flexWrap: 'wrap', gap: 7 }}>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={readOnly || regenerate.isPending}
                    onClick={() => regenerate.mutate(false)}
                  >
                    <RefreshCcw />
                    仅重新生成
                  </Button>
                  <Button
                    size="sm"
                    disabled={readOnly || regenerate.isPending}
                    onClick={() => regenerate.mutate(true)}
                  >
                    重新生成并继续下游
                  </Button>
                  <p className="field-hint">创建新运行与新产物版本；历史结果保留。</p>
                </div>
              )}
              {regenerate.error && <ErrorNotice error={regenerate.error} />}
            </>
          )}
          <h3 style={{ fontSize: 12, color: '#92ad96', margin: '20px 0 13px' }}>
            结果收集 · {Object.keys(run.outputCollections).length} 组
          </h3>
          {Object.entries(run.outputCollections).map(([id, outputs]) => (
            <div key={id} style={{ paddingBottom: 16 }}>
              <h4 style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: '#6a8c74' }}>
                {id}
              </h4>
              {Object.entries(outputs).map(([key, value]) => (
                <div key={key} style={{ marginTop: 10 }}>
                  <AssetPreview value={value} label={key} />
                </div>
              ))}
            </div>
          ))}
          {Object.keys(run.outputCollections).length === 0 && (
            <p className="field-hint">当前运行尚未产生收集结果。</p>
          )}
        </>
      )}
    </div>
  );
}
