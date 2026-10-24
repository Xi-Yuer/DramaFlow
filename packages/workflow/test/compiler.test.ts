import { describe, expect, it, vi } from 'vitest';
import {
  Annotation,
  Command,
  END,
  interrupt,
  MemorySaver,
  START,
  StateGraph,
} from '@langchain/langgraph';
import { StringType, type NodeDefinition, type NodeTypeManifest } from '@dramaflow/contracts';
import {
  ActionNodeCompilationStrategy,
  createWorkflowRunConfig,
  type LangGraphNode,
  type NodeExecutor,
  type NodeExecutionResult,
  type WorkflowState,
} from '../src/index.js';

const node: NodeDefinition = {
  id: 'a',
  type: 'test.action',
  typeVersion: 1,
  name: '测试操作',
  inputs: {},
  config: {},
  ui: { position: { x: 0, y: 0 } },
};
const manifest: NodeTypeManifest = {
  type: node.type,
  version: 1,
  executionKind: 'action',
  metadata: { name: '测试操作', category: 'data' },
  inputs: [],
  outputs: [{ key: 'text', name: '文本', dataType: StringType }],
  config: [],
};
const state: WorkflowState = {
  run: { workflowId: 'w', workflowVersionId: 'v', workflowRunId: 'r', projectId: 'p' },
  inputs: {},
  outputs: {},
  variables: {},
  execution: {},
};
const workflow = { inputs: [], nodes: [node], edges: [], outputs: [] };

describe('普通操作编译策略', () => {
  it('仅包装统一 Executor，编译不执行业务，节点不获得 Graph builder', async () => {
    const result: NodeExecutionResult = {
      output: { text: { storage: 'inline', type: StringType, value: '结果' } },
    };
    const execute = vi.fn<NodeExecutor['execute']>().mockResolvedValue(result);
    const addNode = vi.fn<(id: string, node: LangGraphNode) => void>();
    new ActionNodeCompilationStrategy().compile({
      node,
      manifest,
      executor: { execute },
      executionContext: (config) => ({
        scopeKey: 'root',
        projectId: 'stale-project',
        workflowRunId: 'stale-run',
        workflow,
        runnableConfig: config,
      }),
      addNode,
    });
    expect(execute).not.toHaveBeenCalled();
    const wrapped = addNode.mock.calls[0]![1];
    const config = { configurable: { thread_id: 't' }, maxConcurrency: 2 };
    const currentState = {
      ...state,
      outputs: { previous: { text: { storage: 'inline', type: StringType, value: '旧结果' } } },
    } satisfies WorkflowState;
    const snapshot = structuredClone(currentState);
    expect(await wrapped(currentState, config)).toEqual({ outputs: { [node.id]: result.output } });
    expect(currentState).toEqual(snapshot);
    expect(execute).toHaveBeenCalledWith(node, {
      scopeKey: 'root',
      projectId: 'p',
      workflowRunId: 'r',
      runnableConfig: config,
      workflow,
      state: currentState,
    });
  });
  it('Executor 失败时原样传播，不返回 output delta', async () => {
    const cause = new Error('执行失败');
    const execute = vi.fn<NodeExecutor['execute']>().mockRejectedValue(cause);
    const addNode = vi.fn<(id: string, node: LangGraphNode) => void>();
    new ActionNodeCompilationStrategy().compile({
      node,
      manifest,
      executor: { execute },
      executionContext: () => ({ scopeKey: 'root', workflow }),
      addNode,
    });
    await expect(addNode.mock.calls[0]![1](state, {})).rejects.toBe(cause);
  });
  it('拒绝错误版本和非 action，不为控制结构编造执行语义', () => {
    const strategy = new ActionNodeCompilationStrategy();
    const context = {
      node,
      manifest,
      executor: { execute: vi.fn<NodeExecutor['execute']>() },
      executionContext: () => ({ scopeKey: 'root', projectId: 'p', workflowRunId: 'r', workflow }),
      addNode: vi.fn(),
    };
    for (const executionKind of ['control', 'composite', 'interaction'] as const)
      expect(() =>
        strategy.compile({ ...context, manifest: { ...manifest, executionKind } }),
      ).toThrow('不能编译');
    expect(() => strategy.compile({ ...context, node: { ...node, typeVersion: 2 } })).toThrow(
      '版本不匹配',
    );
    expect(context.addNode).not.toHaveBeenCalled();
  });
});

describe('LangGraph 原生恢复与运行定位', () => {
  const version = { id: 'v', workflowId: 'w', version: 1, publishedAt: '2026-10-19T00:00:00.000Z' };
  const run = {
    id: 'r',
    workflowId: 'w',
    workflowVersionId: 'v',
    threadId: 'root-thread',
    status: 'pending' as const,
  };
  it('显式 threadId 保留配置，拒绝配置覆盖与版本错配', () => {
    const config = { configurable: { requestId: 'req' }, maxConcurrency: 2 };
    expect(createWorkflowRunConfig(run, version, config)).toEqual({
      ...config,
      configurable: { requestId: 'req', thread_id: run.threadId },
    });
    expect(config.configurable).toEqual({ requestId: 'req' });
    expect(() =>
      createWorkflowRunConfig(run, version, { configurable: { thread_id: run.id } }),
    ).toThrow('threadId');
    expect(() => createWorkflowRunConfig({ ...run, workflowVersionId: 'other' }, version)).toThrow(
      '版本',
    );
  });
  it('完整 WorkflowRun 可复用现有 thread 配置适配，不把运行数据传入配置', () => {
    const fullRun = {
      ...run,
      projectId: 'project-1',
      inputs: {},
      createdAt: '2026-10-20T00:00:00.000Z',
    };
    expect(createWorkflowRunConfig(fullRun, version)).toEqual({
      configurable: { thread_id: run.threadId },
    });
  });
  it('控制结构仍直接用原生 interrupt/Command，同一 thread 恢复且不影响其他线程', async () => {
    const TestState = Annotation.Root({
      value: Annotation<number>(),
      approved: Annotation<boolean>(),
    });
    const graph = new StateGraph(TestState)
      .addNode('review', () => ({
        approved: interrupt<{ question: string }, { approved: boolean }>({ question: '继续？' })
          .approved,
      }))
      .addEdge(START, 'review')
      .addEdge('review', END)
      .compile({ checkpointer: new MemorySaver() });
    const config = createWorkflowRunConfig(run, version);
    const second = createWorkflowRunConfig({ ...run, id: 'r2', threadId: 'thread-2' }, version);
    await graph.invoke({ value: 1 }, config);
    await graph.invoke({ value: 2 }, second);
    const result = await graph.invoke(new Command({ resume: { approved: false } }), config);
    expect(result.value).toBe(1);
    expect(result.approved).toBe(false);
    expect((await graph.getState(config)).tasks).toHaveLength(0);
    expect((await graph.getState(second)).tasks).toHaveLength(1);
  });
});
