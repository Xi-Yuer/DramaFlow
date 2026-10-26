// @vitest-environment happy-dom
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App, ConfigProvider } from 'antd';
import type {
  ExecutionTreeEntry,
  ExecutionTreeQuery,
  WorkflowDefinition,
} from '@dramaflow/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  acceptExecutionPage,
  appendExecutionItems,
  childExecutionLabel,
  definitionNodeLabel,
  enterExecution,
  executionTreeQuery,
  exitExecution,
  focusExecution,
  indexDefinitionNodeNames,
  projectExecutionNodeRuns,
  rootBrowseFrame,
} from '../src/features/workflow/run/execution/execution-browse';
import { ExecutionTreeBrowser } from '../src/features/workflow/run/execution/execution-tree-browser';
import type { ExecutionTreeLoad } from '../src/features/workflow/run/execution/use-execution-layer';
import { workflowApi } from '../src/features/workflow/workflow-api';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const STARTED = '2026-10-26T01:00:00.000Z';
const definition = {
  nodes: [
    {
      id: 'iterate-node',
      name: '逐项处理',
      type: 'flow.iteration',
      typeVersion: 1,
      inputs: {},
      config: {},
      ui: { position: { x: 0, y: 0 } },
      composite: {
        kind: 'iteration',
        itemType: { kind: 'primitive', name: 'string' },
        invariantInputs: [],
        bodyInputMapping: [],
        body: {
          inputs: [],
          outputs: [],
          edges: [],
          nodes: [
            {
              id: 'format',
              name: '文本格式化',
              type: 'action.format',
              typeVersion: 1,
              inputs: {},
              config: {},
              ui: { position: { x: 0, y: 0 } },
            },
            {
              id: 'script',
              name: '生成剧本',
              type: 'action.script',
              typeVersion: 1,
              inputs: {},
              config: {},
              ui: { position: { x: 0, y: 0 } },
            },
            {
              id: 'image',
              name: '生成图片',
              type: 'action.image',
              typeVersion: 1,
              inputs: {},
              config: {},
              ui: { position: { x: 0, y: 0 } },
            },
            {
              id: 'inner',
              name: '内层循环',
              type: 'flow.iteration',
              typeVersion: 1,
              inputs: {},
              config: {},
              ui: { position: { x: 0, y: 0 } },
              composite: {
                kind: 'iteration',
                itemType: { kind: 'primitive', name: 'string' },
                invariantInputs: [],
                bodyInputMapping: [],
                body: {
                  inputs: [],
                  outputs: [],
                  edges: [],
                  nodes: [
                    {
                      id: 'leaf',
                      name: '内层步骤',
                      type: 'action.leaf',
                      typeVersion: 1,
                      inputs: {},
                      config: {},
                      ui: { position: { x: 0, y: 0 } },
                    },
                  ],
                },
              },
            },
          ],
        },
      },
    },
    {
      id: 'plain',
      name: '普通节点',
      type: 'action.plain',
      typeVersion: 1,
      inputs: {},
      config: {},
      ui: { position: { x: 0, y: 0 } },
    },
    {
      id: 'failed',
      name: '失败节点',
      type: 'action.failed',
      typeVersion: 1,
      inputs: {},
      config: {},
      ui: { position: { x: 0, y: 0 } },
    },
  ],
} as Pick<WorkflowDefinition, 'nodes'>;

function treeRun(id = 'run-1') {
  return {
    type: 'workflow_run' as const,
    id,
    workflowId: 'workflow-1',
    workflowVersionId: 'version-1',
    status: 'running' as const,
    createdAt: STARTED,
    startedAt: STARTED,
  };
}

function nodeRun(input: {
  id: string;
  nodeId: string;
  parent: Extract<ExecutionTreeEntry, { type: 'node_run' }>['parent'];
  status: 'running' | 'completed' | 'failed';
  attempt?: number;
  occurrenceId?: string;
  error?: { stage: string; code?: string; message: string };
}): Extract<ExecutionTreeEntry, { type: 'node_run' }> {
  return {
    type: 'node_run',
    id: input.id,
    nodeId: input.nodeId,
    occurrenceId: input.occurrenceId ?? `occurrence-${input.id}`,
    parent: input.parent,
    attempt: input.attempt ?? 1,
    status: input.status,
    startedAt: STARTED,
    ...(input.status !== 'running' ? { completedAt: '2026-10-26T01:00:02.000Z' } : {}),
    ...(input.error ? { error: input.error } : {}),
  };
}

