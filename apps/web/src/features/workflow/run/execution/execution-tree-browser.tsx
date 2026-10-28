'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Breadcrumb, Button, Tag, Typography } from 'antd';
import type { ExecutionTreeEntry, NodeRunStatus, WorkflowDefinition } from '@dramaflow/contracts';
import { getRuntimeNodePresentation } from '../../runtime/presentation/runtime-presentation';
import { workflowApi } from '../../workflow-api';
import {
  acceptExecutionPage,
  childExecutionLabel,
  definitionNodeLabel,
  enterExecution,
  executionTreeQuery,
  exitExecution,
  focusExecution,
  indexDefinitionNodeNames,
  nodeRunBreadcrumbLabel,
  projectExecutionNodeRuns,
  rootBrowseFrame,
  type ExecutionBrowseFrame,
} from './execution-browse';
import { useExecutionLayer, type ExecutionTreeLoad } from './use-execution-layer';
import styles from './execution-tree-browser.module.css';

type NodeProbe = 'absent' | 'present';

interface BrowserSession {
  runId: string;
  reloadKey: string;
  path: readonly ExecutionBrowseFrame[];
  probes: Readonly<Record<string, NodeProbe>>;
  rowError: string | null;
}

function nodeRunActionLabel(name: string, attempt: number, mode: 'check' | 'enter'): string {
  const who = attempt > 1 ? `${name}第 ${attempt} 次` : name;
  return mode === 'enter' ? `进入${who}的子执行` : `查看${who}是否有子执行`;
}

function ExecutionStatus({ status }: { status: NodeRunStatus }) {
  const presentation = getRuntimeNodePresentation(status);
  return <Tag color={presentation.tagColor}>{presentation.label}</Tag>;
}

