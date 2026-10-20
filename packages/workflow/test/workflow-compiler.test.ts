import { describe, expect, it, vi } from 'vitest';
import { NumberType, type NodeDefinition } from '@dramaflow/contracts';
import { workflowRunnerFixture } from './workflow-runner-fixture.js';

describe('普通 Action 整图编译', () => {
  it.each(['A', 'B'] as const)(
    'A / B → C 使用 ALL Join，%s 先完成也不提前执行 C',
    async (first) => {
      const f = workflowRunnerFixture();
      const nodes = ['A', 'B', 'C'].map((id, index): NodeDefinition => {
        const inputs: NodeDefinition['inputs'] = {};
        if (id !== 'C') {
          inputs.a = { type: 'constant', value: index + 1 };
          inputs.b = { type: 'constant', value: index + 2 };
        }
        return { ...structuredClone(f.node), id, inputs };
      });
      f.version.definition = {
        inputs: [],
        nodes,
        edges: [
          {
            id: 'ac',
            kind: 'data',
            source: { nodeId: 'A', portKey: 'result' },
            target: { nodeId: 'C', portKey: 'a' },
          },
          {
            id: 'bc',
            kind: 'data',
            source: { nodeId: 'B', portKey: 'result' },
            target: { nodeId: 'C', portKey: 'b' },
          },
          { id: 'ac-control', kind: 'control', source: { nodeId: 'A' }, target: { nodeId: 'C' } },
        ],
        outputs: [
          { name: 'answer', type: NumberType, source: { nodeId: 'C', outputKey: 'result' } },
        ],
      };
      f.input.inputs = { a: { storage: 'inline', type: NumberType, value: 10 } };
      let releaseA!: () => void;
      let releaseB!: () => void;
      const a = new Promise<void>((resolve) => {
        releaseA = resolve;
      });
      const b = new Promise<void>((resolve) => {
        releaseB = resolve;
      });
      const completed: string[] = [];
      f.execute.mockImplementation(async (input) => {
        if (input.a === 1) {
          await a;
          completed.push('A');
        }
        if (input.a === 2) {
          await b;
          completed.push('B');
        }
        return { result: input.a + input.b, internal: '内部值' };
      });
      const invocation = f.runner.start(f.input);
      try {
        await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(2));
        (first === 'A' ? releaseA : releaseB)();
        await vi.waitFor(() => expect(completed).toEqual([first]));
        expect(f.execute).toHaveBeenCalledTimes(2);
        (first === 'A' ? releaseB : releaseA)();
        expect(await invocation).toMatchObject({
          status: 'completed',
          outputs: { answer: { value: 8 } },
        });
        expect(f.execute).toHaveBeenCalledTimes(3);
        const snapshot = await f.graphs[0]!.getState({ configurable: { thread_id: 'thread-7' } });
        expect(Object.keys(snapshot.values.outputs).sort()).toEqual(['A', 'B', 'C']);
      } finally {
        releaseA();
        releaseB();
        await invocation;
      }
    },
  );

  it('空定义直接到 END，最终输出为空且不执行节点', async () => {
    const f = workflowRunnerFixture();
    f.version.definition = { inputs: [], nodes: [], edges: [], outputs: [] };
    expect(await f.runner.start(f.input)).toMatchObject({ status: 'completed', outputs: {} });
    expect(f.nodeRuns.createRunning).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('精确版本不可用时在编译阶段失败，不执行节点或创建 NodeRun', async () => {
    const f = workflowRunnerFixture();
    f.node.typeVersion = 999;
    await expect(f.runner.start(f.input)).rejects.toMatchObject({ code: 'unavailable_type' });
    expect(f.runs.markFailed).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({ stage: 'compile' }),
    );
    expect(f.nodeRuns.createRunning).not.toHaveBeenCalled();
  });
});