function childExecution(input: {
  id: string;
  parentId: string;
  status: 'running' | 'completed' | 'failed';
  index?: number;
  kind?: string;
  note?: string;
  error?: { stage: string; code?: string; message: string };
}): Extract<ExecutionTreeEntry, { type: 'child_execution' }> {
  return {
    type: 'child_execution',
    id: input.id,
    kind: input.kind ?? 'iteration_item',
    parent: { type: 'node_run', id: input.parentId },
    status: input.status,
    createdAt: STARTED,
    startedAt: STARTED,
    ...(input.status !== 'running' ? { completedAt: '2026-10-26T01:00:03.000Z' } : {}),
    ...(input.index !== undefined || input.note
      ? {
          metadata: {
            ...(input.index !== undefined ? { index: input.index } : {}),
            ...(input.note ? { note: input.note } : {}),
          },
        }
      : {}),
    ...(input.error ? { error: input.error } : {}),
  };
}

function page(
  runId: string,
  parent: { type: 'workflow_run' | 'node_run' | 'child_execution'; id: string },
  items: ExecutionTreeEntry[],
  nextCursor: string | null = null,
) {
  return { run: treeRun(runId), parent, items, nextCursor };
}

function ui(
  props: Partial<{
    runId: string;
    reloadToken: number;
    pageSize: number;
    definition: Pick<WorkflowDefinition, 'nodes'> | null;
    load: ExecutionTreeLoad;
  }>,
) {
  return (
    <ConfigProvider theme={{ token: { motion: false } }}>
      <App>
        <ExecutionTreeBrowser
          runId={props.runId ?? 'run-1'}
          definition={props.definition === undefined ? definition : props.definition}
          reloadToken={props.reloadToken}
          pageSize={props.pageSize}
          load={
            props.load ?? (async () => page('run-1', { type: 'workflow_run', id: 'run-1' }, []))
          }
        />
      </App>
    </ConfigProvider>
  );
}

function pathText() {
  return screen.getByRole('navigation', { name: '执行路径' }).textContent ?? '';
}

function layerLabels() {
  return within(screen.getByRole('list', { name: '当前执行层' }))
    .getAllByRole('listitem')
    .map((item) => item.getAttribute('aria-label'));
}

describe('执行浏览模型', () => {
  it('按显式 parent 进入、返回和投影，index 只用于显示', () => {
    const root = rootBrowseFrame('run-1');
    const rootParent = { type: 'workflow_run' as const, id: 'run-1' };
    const node = nodeRun({
      id: 'nr-loop',
      nodeId: 'iterate-node',
      parent: rootParent,
      status: 'completed',
    });
    const child = childExecution({
      id: 'ce-2',
      parentId: 'nr-loop',
      status: 'failed',
      index: 2,
      note: 'do-not-parse-scope-alpha',
    });
    const entered = enterExecution([root], node, '逐项处理');
    const nested = entered && enterExecution(entered, child, childExecutionLabel(child));
    expect(nested?.map((frame) => frame.parent)).toEqual([
      { type: 'workflow_run', id: 'run-1' },
      { type: 'node_run', id: 'nr-loop' },
      { type: 'child_execution', id: 'ce-2' },
    ]);
    expect(exitExecution(nested ?? []).at(-1)?.parent).toEqual({ type: 'node_run', id: 'nr-loop' });
    expect(focusExecution(nested ?? [], 0)).toEqual([root]);
    expect(
      enterExecution([root], { ...child, parent: { type: 'node_run', id: 'other' } }, '#2'),
    ).toBeNull();
    expect(childExecutionLabel({ metadata: { index: 0 } })).toBe('#0');
    expect(
      childExecutionLabel({ metadata: { index: '2', note: 'do-not-parse-scope-alpha' } }),
    ).toBe('子执行');
    expect(childExecutionLabel({ metadata: { index: -1 } })).toBe('子执行');
    expect(childExecutionLabel({ metadata: { index: 1.5 } })).toBe('子执行');
    expect(childExecutionLabel({})).toBe('子执行');
    const names = indexDefinitionNodeNames(definition);
    expect(definitionNodeLabel(names, 'leaf')).toBe('内层步骤');
    expect(
      definitionNodeLabel(
        indexDefinitionNodeNames({
          nodes: [
            {
              id: 'same',
              name: '甲',
              composite: { body: { nodes: [{ id: 'same', name: '乙' }] } },
            },
          ],
        } as Pick<WorkflowDefinition, 'nodes'>),
        'same',
      ),
    ).toBe('节点');
    const projected = projectExecutionNodeRuns([node, child]);
    expect(projected).toEqual([
      expect.objectContaining({
        type: 'node_run',
        id: 'nr-loop',
        nodeId: 'iterate-node',
        parent: root.parent,
      }),
    ]);
    expect(JSON.stringify(projected)).not.toContain('do-not-parse-scope-alpha');
    const first = acceptExecutionPage(
      { runId: 'run-1', parent: root.parent },
      page('run-1', root.parent, [node]),
    );
    expect(first?.items).toHaveLength(1);
    expect(
      acceptExecutionPage(
        { runId: 'run-1', parent: root.parent },
        page('run-1', root.parent, [{ ...node, parent: { type: 'child_execution', id: 'ce-2' } }]),
      ),
    ).toBeNull();
    expect(
      appendExecutionItems(first?.items ?? [], { items: [node, child] }).map((item) => item.id),
    ).toEqual(['nr-loop', 'ce-2']);
    expect(executionTreeQuery({ type: 'workflow_run', id: 'run-1' })).toEqual({
      parentType: 'workflow_run',
      parentId: 'run-1',
      limit: 50,
    });
  });
});

