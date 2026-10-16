'use client';

import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock3, Loader2, Square, X } from 'lucide-react';
import type { WorkflowRun } from '@dramaflow/contracts';
import { api, queryKeys } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { EmptyState, ErrorNotice } from '@/components/ui/form-field';
import { HumanTaskCard } from './human-task-card';
import { cn } from '@/lib/utils';

export const statusLabel = {
  queued: '排队中',
  running: '运行中',
  waiting: '等待确认',
  succeeded: '已完成',
  failed: '执行失败',
  canceled: '已取消',
};
export function useRun(runId: string | null) {
  return useQuery({
    queryKey: queryKeys.run(runId ?? ''),
    queryFn: () => api.run(runId!),
    enabled: !!runId,
    refetchInterval: (query) =>
      query.state.data && ['queued', 'running', 'waiting'].includes(query.state.data.status)
        ? 2000
        : false,
  });
}

export function RunPanel({
  workflowId,
  runId,
  onSelect,
  onClose,
  readOnly,
}: {
  workflowId: string;
  runId: string | null;
  onSelect: (id: string) => void;
  onClose: () => void;
  readOnly: boolean;
}) {
  const client = useQueryClient();
  const runs = useQuery({
    queryKey: queryKeys.runs(workflowId),
    queryFn: () => api.runs(workflowId),
    refetchInterval: 5000,
  });
  const effectiveId = runId ?? runs.data?.items[0]?.id;
  useEffect(() => {
    if (!runId && effectiveId) onSelect(effectiveId);
  }, [runId, effectiveId, onSelect]);
  const run = useRun(effectiveId ?? null);
  const active = run.data && ['queued', 'running', 'waiting'].includes(run.data.status);
  const events = useQuery({
    queryKey: queryKeys.events(effectiveId ?? ''),
    queryFn: () => api.events(effectiveId!),
    enabled: !!effectiveId,
    refetchInterval: active ? 2000 : false,
  });
  const tasks = useQuery({
    queryKey: queryKeys.tasks(effectiveId ?? ''),
    queryFn: () => api.tasks(effectiveId!),
    enabled: !!effectiveId,
    refetchInterval: active ? 2000 : false,
  });
  const cancel = useMutation({
    mutationFn: () => api.cancel(effectiveId!),
    onSuccess: (data: WorkflowRun) => {
      client.setQueryData(queryKeys.run(data.id), data);
      void client.invalidateQueries({ queryKey: queryKeys.runs(workflowId) });
    },
  });
  useEffect(() => {
    if (!effectiveId || !active) return;
    const stream = new EventSource(`/api/v1/runs/${encodeURIComponent(effectiveId)}/stream`);
    const update = () => {
      void client.invalidateQueries({ queryKey: queryKeys.events(effectiveId) });
      void client.invalidateQueries({ queryKey: queryKeys.run(effectiveId) });
      void client.invalidateQueries({ queryKey: queryKeys.tasks(effectiveId) });
    };
    stream.onmessage = update;
    stream.addEventListener('run-event', update);
    return () => stream.close();
  }, [effectiveId, active, client]);
  return (
    <section className="run-drawer" aria-label="运行记录">
      <div className="panel-toolbar">
        <h2>
          运行记录{' '}
          <small style={{ marginLeft: 10 }}>
            {run.data ? statusLabel[run.data.status] : 'EXECUTION LOG'}
          </small>
        </h2>
        <div style={{ display: 'flex', gap: 6 }}>
          {active && (
            <Button
              variant="ghost"
              size="sm"
              disabled={readOnly || cancel.isPending}
              onClick={() => cancel.mutate()}
            >
              <Square size={12} />
              取消运行
            </Button>
          )}
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="收起运行记录">
            <X size={14} />
          </Button>
        </div>
      </div>
      <div className="run-body">
        <div className="run-list">
          {runs.data?.items.map((item) => (
            <button
              key={item.id}
              type="button"
              className={item.id === effectiveId ? 'active' : ''}
              onClick={() => onSelect(item.id)}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                <span className={cn('badge', item.status)}>{statusLabel[item.status]}</span>
              </div>
              <span
                style={{
                  display: 'block',
                  marginTop: 6,
                  fontSize: 9,
                  color: '#6b8d78',
                  fontFamily: 'var(--font-mono)',
                }}
              >
                {new Date(item.createdAt).toLocaleString('zh-CN', {
                  month: '2-digit',
                  day: '2-digit',
                  hour: '2-digit',
                  minute: '2-digit',
                })}{' '}
                · {item.id.slice(0, 7)}
              </span>
            </button>
          ))}
        </div>
        <div className="run-events">
          {[runs.error, run.error, events.error, tasks.error, cancel.error]
            .filter(Boolean)
            .map((error, index) => (
              <ErrorNotice key={index} error={error} />
            ))}
          {runs.isPending && (
            <div className="loading-row">
              <Loader2 className="animate-spin" size={14} />
              加载运行记录…
            </div>
          )}
          {runs.data?.items.length === 0 && (
            <EmptyState icon={<Clock3 />} title="还没有运行记录">
              发布工作流后，点击运行来启动一次执行。
            </EmptyState>
          )}
          {run.data?.error && (
            <ErrorNotice error={new Error(`${run.data.error.code}: ${run.data.error.message}`)} />
          )}
          {tasks.data?.items
            .filter((task) => task.status === 'pending')
            .map((task) => (
              <HumanTaskCard key={task.id} task={task} readOnly={readOnly} />
            ))}
          {events.data?.items.map((event) => (
            <div key={event.id} className="run-event">
              <time>
                {new Date(event.createdAt).toLocaleTimeString('zh-CN', { hour12: false })}
              </time>
              <strong>{event.type}</strong>
              <span>
                {event.nodeId ? `${event.nodeId} · ` : ''}
                {JSON.stringify(event.data)}
              </span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
