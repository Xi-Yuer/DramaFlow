'use client';

import { useCallback, useEffect, useState } from 'react';
import type {
  ExecutionTreeParentRef,
  ExecutionTreeQuery,
  ExecutionTreeResponse,
} from '@dramaflow/contracts';
import {
  acceptExecutionPage,
  appendExecutionItems,
  executionLayerKey,
  executionTreeQuery,
  type ExecutionLayerSnapshot,
} from './execution-browse';

export type ExecutionTreeLoad = (
  runId: string,
  query: ExecutionTreeQuery,
  signal?: AbortSignal,
) => Promise<ExecutionTreeResponse>;

interface LayerState extends ExecutionLayerSnapshot {
  key: string;
  phase: 'loading' | 'ready' | 'loading-more' | 'error';
  error: string | null;
}

interface LayerCache {
  scope: string;
  pages: ReadonlyMap<string, ExecutionLayerSnapshot>;
}

function failureMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : '执行过程读取失败';
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function parentRef(type: ExecutionTreeParentRef['type'], id: string): ExecutionTreeParentRef {
  if (type === 'workflow_run') return { type, id };
  if (type === 'node_run') return { type, id };
  return { type: 'child_execution', id };
}

function rememberPage(
  current: LayerCache,
  scope: string,
  key: string,
  page: ExecutionLayerSnapshot,
): LayerCache {
  if (current.scope !== scope) return current;
  const pages = new Map(current.pages);
  pages.set(key, page);
  return { scope: current.scope, pages };
}

export function useExecutionLayer({
  runId,
  parent,
  reloadKey,
  pageSize,
  load,
}: {
  runId: string;
  parent: ExecutionTreeParentRef;
  reloadKey: string;
  pageSize: number;
  load: ExecutionTreeLoad;
}) {
  const scope = `${runId}:${reloadKey}`;
  const parentType = parent.type;
  const parentId = parent.id;
  const key = executionLayerKey(runId, parent, reloadKey, pageSize);
  const [store, setStore] = useState<LayerCache>(() => ({ scope, pages: new Map() }));
  if (store.scope !== scope) setStore({ scope, pages: new Map() });
  const cached = store.scope === scope ? store.pages.get(key) : undefined;
  const [layer, setLayer] = useState<LayerState>({
    key: '',
    parent,
    items: [],
    nextCursor: null,
    phase: 'loading',
    error: null,
  });
  const view: LayerState =
    layer.key === key
      ? layer
      : cached
        ? {
            key,
            parent,
            items: cached.items,
            nextCursor: cached.nextCursor,
            phase: 'ready',
            error: null,
          }
        : { key, parent, items: [], nextCursor: null, phase: 'loading', error: null };

  useEffect(() => {
    const currentParent = parentRef(parentType, parentId);
    if (cached) {
      setLayer({
        key,
        parent: currentParent,
        items: cached.items,
        nextCursor: cached.nextCursor,
        phase: 'ready',
        error: null,
      });
      return;
    }
    let active = true;
    const controller = new AbortController();
    setLayer({
      key,
      parent: currentParent,
      items: [],
      nextCursor: null,
      phase: 'loading',
      error: null,
    });
    load(runId, executionTreeQuery(currentParent, { limit: pageSize }), controller.signal)
      .then((page) => {
        if (!active) return;
        const accepted = acceptExecutionPage({ runId, parent: currentParent }, page);
        if (!accepted) {
          setLayer({
            key,
            parent: currentParent,
            items: [],
            nextCursor: null,
            phase: 'error',
            error: '执行树响应与当前层不一致',
          });
          return;
        }
        setStore((current) => rememberPage(current, scope, key, accepted));
        setLayer({ key, ...accepted, phase: 'ready', error: null });
      })
      .catch((error: unknown) => {
        if (!active || isAbort(error)) return;
        setLayer({
          key,
          parent: currentParent,
          items: [],
          nextCursor: null,
          phase: 'error',
          error: failureMessage(error),
        });
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [cached, key, load, pageSize, parentId, parentType, runId, scope]);

  const remember = useCallback(
    (nextParent: ExecutionTreeParentRef, page: ExecutionLayerSnapshot) => {
      setStore((current) =>
        rememberPage(
          current,
          scope,
          executionLayerKey(runId, nextParent, reloadKey, pageSize),
          page,
        ),
      );
    },
    [pageSize, reloadKey, runId, scope],
  );

  const loadMore = useCallback(async () => {
    if (!cached?.nextCursor) return;
    const currentParent = parentRef(parentType, parentId);
    const requestKey = key;
    const cursor = cached.nextCursor;
    const currentItems = cached.items;
    setLayer((existing) =>
      existing.key === requestKey ? { ...existing, phase: 'loading-more', error: null } : existing,
    );
    try {
      const page = await load(
        runId,
        executionTreeQuery(currentParent, { limit: pageSize, after: cursor }),
      );
      const accepted = acceptExecutionPage({ runId, parent: currentParent }, page);
      if (!accepted) {
        setLayer((existing) =>
          existing.key === requestKey
            ? {
                key: requestKey,
                parent: currentParent,
                items: currentItems,
                nextCursor: cursor,
                phase: 'error',
                error: '执行树响应与当前层不一致',
              }
            : existing,
        );
        return;
      }
      const snapshot: ExecutionLayerSnapshot = {
        parent: currentParent,
        items: appendExecutionItems(currentItems, accepted),
        nextCursor: accepted.nextCursor,
      };
      setStore((current) => rememberPage(current, scope, requestKey, snapshot));
      setLayer((existing) =>
        existing.key === requestKey
          ? { key: requestKey, ...snapshot, phase: 'ready', error: null }
          : existing,
      );
    } catch (error) {
      if (isAbort(error)) return;
      setLayer((existing) =>
        existing.key === requestKey
          ? {
              key: requestKey,
              parent: currentParent,
              items: currentItems,
              nextCursor: cursor,
              phase: 'ready',
              error: failureMessage(error),
            }
          : existing,
      );
    }
  }, [cached, key, load, pageSize, parentId, parentType, runId, scope]);

  return {
    items: view.items,
    nextCursor: view.nextCursor,
    phase: view.phase,
    error: view.error,
    loadMore,
    remember,
  };
}
