import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import type {
  ControlEdgeDefinition,
  DataEdgeDefinition,
  NodeDefinition,
  WorkflowEdge,
} from '@dramaflow/contracts';
import { describe, expect, it, vi } from 'vitest';
import { collectNodeDependencies, DependencyCompiler } from '../src/index.js';

function controlEdge(
  sourceNodeId: string,
  targetNodeId: string,
  id = `${sourceNodeId}-${targetNodeId}`,
): ControlEdgeDefinition {
  return {
    id,
    kind: 'control',
    source: { nodeId: sourceNodeId },
    target: { nodeId: targetNodeId },
  };
}

const imageEdge: DataEdgeDefinition = {
  id: 'A-image-C-image',
  kind: 'data',
  source: { nodeId: 'A', portKey: 'image' },
  target: { nodeId: 'C', portKey: 'image' },
};
const mixedEdges: WorkflowEdge[] = [imageEdge, controlEdge('B', 'C'), controlEdge('A', 'C')];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const TestState = Annotation.Root({
  completed: Annotation<string[]>({
    reducer: (current, update) => current.concat(update),
    default: () => [],
  }),
});

describe('普通确定性依赖编译', () => {
  const compiler = new DependencyCompiler();

  it('按目标聚合、去重并保留首次出现顺序，不修改输入', () => {
    const edges = Object.freeze([
      Object.freeze(controlEdge('A', 'D')),
      Object.freeze(controlEdge('C', 'E')),
      Object.freeze(controlEdge('B', 'D')),
      Object.freeze(controlEdge('A', 'D', 'A-D-again')),
    ]);
    expect(collectNodeDependencies(edges)).toEqual([
      { targetNodeId: 'D', sourceNodeIds: ['A', 'B'] },
      { targetNodeId: 'E', sourceNodeIds: ['C'] },
    ]);
  });

  it('每个目标只生成一条边，多上游使用数组 Join，单上游使用字符串', () => {
    const addEdge = vi.fn();
    compiler.compile({
      edges: [
        controlEdge('A', 'D'),
        controlEdge('B', 'D'),
        controlEdge('C', 'E'),
        controlEdge('C', 'E', 'C-E-again'),
      ],
      addEdge,
    });
    expect(addEdge.mock.calls).toEqual([
      [['A', 'B'], 'D'],
      ['C', 'E'],
    ]);
  });

  it('没有依赖时不生成边，也不自行接入 START 或 END', () => {
    const addEdge = vi.fn();
    expect(collectNodeDependencies([])).toEqual([]);
    compiler.compile({ edges: [], addEdge });
    expect(addEdge).not.toHaveBeenCalled();
  });

  it('Data / Control Edge 混合时按节点对去重，并保留原始边及端口', () => {
    const snapshot = structuredClone(mixedEdges);
    const edges = Object.freeze(
      structuredClone(mixedEdges).map((edge) => {
        Object.freeze(edge.source);
        Object.freeze(edge.target);
        return Object.freeze(edge);
      }),
    );
    expect(collectNodeDependencies(edges)).toEqual([
      { targetNodeId: 'C', sourceNodeIds: ['A', 'B'] },
    ]);
    const addEdge = vi.fn();
    compiler.compile({ edges, addEdge });
    expect(addEdge.mock.calls).toEqual([[['A', 'B'], 'C']]);
    expect(edges).toEqual(snapshot);
    expect(edges[0]).toEqual(imageEdge);
  });

  it('同一来源的多个 Data Edge 只形成一个上游，单个 Data Edge 也产生依赖', () => {
    const edges: DataEdgeDefinition[] = [
      imageEdge,
      {
        id: 'A-text-C-prompt',
        kind: 'data',
        source: { nodeId: 'A', portKey: 'text' },
        target: { nodeId: 'C', portKey: 'prompt' },
      },
    ];
    expect(collectNodeDependencies([imageEdge])).toEqual([
      { targetNodeId: 'C', sourceNodeIds: ['A'] },
    ]);
    const addEdge = vi.fn();
    compiler.compile({ edges, addEdge });
    expect(addEdge.mock.calls).toEqual([['A', 'C']]);
    expect(edges).toHaveLength(2);
  });

  it('收集与编译均不读取 Data Edge 的端口', () => {
    const edge: DataEdgeDefinition = {
      id: 'A-image-C-image',
      kind: 'data',
      source: {
        nodeId: 'A',
        get portKey(): string {
          throw new Error('依赖编译不得读取数据端口');
        },
      },
      target: {
        nodeId: 'C',
        get portKey(): string {
          throw new Error('依赖编译不得读取数据端口');
        },
      },
    };
    expect(collectNodeDependencies([edge])).toEqual([{ targetNodeId: 'C', sourceNodeIds: ['A'] }]);
    const addEdge = vi.fn();
    compiler.compile({ edges: [edge], addEdge });
    expect(addEdge.mock.calls).toEqual([['A', 'C']]);
  });

  it.each([
    ['A', 'B'],
    ['B', 'A'],
  ] as const)('真实 LangGraph：%s 先完成时仍等待 %s，C 只执行一次', async (first, second) => {
    const gates = { A: deferred(), B: deferred() };
    const started = { A: deferred(), B: deferred() };
    const finished = { A: deferred(), B: deferred() };
    const completionOrder: string[] = [];
    const upstream = (id: 'A' | 'B') => async () => {
      started[id].resolve();
      await gates[id].promise;
      completionOrder.push(id);
      finished[id].resolve();
      return { completed: [id] };
    };
    const executeC = vi.fn((state: typeof TestState.State) => {
      expect(state.completed).toEqual(expect.arrayContaining(['A', 'B']));
      expect(completionOrder).toEqual([first, second]);
      return { completed: ['C'] };
    });
    const graph = new StateGraph(TestState)
      .addNode<string>('A', upstream('A'))
      .addNode('B', upstream('B'))
      .addNode('C', executeC)
      .addEdge(START, 'A')
      .addEdge(START, 'B')
      .addEdge('C', END);
    compiler.compile({
      edges: mixedEdges,
      addEdge: (source, target) => {
        graph.addEdge(source, target);
      },
    });
    expect([...graph.waitingEdges]).toEqual([[['A', 'B'], 'C']]);
    expect([...graph.edges]).not.toContainEqual(['A', 'C']);
    expect([...graph.edges]).not.toContainEqual(['B', 'C']);

    const invocation = graph.compile().invoke({ completed: [] });
    try {
      await Promise.all([started.A.promise, started.B.promise]);
      gates[first].resolve();
      await finished[first].promise;
      // 让 Runtime 处理已完成上游的微任务；完成顺序由 gate 控制，不依赖延迟大小。
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(completionOrder).toEqual([first]);
      expect(executeC).not.toHaveBeenCalled();

      gates[second].resolve();
      const result = await invocation;
      expect(executeC).toHaveBeenCalledTimes(1);
      expect(result.completed).toEqual(['A', 'B', 'C']);
    } finally {
      gates.A.resolve();
      gates.B.resolve();
      await invocation;
    }
  });

  it('真实 LangGraph：不同长度路径汇合时不提前触发或重复执行 C', async () => {
    const executeC = vi.fn((state: typeof TestState.State) => {
      expect(state.completed).toEqual(expect.arrayContaining(['A', 'B']));
      return { completed: ['C'] };
    });
    const graph = new StateGraph(TestState)
      .addNode<string>('A', () => ({ completed: ['A'] }))
      .addNode('prepareB', () => ({ completed: ['prepareB'] }))
      .addNode('B', () => ({ completed: ['B'] }))
      .addNode('C', executeC)
      .addEdge(START, 'A')
      .addEdge(START, 'prepareB')
      .addEdge('C', END);
    compiler.compile({
      edges: [controlEdge('prepareB', 'B'), ...mixedEdges],
      addEdge: (source, target) => {
        graph.addEdge(source, target);
      },
    });
    const result = await graph.compile().invoke({ completed: [] });
    expect(executeC).toHaveBeenCalledTimes(1);
    expect(result.completed).toEqual(['A', 'prepareB', 'B', 'C']);
  });

  it('template 的 node_output 按变量顺序加入依赖，workflow input 不产生节点依赖', () => {
    const nodes: Pick<NodeDefinition, 'id' | 'inputs'>[] = [
      {
        id: 'script',
        inputs: {
          prompt: {
            type: 'template',
            value: '{{outline}} {{characters}} {{style}}',
            variables: {
              outline: { type: 'node_output', nodeId: 'outline', portKey: 'text' },
              characters: {
                type: 'node_output',
                nodeId: 'characters',
                get portKey(): string {
                  throw new Error('依赖编译不得读取模板端口');
                },
              },
              style: { type: 'workflow_input', key: 'style' },
            },
          },
        },
      },
    ];
    expect(collectNodeDependencies([], nodes)).toEqual([
      { targetNodeId: 'script', sourceNodeIds: ['outline', 'characters'] },
    ]);
    const addEdge = vi.fn();
    compiler.compile({ edges: [], nodes, addEdge });
    expect(addEdge.mock.calls).toEqual([[['outline', 'characters'], 'script']]);
  });

  it('已有边先于模板来源，重复节点对只保留第一次', () => {
    const nodes: Pick<NodeDefinition, 'id' | 'inputs'>[] = [
      {
        id: 'script',
        inputs: {
          prompt: {
            type: 'template',
            value: '{{outline}} {{characters}}',
            variables: {
              outline: { type: 'node_output', nodeId: 'outline', portKey: 'text' },
              characters: { type: 'node_output', nodeId: 'characters', portKey: 'text' },
            },
          },
        },
      },
    ];
    expect(collectNodeDependencies([controlEdge('outline', 'script')], nodes)).toEqual([
      { targetNodeId: 'script', sourceNodeIds: ['outline', 'characters'] },
    ]);
  });

  it('candidate 的 node_output 来源进入静态依赖收集，与边去重且不读取端口', () => {
    const nodes: Pick<NodeDefinition, 'id' | 'inputs'>[] = [
      {
        id: 'D',
        inputs: {
          prompt: {
            type: 'candidate',
            sources: [
              { type: 'node_output', nodeId: 'B', portKey: 'text' },
              {
                type: 'node_output',
                nodeId: 'C',
                get portKey(): string {
                  throw new Error('依赖收集不得读取候选端口');
                },
              },
            ],
          },
        },
      },
    ];
    expect(collectNodeDependencies([], nodes)).toEqual([
      { targetNodeId: 'D', sourceNodeIds: ['B', 'C'] },
    ]);
    expect(collectNodeDependencies([controlEdge('C', 'D')], nodes)).toEqual([
      { targetNodeId: 'D', sourceNodeIds: ['C', 'B'] },
    ]);
  });

  it('真实 LangGraph：模板引用的多个上游全部完成后才执行一次', async () => {
    const gates = { outline: deferred(), characters: deferred() };
    const started = { outline: deferred(), characters: deferred() };
    const upstream = (id: 'outline' | 'characters') => async () => {
      started[id].resolve();
      await gates[id].promise;
      return { completed: [id] };
    };
    const executeScript = vi.fn(() => ({ completed: ['script'] }));
    const graph = new StateGraph(TestState)
      .addNode<string>('outline', upstream('outline'))
      .addNode('characters', upstream('characters'))
      .addNode('script', executeScript)
      .addEdge(START, 'outline')
      .addEdge(START, 'characters')
      .addEdge('script', END);
    compiler.compile({
      edges: [],
      nodes: [
        {
          id: 'script',
          inputs: {
            prompt: {
              type: 'template',
              value: '{{outline}} {{characters}}',
              variables: {
                outline: { type: 'node_output', nodeId: 'outline', portKey: 'text' },
                characters: { type: 'node_output', nodeId: 'characters', portKey: 'text' },
              },
            },
          },
        },
      ],
      addEdge: (source, target) => {
        graph.addEdge(source, target);
      },
    });
    const invocation = graph.compile().invoke({ completed: [] });
    try {
      await Promise.all([started.outline.promise, started.characters.promise]);
      expect(executeScript).not.toHaveBeenCalled();
      gates.outline.resolve();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(executeScript).not.toHaveBeenCalled();
      gates.characters.resolve();
      const result = await invocation;
      expect(executeScript).toHaveBeenCalledTimes(1);
      expect(result.completed).toEqual(expect.arrayContaining(['outline', 'characters', 'script']));
      expect(result.completed.at(-1)).toBe('script');
    } finally {
      gates.outline.resolve();
      gates.characters.resolve();
      await invocation;
    }
  });

  it('真实 LangGraph：任一确定性上游失败时不执行 C，并传播失败', async () => {
    const executeC = vi.fn(() => ({ completed: ['C'] }));
    const graph = new StateGraph(TestState)
      .addNode<string>('A', () => ({ completed: ['A'] }))
      .addNode('B', () => {
        throw new Error('上游失败');
      })
      .addNode('C', executeC)
      .addEdge(START, 'A')
      .addEdge(START, 'B')
      .addEdge('C', END);
    compiler.compile({
      edges: mixedEdges,
      addEdge: (source, target) => {
        graph.addEdge(source, target);
      },
    });
    await expect(graph.compile().invoke({ completed: [] })).rejects.toThrow('上游失败');
    expect(executeC).not.toHaveBeenCalled();
  });
});