describe('Execution Tree 只读浏览', () => {
  const root = { type: 'workflow_run' as const, id: 'run-1' };

  it('显示 root 层的普通 NodeRun、attempt 与 running / completed / failed', async () => {
    const load: ExecutionTreeLoad = async () =>
      page('run-1', root, [
        nodeRun({ id: 'nr-format-1', nodeId: 'format', parent: root, status: 'completed' }),
        nodeRun({
          id: 'nr-format-2',
          nodeId: 'format',
          parent: root,
          status: 'running',
          attempt: 2,
        }),
        nodeRun({ id: 'nr-plain', nodeId: 'plain', parent: root, status: 'completed' }),
        nodeRun({
          id: 'nr-failed',
          nodeId: 'failed',
          parent: root,
          status: 'failed',
          occurrenceId: 'occurrence-failed',
          error: { stage: 'invoke', code: 'NODE_FAILED', message: '安全失败摘要' },
        }),
      ]);
    render(ui({ load }));
    expect(
      await screen.findByRole('listitem', { name: '文本格式化 第 1 次 执行完成' }),
    ).toBeTruthy();
    expect(screen.getByRole('listitem', { name: '文本格式化 第 2 次 正在执行' })).toBeTruthy();
    expect(screen.getByRole('listitem', { name: '普通节点 第 1 次 执行完成' })).toBeTruthy();
    const failed = screen.getByRole('listitem', { name: '失败节点 第 1 次 执行失败' });
    expect(within(failed).getByText('安全失败摘要')).toBeTruthy();
    expect(within(failed).getByText('阶段：invoke · NODE_FAILED')).toBeTruthy();
    const text = screen.getByRole('region', { name: '执行过程' }).textContent ?? '';
    expect(text).not.toContain('occurrence-failed');
    expect(text).not.toContain('nr-failed');
    expect(screen.queryByRole('button', { name: /重试|恢复|取消|Resume|Retry/ })).toBeNull();
    expect(pathText()).toContain('Workflow Run');
    expect(screen.queryByRole('button', { name: '返回上一级' })).toBeNull();
  });

  it('缺少唯一节点名时不展示节点标识', async () => {
    const load: ExecutionTreeLoad = async () =>
      page('run-1', root, [
        nodeRun({
          id: 'nr-hidden',
          nodeId: 'hidden-node-id',
          parent: root,
          status: 'completed',
          occurrenceId: 'occurrence-hidden',
        }),
      ]);
    render(ui({ load, definition: null }));
    expect(await screen.findByRole('listitem', { name: '节点 第 1 次 执行完成' })).toBeTruthy();
    const text = screen.getByRole('region', { name: '执行过程' }).textContent ?? '';
    expect(text).not.toContain('hidden-node-id');
    expect(text).not.toContain('occurrence-hidden');
  });

  it('普通 NodeRun 没有 Child Execution 时不显示虚假入口', async () => {
    const calls: ExecutionTreeQuery[] = [];
    const load: ExecutionTreeLoad = async (_runId, query) => {
      calls.push(query);
      if (query.parentType === 'node_run')
        return page('run-1', { type: 'node_run', id: 'nr-plain' }, []);
      return page('run-1', root, [
        nodeRun({ id: 'nr-plain', nodeId: 'plain', parent: root, status: 'completed' }),
      ]);
    };
    render(ui({ load }));
    expect(await screen.findByRole('listitem', { name: '普通节点 第 1 次 执行完成' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^进入/ })).toBeNull();
    expect(screen.queryByText(/^#\d/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '查看普通节点是否有子执行' }));
    expect(await screen.findByText('无子执行')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /普通节点/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^进入/ })).toBeNull();
    expect(screen.queryByRole('listitem', { name: /#/ })).toBeNull();
    expect(pathText().replaceAll('/', ' ').replaceAll(/\s+/g, ' ').trim()).toBe('Workflow Run');
    expect(
      calls.some((query) => query.parentType === 'node_run' && query.parentId === 'nr-plain'),
    ).toBe(true);
    expect(calls.some((query) => query.parentId === 'plain')).toBe(false);
  });

  it('Child Execution 使用 index 显示，进入后按 parent 读取 Body NodeRun', async () => {
    const calls: ExecutionTreeQuery[] = [];
    const decoy = 'do-not-parse-scope-alpha';
    const load: ExecutionTreeLoad = async (_runId, query) => {
      calls.push(query);
      if (query.parentType === 'workflow_run') {
        return page('run-1', root, [
          nodeRun({ id: 'nr-loop', nodeId: 'iterate-node', parent: root, status: 'completed' }),
        ]);
      }
      if (query.parentType === 'node_run' && query.parentId === 'nr-loop') {
        return page('run-1', { type: 'node_run', id: 'nr-loop' }, [
          childExecution({
            id: 'ce-2',
            parentId: 'nr-loop',
            status: 'failed',
            index: 2,
            note: decoy,
            error: { stage: 'collect', message: '第 2 项失败' },
          }),
          childExecution({ id: 'ce-0', parentId: 'nr-loop', status: 'completed', index: 0 }),
          childExecution({
            id: 'ce-plain',
            parentId: 'nr-loop',
            status: 'running',
            kind: 'batch_part',
          }),
        ]);
      }
      if (query.parentType === 'child_execution' && query.parentId === 'ce-0') {
        const parent = { type: 'child_execution' as const, id: 'ce-0' };
        return page('run-1', parent, [
          nodeRun({ id: 'nr-format', nodeId: 'format', parent, status: 'completed' }),
          nodeRun({ id: 'nr-script', nodeId: 'script', parent, status: 'completed' }),
          nodeRun({ id: 'nr-image', nodeId: 'image', parent, status: 'running' }),
        ]);
      }
      throw new Error(`未准备的查询 ${query.parentType}:${query.parentId ?? ''}`);
    };
    render(ui({ load }));
    fireEvent.click(await screen.findByRole('button', { name: '查看逐项处理是否有子执行' }));
    expect(await screen.findByRole('listitem', { name: '#2 执行失败' })).toBeTruthy();
    expect(layerLabels()).toEqual(['#2 执行失败', '#0 执行完成', '子执行 正在执行']);
    expect(
      within(screen.getByRole('listitem', { name: '#2 执行失败' })).getByText('第 2 项失败'),
    ).toBeTruthy();
    const region = screen.getByRole('region', { name: '执行过程' }).textContent ?? '';
    expect(region).not.toContain('iteration_item');
    expect(region).not.toContain('batch_part');
    expect(region).not.toContain('ce-2');
    expect(region).not.toContain(decoy);
    fireEvent.click(screen.getByRole('button', { name: '进入 #0' }));
    expect(
      await screen.findByRole('listitem', { name: '文本格式化 第 1 次 执行完成' }),
    ).toBeTruthy();
    expect(screen.getByRole('listitem', { name: '生成剧本 第 1 次 执行完成' })).toBeTruthy();
    expect(screen.getByRole('listitem', { name: '生成图片 第 1 次 正在执行' })).toBeTruthy();
    expect(calls.at(-1)).toMatchObject({ parentType: 'child_execution', parentId: 'ce-0' });
    expect(JSON.stringify(calls)).not.toContain(decoy);
    expect(calls.every((query) => query.parentId !== 'iterate-node')).toBe(true);
  });

  it('嵌套 Child Execution 可以继续进入，面包屑和返回使用已有 parent', async () => {
    const calls: ExecutionTreeQuery[] = [];
    const decoy = 'do-not-parse-scope-alpha';
    const load: ExecutionTreeLoad = async (runId, query) => {
      calls.push(query);
      if (runId === 'run-2') return page('run-2', { type: 'workflow_run', id: 'run-2' }, []);
      if (query.parentType === 'workflow_run') {
        return page('run-1', root, [
          nodeRun({ id: 'nr-loop', nodeId: 'iterate-node', parent: root, status: 'completed' }),
        ]);
      }
      if (query.parentType === 'node_run' && query.parentId === 'nr-loop') {
        return page('run-1', { type: 'node_run', id: 'nr-loop' }, [
          childExecution({
            id: 'ce-1',
            parentId: 'nr-loop',
            status: 'completed',
            index: 1,
            note: decoy,
          }),
        ]);
      }
      if (query.parentType === 'child_execution' && query.parentId === 'ce-1') {
        const parent = { type: 'child_execution' as const, id: 'ce-1' };
        return page('run-1', parent, [
          nodeRun({ id: 'nr-inner', nodeId: 'inner', parent, status: 'running' }),
        ]);
      }
      if (query.parentType === 'node_run' && query.parentId === 'nr-inner') {
        return page('run-1', { type: 'node_run', id: 'nr-inner' }, [
          childExecution({ id: 'ce-5', parentId: 'nr-inner', status: 'completed', index: 5 }),
        ]);
      }
      if (query.parentType === 'child_execution' && query.parentId === 'ce-5') {
        const parent = { type: 'child_execution' as const, id: 'ce-5' };
        return page('run-1', parent, [
          nodeRun({ id: 'nr-leaf', nodeId: 'leaf', parent, status: 'completed' }),
        ]);
      }
      throw new Error(`未准备的查询 ${query.parentType}:${query.parentId ?? ''}`);
    };
    const view = render(ui({ load }));
    fireEvent.click(await screen.findByRole('button', { name: '查看逐项处理是否有子执行' }));
    fireEvent.click(await screen.findByRole('button', { name: '进入 #1' }));
    fireEvent.click(await screen.findByRole('button', { name: '查看内层循环是否有子执行' }));
    fireEvent.click(await screen.findByRole('button', { name: '进入 #5' }));
    expect(await screen.findByRole('listitem', { name: '内层步骤 第 1 次 执行完成' })).toBeTruthy();
    const text = pathText();
    let cursor = 0;
    for (const label of ['Workflow Run', '逐项处理', '#1', '内层循环', '#5']) {
      const index = text.indexOf(label, cursor);
      expect(index).toBeGreaterThanOrEqual(0);
      cursor = index + label.length;
    }
    expect(calls.map((query) => `${query.parentType}:${query.parentId}`)).toEqual([
      'workflow_run:run-1',
      'node_run:nr-loop',
      'child_execution:ce-1',
      'node_run:nr-inner',
      'child_execution:ce-5',
    ]);
    expect(JSON.stringify(calls)).not.toContain(decoy);
    fireEvent.click(screen.getByRole('button', { name: '返回上一级' }));
    expect(await screen.findByRole('listitem', { name: '#5 执行完成' })).toBeTruthy();
    expect(screen.queryByRole('listitem', { name: /内层步骤/ })).toBeNull();
    expect(pathText()).not.toContain('#5');
    fireEvent.click(screen.getByRole('button', { name: '逐项处理' }));
    expect(await screen.findByRole('listitem', { name: '#1 执行完成' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Workflow Run' }));
    expect(await screen.findByRole('listitem', { name: '逐项处理 第 1 次 执行完成' })).toBeTruthy();
    expect(calls.some((query) => query.parentId === 'iterate-node')).toBe(false);
    view.rerender(ui({ load, reloadToken: 1 }));
    expect(await screen.findByRole('listitem', { name: '逐项处理 第 1 次 执行完成' })).toBeTruthy();
    await waitFor(() =>
      expect(calls.filter((query) => query.parentId === 'run-1').length).toBeGreaterThan(1),
    );
    view.rerender(ui({ load, runId: 'run-2', reloadToken: 1 }));
    expect(await screen.findByText('这一层还没有节点运行')).toBeTruthy();
    expect(calls.at(-1)).toMatchObject({ parentType: 'workflow_run', parentId: 'run-2' });
    expect(pathText()).not.toContain('#1');
  });

  it('分页追加 nextCursor，不替换已加载条目', async () => {
    const calls: ExecutionTreeQuery[] = [];
    const load: ExecutionTreeLoad = async (_runId, query) => {
      calls.push(query);
      if (query.parentType === 'workflow_run') {
        return page('run-1', root, [
          nodeRun({ id: 'nr-loop', nodeId: 'iterate-node', parent: root, status: 'running' }),
        ]);
      }
      const parent = { type: 'node_run' as const, id: 'nr-loop' };
      if (!query.after) {
        return page(
          'run-1',
          parent,
          [
            childExecution({ id: 'ce-0', parentId: 'nr-loop', status: 'completed', index: 0 }),
            childExecution({ id: 'ce-1', parentId: 'nr-loop', status: 'running', index: 1 }),
          ],
          'cursor-a',
        );
      }
      expect(query.after).toBe('cursor-a');
      return page('run-1', parent, [
        childExecution({ id: 'ce-2', parentId: 'nr-loop', status: 'failed', index: 2 }),
      ]);
    };
    render(ui({ load, pageSize: 2 }));
    fireEvent.click(await screen.findByRole('button', { name: '查看逐项处理是否有子执行' }));
    expect(await screen.findByRole('listitem', { name: '#0 执行完成' })).toBeTruthy();
    expect(screen.getByRole('listitem', { name: '#1 正在执行' })).toBeTruthy();
    expect(screen.queryByRole('listitem', { name: /#2/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '加载更多' }));
    expect(await screen.findByRole('listitem', { name: '#2 执行失败' })).toBeTruthy();
    expect(layerLabels()).toEqual(['#0 执行完成', '#1 正在执行', '#2 执行失败']);
    expect(screen.queryByRole('button', { name: '加载更多' })).toBeNull();
    expect(calls.at(-1)).toMatchObject({
      parentType: 'node_run',
      parentId: 'nr-loop',
      limit: 2,
      after: 'cursor-a',
    });
  });

  it('父引用不一致时不展示条目', async () => {
    const load: ExecutionTreeLoad = async () =>
      page('run-1', { type: 'workflow_run', id: 'other-run' }, [
        nodeRun({ id: 'nr-secret', nodeId: 'plain', parent: root, status: 'completed' }),
      ]);
    render(ui({ load }));
    expect(await screen.findByText('执行树响应与当前层不一致')).toBeTruthy();
    expect(screen.queryByRole('list', { name: '当前执行层' })).toBeNull();
    expect(screen.queryByText('普通节点')).toBeNull();
  });
});

describe('执行浏览边界', () => {
  it('数据层不依赖 Iteration 持久化契约', () => {
    const directory = [
      join(process.cwd(), 'src/features/workflow/run/execution'),
      join(process.cwd(), 'apps/web/src/features/workflow/run/execution'),
    ].find((candidate) => existsSync(candidate));
    if (!directory) throw new Error('未找到执行浏览源码');
    const files = readdirSync(directory).filter(
      (file) => file.endsWith('.ts') || file.endsWith('.tsx'),
    );
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readFileSync(join(directory, file), 'utf8');
      expect(source).not.toMatch(
        /IterationItemRun|iterationItemRun|iteration-item|scopeKey|flow\.iteration/,
      );
    }
  });

  it('执行树请求只序列化 parent 与分页', async () => {
    const fetch = vi.fn().mockResolvedValue(
      Response.json({
        run: treeRun('run/1'),
        parent: { type: 'child_execution', id: 'ce-1' },
        items: [],
        nextCursor: null,
      }),
    );
    vi.stubGlobal('fetch', fetch);
    await workflowApi.getExecutionTree(
      'run/1',
      executionTreeQuery({ type: 'child_execution', id: 'ce-1' }, { limit: 2, after: 'cursor-a' }),
    );
    expect(fetch.mock.calls[0]?.[0]).toBe(
      '/api/v1/workflow-runs/run%2F1/execution-tree?parentType=child_execution&parentId=ce-1&limit=2&after=cursor-a',
    );
    expect(String(fetch.mock.calls[0]?.[0])).not.toContain('scope');
  });
});