export function ExecutionTreeBrowser({
  runId,
  definition = null,
  reloadToken = 0,
  pageSize = 50,
  load = workflowApi.getExecutionTree,
}: {
  runId: string;
  definition?: Pick<WorkflowDefinition, 'nodes'> | null;
  reloadToken?: number;
  pageSize?: number;
  load?: ExecutionTreeLoad;
}) {
  const size = Math.min(100, Math.max(1, pageSize));
  const [retry, setRetry] = useState(0);
  const reloadKey = `${reloadToken}:${retry}`;
  const [session, setSession] = useState<BrowserSession>(() => ({
    runId,
    reloadKey,
    path: [rootBrowseFrame(runId)],
    probes: {},
    rowError: null,
  }));
  const [pendingId, setPendingId] = useState<string | null>(null);
  const path = session.runId === runId ? session.path : [rootBrowseFrame(runId)];
  const probes = session.runId === runId && session.reloadKey === reloadKey ? session.probes : {};
  const rowError =
    session.runId === runId && session.reloadKey === reloadKey ? session.rowError : null;
  if (session.runId !== runId || session.reloadKey !== reloadKey) {
    setSession({ runId, reloadKey, path, probes, rowError: null });
    if (pendingId !== null) setPendingId(null);
  }
  const frame = path.at(-1) ?? rootBrowseFrame(runId);
  const names = useMemo(() => indexDefinitionNodeNames(definition), [definition]);
  const layer = useExecutionLayer({ runId, parent: frame.parent, reloadKey, pageSize: size, load });
  const projections = useMemo(() => projectExecutionNodeRuns(layer.items), [layer.items]);
  const projectionById = useMemo(
    () => new Map(projections.map((item) => [item.id, item])),
    [projections],
  );
  const serial = useRef(0);
  const inspectController = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = inspectController;
    const requestSerial = serial;
    return () => {
      requestSerial.current += 1;
      controller.current?.abort();
    };
  }, [reloadKey, runId]);

  function sessionStillCurrent(existing: BrowserSession) {
    return existing.runId === runId && existing.reloadKey === reloadKey;
  }

  function commitPath(next: readonly ExecutionBrowseFrame[]) {
    serial.current += 1;
    inspectController.current?.abort();
    setPendingId(null);
    setSession((current) => ({ ...current, runId, reloadKey, path: next, rowError: null }));
  }

  async function openNodeRun(
    entry: Extract<ExecutionTreeEntry, { type: 'node_run' }>,
    name: string,
  ) {
    if (probes[entry.id] === 'absent' || (pendingId !== null && pendingId !== entry.id)) return;
    const label = nodeRunBreadcrumbLabel(name, entry.attempt);
    if (probes[entry.id] !== 'present') {
      const current = ++serial.current;
      inspectController.current?.abort();
      const controller = new AbortController();
      inspectController.current = controller;
      setPendingId(entry.id);
      try {
        const parent = { type: 'node_run' as const, id: entry.id };
        const page = await load(
          runId,
          executionTreeQuery(parent, { limit: size }),
          controller.signal,
        );
        if (current !== serial.current || controller.signal.aborted) return;
        const accepted = acceptExecutionPage({ runId, parent }, page);
        if (!accepted) {
          setSession((existing) =>
            sessionStillCurrent(existing)
              ? { ...existing, rowError: '执行树响应与当前层不一致' }
              : existing,
          );
          return;
        }
        if (accepted.items.length === 0 && accepted.nextCursor === null) {
          setSession((existing) =>
            sessionStillCurrent(existing)
              ? {
                  ...existing,
                  probes: { ...existing.probes, [entry.id]: 'absent' },
                  rowError: null,
                }
              : existing,
          );
          return;
        }
        layer.remember(parent, accepted);
        setSession((existing) => {
          if (!sessionStillCurrent(existing)) return existing;
          const next = enterExecution(existing.path, entry, label);
          return {
            ...existing,
            probes: { ...existing.probes, [entry.id]: 'present' },
            path: next ?? existing.path,
            rowError: null,
          };
        });
      } catch (error) {
        if (current !== serial.current || controller.signal.aborted) return;
        setSession((existing) =>
          sessionStillCurrent(existing)
            ? {
                ...existing,
                rowError: error instanceof Error ? error.message : '子执行读取失败',
              }
            : existing,
        );
      } finally {
        if (current === serial.current) setPendingId(null);
      }
      return;
    }
    const next = enterExecution(path, entry, label);
    if (next) commitPath(next);
  }

  function openChild(entry: Extract<ExecutionTreeEntry, { type: 'child_execution' }>) {
    const next = enterExecution(path, entry, childExecutionLabel(entry));
    if (next) commitPath(next);
  }

  const statusLabel = (status: NodeRunStatus) => getRuntimeNodePresentation(status).label;

  return (
    <section className={styles.section} aria-label="执行过程" aria-busy={layer.phase === 'loading'}>
      <Typography.Text strong>执行过程</Typography.Text>
      <div className={styles.pathRow}>
        <Breadcrumb
          className={styles.crumbs}
          aria-label="执行路径"
          separator="/"
          itemRender={(item) => item.title}
          items={path.map((item, index) => ({
            key: `${index}:${item.parent.type}:${item.parent.id}`,
            title:
              index === path.length - 1 ? (
                <span aria-current="page">{item.label}</span>
              ) : (
                <Button
                  type="link"
                  size="small"
                  className={styles.crumb}
                  onClick={() => commitPath(focusExecution(path, index))}
                >
                  {item.label}
                </Button>
              ),
          }))}
        />
        {path.length > 1 ? (
          <Button size="small" onClick={() => commitPath(exitExecution(path))}>
            返回上一级
          </Button>
        ) : null}
      </div>
      {rowError ? (
        <Alert showIcon type="error" title="子执行读取失败" description={rowError} />
      ) : null}
      {layer.error ? (
        <Alert
          showIcon
          type="error"
          title="执行过程读取失败"
          description={layer.error}
          action={
            <Button size="small" onClick={() => setRetry((value) => value + 1)}>
              重新读取
            </Button>
          }
        />
      ) : null}
      {layer.phase === 'loading' ? (
        <Typography.Text className={styles.secondary}>正在读取执行过程…</Typography.Text>
      ) : null}
      {layer.phase === 'ready' && layer.items.length === 0 ? (
        <Typography.Text className={styles.secondary}>
          {frame.parent.type === 'node_run' ? '没有子执行' : '这一层还没有节点运行'}
        </Typography.Text>
      ) : null}
      {layer.phase !== 'loading' && layer.items.length > 0 ? (
        <ul className={styles.list} aria-label="当前执行层">
          {layer.items.map((item) => {
            if (item.type === 'node_run') {
              const projected = projectionById.get(item.id);
              if (!projected) return null;
              const name = definitionNodeLabel(names, projected.nodeId);
              const probe = probes[projected.id];
              const failure = projected.status === 'failed' ? projected.error : undefined;
              return (
                <li
                  key={`node_run:${projected.id}`}
                  className={styles.item}
                  aria-label={`${name} 第 ${projected.attempt} 次 ${statusLabel(projected.status)}`}
                >
                  <div className={styles.row}>
                    <div className={styles.identity}>
                      <strong className={styles.name}>{name}</strong>
                      <span className={styles.attempt}>第 {projected.attempt} 次</span>
                    </div>
                    <div className={styles.actions}>
                      <ExecutionStatus status={projected.status} />
                      {probe === 'absent' ? (
                        <span className={styles.absent}>无子执行</span>
                      ) : (
                        <Button
                          type="link"
                          size="small"
                          loading={pendingId === projected.id}
                          disabled={pendingId !== null && pendingId !== projected.id}
                          aria-label={nodeRunActionLabel(
                            name,
                            projected.attempt,
                            probe === 'present' ? 'enter' : 'check',
                          )}
                          onClick={() => void openNodeRun(item, name)}
                        >
                          {probe === 'present' ? '进入子执行' : '查看子执行'}
                        </Button>
                      )}
                    </div>
                  </div>
                  {failure ? (
                    <div className={styles.failure}>
                      <Typography.Text type="danger">{failure.message}</Typography.Text>
                      <Typography.Text type="secondary">
                        阶段：{failure.stage}
                        {failure.code ? ` · ${failure.code}` : ''}
                      </Typography.Text>
                    </div>
                  ) : null}
                </li>
              );
            }
            const label = childExecutionLabel(item);
            const failure = item.status === 'failed' ? item.error : undefined;
            return (
              <li
                key={`child_execution:${item.id}`}
                className={styles.item}
                aria-label={`${label} ${statusLabel(item.status)}`}
              >
                <div className={styles.row}>
                  <strong className={styles.name}>{label}</strong>
                  <div className={styles.actions}>
                    <ExecutionStatus status={item.status} />
                    <Button
                      type="link"
                      size="small"
                      disabled={pendingId !== null}
                      aria-label={`进入 ${label}`}
                      onClick={() => openChild(item)}
                    >
                      进入
                    </Button>
                  </div>
                </div>
                {failure ? (
                  <div className={styles.failure}>
                    <Typography.Text type="danger">{failure.message}</Typography.Text>
                    <Typography.Text type="secondary">
                      阶段：{failure.stage}
                      {failure.code ? ` · ${failure.code}` : ''}
                    </Typography.Text>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {layer.nextCursor && layer.phase !== 'loading' && layer.phase !== 'error' ? (
        <Button
          size="small"
          loading={layer.phase === 'loading-more'}
          onClick={() => void layer.loadMore()}
        >
          加载更多
        </Button>
      ) : null}
    </section>
  );
}
