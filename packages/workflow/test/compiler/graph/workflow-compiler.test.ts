import { MemorySaver } from '@langchain/langgraph';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  NumberType,
  StringType,
  type NodeDefinition,
  type WorkflowRun,
} from '@dramaflow/contracts';
import {
  createBindingResolver,
  DefaultDataStoragePolicyResolver,
  DefaultNodeExecutor,
  DefaultRuntimeValueCodec,
  DefaultWorkflowCompiler,
  NodeRegistry,
} from '../../../src/index.js';
import { nodeRunRepositoryFixture } from '../../fixtures/node-run-fixture.js';
import { workflowRunnerFixture } from '../../fixtures/workflow-runner-fixture.js';

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
      const invocation = f.start({ ...f.input, inputs: {} });
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
    expect(await f.start({ ...f.input, inputs: {} })).toMatchObject({
      status: 'completed',
      outputs: {},
    });
    expect(f.nodeRuns.createRunning).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('精确版本不可用时在编译阶段失败，不执行节点或创建 NodeRun', async () => {
    const f = workflowRunnerFixture();
    f.node.typeVersion = 999;
    await expect(f.start(f.input)).rejects.toMatchObject({ code: 'unavailable_type' });
    expect(f.runs.markFailed).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({ stage: 'compile' }),
    );
    expect(f.nodeRuns.createRunning).not.toHaveBeenCalled();
  });

  it('仅由模板引用连接的下游等待上游，并收到渲染后的字符串', async () => {
    let releaseOutline!: () => void;
    let releaseCharacters!: () => void;
    const outlineGate = new Promise<void>((resolve) => {
      releaseOutline = resolve;
    });
    const characterGate = new Promise<void>((resolve) => {
      releaseCharacters = resolve;
    });
    const executeSource = vi.fn(async (input: { text: string }) => {
      await (input.text === '第一幕' ? outlineGate : characterGate);
      return { text: input.text };
    });
    const executeScript = vi.fn(async (input: { prompt: string }) => ({ text: input.prompt }));
    const sourceManifest = {
      type: 'test.source',
      version: 1,
      executionKind: 'action' as const,
      metadata: { name: '来源', category: 'data' as const },
      inputs: [{ key: 'text', name: '文本', dataType: StringType, required: true }],
      outputs: [{ key: 'text', name: '文本', dataType: StringType }],
      config: [],
    };
    const registry = new NodeRegistry([
      {
        manifest: sourceManifest,
        inputSchema: z.object({ text: z.string() }),
        outputSchema: z.object({ text: z.string() }),
        configSchema: z.object({}).strict(),
        execute: executeSource,
      },
      {
        manifest: {
          type: 'test.script',
          version: 1,
          executionKind: 'action',
          metadata: { name: '剧本', category: 'ai' },
          inputs: [{ key: 'prompt', name: '提示词', dataType: StringType, required: true }],
          outputs: [{ key: 'text', name: '文本', dataType: StringType }],
          config: [],
        },
        inputSchema: z.object({ prompt: z.string() }),
        outputSchema: z.object({ text: z.string() }),
        configSchema: z.object({}).strict(),
        execute: executeScript,
      },
    ]);
    const node = (id: string, type: string, inputs: NodeDefinition['inputs']): NodeDefinition => ({
      id,
      type,
      typeVersion: 1,
      name: id,
      inputs,
      config: {},
      ui: { position: { x: 0, y: 0 } },
    });
    const definition = {
      inputs: [],
      nodes: [
        node('outline', 'test.source', { text: { type: 'constant', value: '第一幕' } }),
        node('characters', 'test.source', { text: { type: 'constant', value: '阿青' } }),
        node('script', 'test.script', {
          prompt: {
            type: 'template',
            value: '请根据 {{outline}} 和 {{characters}} 生成剧本',
            variables: {
              outline: { type: 'node_output', nodeId: 'outline', portKey: 'text' },
              characters: { type: 'node_output', nodeId: 'characters', portKey: 'text' },
            },
          },
        }),
      ],
      edges: [],
      outputs: [],
    };
    const run: WorkflowRun = {
      id: 'run-template',
      projectId: 'project-1',
      workflowId: 'workflow-1',
      workflowVersionId: 'version-1',
      invocationKey: 'invocation-template',
      threadId: 'thread-template',
      status: 'running',
      inputs: {},
      createdAt: '2026-10-22T00:00:00.000Z',
    };
    const executor = new DefaultNodeExecutor(
      registry,
      createBindingResolver(),
      new DefaultRuntimeValueCodec(
        { resolve: vi.fn() },
        { write: vi.fn() },
        new DefaultDataStoragePolicyResolver(),
      ),
      nodeRunRepositoryFixture(),
    );
    const graph = await new DefaultWorkflowCompiler(
      registry,
      async () => executor,
      new MemorySaver(),
    ).compile(definition, run);
    const invocation = graph.invoke(
      {
        run: {
          workflowId: run.workflowId,
          workflowVersionId: run.workflowVersionId,
          workflowRunId: run.id,
          projectId: run.projectId,
        },
        inputs: {},
        outputs: {},
        variables: {},
        execution: {},
      },
      { configurable: { thread_id: run.threadId } },
    );
    try {
      await vi.waitFor(() => expect(executeSource).toHaveBeenCalledTimes(2));
      expect(executeScript).not.toHaveBeenCalled();
      releaseOutline();
      releaseCharacters();
      const result = await invocation;
      expect(executeScript.mock.calls[0]?.[0]).toEqual({
        prompt: '请根据 第一幕 和 阿青 生成剧本',
      });
      expect(result).toMatchObject({
        outputs: {
          script: {
            text: {
              storage: 'inline',
              type: StringType,
              value: '请根据 第一幕 和 阿青 生成剧本',
            },
          },
        },
      });
    } finally {
      releaseOutline();
      releaseCharacters();
      await invocation.catch(() => undefined);
    }
  });
});
