import { END, START, StateGraph } from '@langchain/langgraph';
import { StringType, type NodeOutputMap } from '@dramaflow/contracts';
import { describe, expect, it } from 'vitest';
import {
  DuplicateNodeOutputWriteError,
  mergeNodeOutputs,
  WorkflowStateAnnotation,
  type WorkflowState,
} from '../src/index.js';

const output = { text: { storage: 'inline', type: StringType, value: '结果' } } as const;
const initialState: WorkflowState = {
  run: { projectId: 'p', workflowId: 'w', workflowVersionId: 'v', workflowRunId: 'r' },
  inputs: {},
  outputs: {},
  variables: {},
  execution: {},
};

describe('outputs reducer', () => {
  it('按节点键合并增量，不改写输入 map 或 RuntimeValue', () => {
    const current = Object.freeze({ A: Object.freeze(output) });
    const update = Object.freeze({ B: Object.freeze(output) });
    const result = mergeNodeOutputs(current, update);
    expect(result).toEqual({ A: output, B: output });
    expect(current).toEqual({ A: output });
    expect(update).toEqual({ B: output });
    expect(result.A).toBe(output);
    expect(result.B).toBe(output);
    expect(mergeNodeOutputs(result, {})).toEqual(result);
  });

  it('同节点即使值相同也报冲突，整个 update 不部分写入', () => {
    const current = { A: output };
    const update = { B: output, A: output };
    expect(() => mergeNodeOutputs(current, update)).toThrow(DuplicateNodeOutputWriteError);
    expect(() => mergeNodeOutputs(current, update)).toThrowError(
      expect.objectContaining({ code: 'DUPLICATE_NODE_OUTPUT_WRITE', nodeId: 'A' }),
    );
    expect(current).toEqual({ A: output });
    expect(update).toEqual({ B: output, A: output });
  });

  it('只把自有键视为已写入节点，原型相关 nodeId 仍安全合并并检测冲突', () => {
    const update: NodeOutputMap = Object.fromEntries([
      ['__proto__', output],
      ['constructor', output],
      ['toString', output],
    ]);
    const result = mergeNodeOutputs({}, update);
    expect(Object.keys(result)).toEqual(['__proto__', 'constructor', 'toString']);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(() => mergeNodeOutputs(result, update)).toThrow(DuplicateNodeOutputWriteError);
  });
});

describe('真实 WorkflowState 通道', () => {
  it('outputs 缺省为空，每次无 checkpoint 调用独立初始化', async () => {
    const graph = new StateGraph(WorkflowStateAnnotation)
      .addNode('write', (state) => {
        expect(state.outputs).toEqual({});
        return { outputs: { A: output } };
      })
      .addEdge(START, 'write')
      .addEdge('write', END)
      .compile();
    const { outputs: _outputs, ...initial } = initialState;
    expect((await graph.invoke(initial)).outputs).toEqual({ A: output });
    expect((await graph.invoke(initial)).outputs).toEqual({ A: output });
    expect(initialState.outputs).toEqual({});
  });

  it('同一 graph step 的两次同 nodeId 写入使图失败，不静默取最后一个', async () => {
    const graph = new StateGraph(WorkflowStateAnnotation)
      .addNode('branchA', () => ({ outputs: { same: output } }))
      .addNode('branchB', () => ({ outputs: { same: output } }))
      .addEdge(START, 'branchA')
      .addEdge(START, 'branchB')
      .addEdge('branchA', END)
      .addEdge('branchB', END)
      .compile();
    await expect(graph.invoke(initialState)).rejects.toMatchObject({
      code: 'DUPLICATE_NODE_OUTPUT_WRITE',
      nodeId: 'same',
    });
  });

  it('已有输出不因进入新 step 而允许隐式覆盖', async () => {
    const graph = new StateGraph(WorkflowStateAnnotation)
      .addNode('first', () => ({ outputs: { same: output } }))
      .addNode('second', () => ({ outputs: { same: output } }))
      .addEdge(START, 'first')
      .addEdge('first', 'second')
      .addEdge('second', END)
      .compile();
    await expect(graph.invoke(initialState)).rejects.toMatchObject({
      code: 'DUPLICATE_NODE_OUTPUT_WRITE',
      nodeId: 'same',
    });
  });
});
