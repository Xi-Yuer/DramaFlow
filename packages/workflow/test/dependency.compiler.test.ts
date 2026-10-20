import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { describe, expect, it, vi } from 'vitest';
import { DependencyCompiler, type DeterministicDependency } from '../src/index.js';

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
    const dependencies = Object.freeze([
      Object.freeze({ sourceNodeId: 'A', targetNodeId: 'D' }),
      Object.freeze({ sourceNodeId: 'C', targetNodeId: 'E' }),
      Object.freeze({ sourceNodeId: 'B', targetNodeId: 'D' }),
      Object.freeze({ sourceNodeId: 'A', targetNodeId: 'D' }),
    ]);
    expect(compiler.aggregate(dependencies)).toEqual([
      { targetNodeId: 'D', sourceNodeIds: ['A', 'B'] },
      { targetNodeId: 'E', sourceNodeIds: ['C'] },
    ]);
  });

  it('每个目标只生成一条边，多上游使用数组 Join，单上游使用字符串', () => {
    const addEdge = vi.fn();
    compiler.compile({
      dependencies: [
        { sourceNodeId: 'A', targetNodeId: 'D' },
        { sourceNodeId: 'B', targetNodeId: 'D' },
        { sourceNodeId: 'C', targetNodeId: 'E' },
        { sourceNodeId: 'C', targetNodeId: 'E' },
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
    expect(compiler.aggregate([])).toEqual([]);
    compiler.compile({ dependencies: [], addEdge });
    expect(addEdge).not.toHaveBeenCalled();
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
      dependencies: [
        { sourceNodeId: 'A', targetNodeId: 'C' },
        { sourceNodeId: 'B', targetNodeId: 'C' },
      ],
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
    const dependencies: DeterministicDependency[] = [
      { sourceNodeId: 'prepareB', targetNodeId: 'B' },
      { sourceNodeId: 'A', targetNodeId: 'C' },
      { sourceNodeId: 'B', targetNodeId: 'C' },
    ];
    compiler.compile({
      dependencies,
      addEdge: (source, target) => {
        graph.addEdge(source, target);
      },
    });
    const result = await graph.compile().invoke({ completed: [] });
    expect(executeC).toHaveBeenCalledTimes(1);
    expect(result.completed).toEqual(['A', 'prepareB', 'B', 'C']);
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
      dependencies: [
        { sourceNodeId: 'A', targetNodeId: 'C' },
        { sourceNodeId: 'B', targetNodeId: 'C' },
      ],
      addEdge: (source, target) => {
        graph.addEdge(source, target);
      },
    });
    await expect(graph.compile().invoke({ completed: [] })).rejects.toThrow('上游失败');
    expect(executeC).not.toHaveBeenCalled();
  });
});
