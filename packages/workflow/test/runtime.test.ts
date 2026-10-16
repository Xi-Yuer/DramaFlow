import { MemorySaver } from '@langchain/langgraph';
import type {
  InputBinding,
  JsonObject,
  NodeResult,
  NodeType,
  WorkflowDefinition,
  WorkflowNode,
} from '@dramaflow/contracts';
import { describe, expect, it } from 'vitest';
import { createWorkflowRuntime, getInvalidatedNodeIds, validateWorkflow } from '../src/index.js';
import type { HumanTaskRequest, NodeRecord, OperationRequest, RuntimeHost } from '../src/types.js';

const model = {
  pluginId: 'openai',
  pluginVersion: '1.0.0',
  connectionId: 'chosen-connection',
  modelId: 'explicit-test-model',
};
const node = (id: string, type: NodeType, config: JsonObject = {}): WorkflowNode => ({
  id,
  type,
  title: id,
  version: '1.0.0',
  position: { x: 0, y: 0 },
  config,
});
const generation = (id: string) => node(id, 'text', { model, prompt: `需求 ${id}` });
const wire = (source: string, target: string, sourcePort = 'out') => ({
  id: `${source}-${sourcePort}-${target}`,
  source,
  target,
  sourcePort,
});
const binding = (
  nodeId: string,
  port: string,
  from: string,
  fromPort: string,
  optional = false,
): InputBinding => ({
  nodeId,
  port,
  source: { kind: 'node', nodeId: from, port: fromPort },
  optional,
});
const literal = (nodeId: string, port: string, value: JsonObject[string]): InputBinding => ({
  nodeId,
  port,
  source: { kind: 'literal', value },
  optional: false,
});
const definition = (
  nodes: WorkflowNode[],
  controlEdges: WorkflowDefinition['controlEdges'],
  bindings: InputBinding[] = [],
): WorkflowDefinition => ({ schemaVersion: 1, nodes, controlEdges, bindings });

class TestHost implements RuntimeHost {
  calls: OperationRequest[] = [];
  records: NodeRecord[] = [];
  tasks: HumanTaskRequest[] = [];
  operations = new Map<string, JsonObject>();
  canceled = false;
  async executeOperation(request: OperationRequest): Promise<JsonObject> {
    const existing = this.operations.get(request.operationId);
    if (existing) return existing;
    this.calls.push(request);
    const result: JsonObject =
      request.capability === 'image.generate'
        ? {
            images: [
              {
                assetId: `asset-${request.itemId ?? request.nodeId}`,
                versionId: 'v1',
                type: 'image',
                mimeType: 'image/png',
              },
            ],
          }
        : {
            text: `结果 ${request.nodeId}${request.itemId !== undefined ? `/${request.itemId}` : ''}`,
          };
    this.operations.set(request.operationId, result);
    return result;
  }
  async recordNodeResult(record: NodeRecord) {
    this.records.push(record);
  }
  async createHumanTask(request: HumanTaskRequest) {
    this.tasks.push(request);
  }
  async isCancelled() {
    return this.canceled;
  }
}

function runtime(
  value: WorkflowDefinition,
  host = new TestHost(),
  checkpointer = new MemorySaver(),
) {
  return { host, engine: createWorkflowRuntime({ definition: value, host, checkpointer }) };
}

describe('静态AND与业务激活', () => {
  it('不等长条件分支传播skipped，selected合并且Output后仍继续执行', async () => {
    const value = definition(
      [
        node('in', 'input'),
        node('condition', 'condition', { operator: 'isTruthy' }),
        generation('a'),
        generation('a2'),
        generation('b'),
        node('merge', 'merge', { mode: 'selected' }),
        node('out', 'output'),
        generation('after'),
        node('last', 'output'),
      ],
      [
        wire('in', 'condition'),
        wire('condition', 'a', 'true'),
        wire('condition', 'b', 'false'),
        wire('a', 'a2'),
        wire('a2', 'merge'),
        wire('b', 'merge'),
        wire('merge', 'out'),
        wire('out', 'after'),
        wire('after', 'last'),
      ],
      [
        literal('condition', 'value', true),
        binding('merge', 'a', 'a2', 'text'),
        binding('merge', 'b', 'b', 'text'),
        binding('out', 'result', 'merge', 'value'),
        binding('after', 'context', 'out', 'result'),
        binding('last', 'result', 'after', 'text'),
        binding('b', 'context', 'a2', 'text'),
      ],
    );
    expect(validateWorkflow(value)).toEqual({ valid: true, issues: [] });
    const { engine, host } = runtime(value);
    const result = await engine.invoke({ runId: 'run', attemptId: 'attempt', inputs: {} });
    expect(result.status).toBe('succeeded');
    expect(result.nodeResults.b?.status).toBe('skipped');
    expect(host.calls.map((call) => call.nodeId)).toEqual(['a', 'a2', 'after']);
    expect(result.outputCollections).toEqual({
      out: { result: '结果 a2' },
      last: { result: '结果 after' },
    });
    expect(
      host.records.filter(
        (record) => record.nodeId === 'merge' && record.result.status === 'succeeded',
      ),
    ).toHaveLength(1);
  });

  it('激活节点的必需输入来自skipped分支时结构化失败，不调用模型', async () => {
    const value = definition(
      [
        node('in', 'input'),
        node('condition', 'condition'),
        generation('yes'),
        generation('no'),
        node('out', 'output'),
      ],
      [
        wire('in', 'condition'),
        wire('condition', 'yes', 'true'),
        wire('condition', 'no', 'false'),
        wire('yes', 'out'),
      ],
      [
        literal('condition', 'value', true),
        binding('yes', 'context', 'no', 'text'),
        binding('out', 'result', 'yes', 'text'),
      ],
    );
    const { engine, host } = runtime(value);
    const result = await engine.invoke({ runId: 'required', attemptId: 'a', inputs: {} });
    expect(result.nodeResults.yes?.error?.code).toBe('INPUT_UNAVAILABLE_FROM_SKIPPED_BRANCH');
    expect(result.nodeResults.out?.status).toBe('blocked');
    expect(result.status).toBe('failed');
    expect(host.calls).toHaveLength(0);
  });

  it('并行分支写入独立结果，结果收集保留混合类型与多个上游', async () => {
    const value = definition(
      [
        node('in', 'input'),
        generation('text'),
        node('image', 'image', { model, prompt: '分镜' }),
        node('out', 'output'),
      ],
      [wire('in', 'text'), wire('in', 'image'), wire('text', 'out'), wire('image', 'out')],
      [
        binding('out', 'script', 'text', 'text'),
        binding('out', 'images', 'image', 'images'),
        literal('out', 'metadata', { episode: 1 }),
      ],
    );
    const { engine } = runtime(value);
    const result = await engine.invoke({ runId: 'mixed', attemptId: 'a', inputs: {} });
    expect(result.status).toBe('succeeded');
    expect(result.outputCollections.out).toMatchObject({
      script: '结果 text',
      metadata: { episode: 1 },
      images: [{ assetId: 'asset-image' }],
    });
  });
});

describe('人工干预与运行版本', () => {
  const value = definition(
    [node('in', 'input'), generation('text'), node('review', 'review'), node('out', 'output')],
    [wire('in', 'text'), wire('text', 'review'), wire('review', 'out', 'approve')],
    [binding('review', 'value', 'text', 'text'), binding('out', 'result', 'review', 'value')],
  );

  it('暂停后可由新runtime实例恢复，不重复之前生成，并采用人工编辑值', async () => {
    const host = new TestHost();
    const checkpointer = new MemorySaver();
    const first = runtime(value, host, checkpointer).engine;
    const paused = await first.invoke({ runId: 'human', attemptId: 'a', inputs: {} });
    expect(paused.status).toBe('waiting');
    expect(host.tasks).toHaveLength(1);
    const resumed = await runtime(value, host, checkpointer).engine.resume({
      runId: 'human',
      attemptId: 'a',
      interruptId: paused.interrupts[0]!.id,
      response: {
        decision: 'approve',
        values: { value: '人工修改剧本' },
        idempotencyKey: 'approved',
      },
    });
    expect(resumed.status).toBe('succeeded');
    expect(resumed.outputCollections.out).toEqual({ result: '人工修改剧本' });
    expect(host.calls).toHaveLength(1);
  });

  it('恢复已完成的运行不再次生成，主动重新生成使用新的operationId', async () => {
    const { engine, host } = runtime(
      definition(
        [node('in', 'input'), generation('text'), node('out', 'output')],
        [wire('in', 'text'), wire('text', 'out')],
        [binding('out', 'result', 'text', 'text')],
      ),
    );
    await engine.invoke({ runId: 'regenerate', attemptId: 'v1', inputs: {} });
    await engine.recover({ runId: 'regenerate', attemptId: 'v1' });
    await engine.invoke({ runId: 'regenerate-new', attemptId: 'v2', inputs: {} });
    expect(host.calls).toHaveLength(2);
    expect(new Set(host.calls.map((call) => call.operationId)).size).toBe(2);
  });

  it('复用冻结上游与显式执行范围，只重新生成选中节点', async () => {
    const graph = definition(
      [node('in', 'input'), generation('text'), generation('after'), node('out', 'output')],
      [wire('in', 'text'), wire('text', 'after'), wire('after', 'out')],
      [binding('out', 'result', 'after', 'text')],
    );
    const { engine, host } = runtime(graph);
    const reusedResults: Record<string, NodeResult> = {
      in: { status: 'succeeded', outputs: { value: {} }, activePorts: ['out'] },
    };
    const result = await engine.invoke({
      runId: 'fork',
      attemptId: 'v2',
      inputs: {},
      reusedResults,
      executeNodeIds: ['text'],
    });
    expect(host.calls.map((call) => call.nodeId)).toEqual(['text']);
    expect(result.nodeResults.in?.reused).toBe(true);
    expect(result.nodeResults.after?.status).toBe('skipped');
  });

  it('并行人工任务可分别回复，剩余中断保持等待，错误interruptId被拒绝', async () => {
    const graph = definition(
      [node('in', 'input'), node('a', 'review'), node('b', 'review'), node('out', 'output')],
      [wire('in', 'a'), wire('in', 'b'), wire('a', 'out'), wire('b', 'out')],
      [
        literal('a', 'value', '剧本'),
        literal('b', 'value', '分镜'),
        binding('out', 'a', 'a', 'value'),
        binding('out', 'b', 'b', 'value'),
      ],
    );
    const { engine } = runtime(graph);
    const paused = await engine.invoke({ runId: 'parallel-human', attemptId: 'a', inputs: {} });
    expect(paused.interrupts).toHaveLength(2);
    await expect(
      engine.resume({
        runId: 'parallel-human',
        attemptId: 'a',
        interruptId: 'stale',
        response: { decision: 'approve', idempotencyKey: 'stale' },
      }),
    ).rejects.toMatchObject({ code: 'STALE_HUMAN_INTERRUPT' });
    const half = await engine.resume({
      runId: 'parallel-human',
      attemptId: 'a',
      interruptId: paused.interrupts[0]!.id,
      response: { decision: 'approve', idempotencyKey: 'first' },
    });
    expect(half.status).toBe('waiting');
    expect(half.interrupts).toHaveLength(1);
    const complete = await engine.resume({
      runId: 'parallel-human',
      attemptId: 'a',
      interruptId: half.interrupts[0]!.id,
      response: { decision: 'approve', idempotencyKey: 'second' },
    });
    expect(complete.status).toBe('succeeded');
    expect(complete.outputCollections.out).toEqual({ a: '剧本', b: '分镜' });
  });

  it('取消返回canceled并停止后继，缺失检查点恢复被拒绝', async () => {
    const { engine, host } = runtime(value);
    host.canceled = true;
    const result = await engine.invoke({ runId: 'canceled', attemptId: 'a', inputs: {} });
    expect(result.status).toBe('canceled');
    expect(host.calls).toHaveLength(0);
    await expect(engine.recover({ runId: 'missing', attemptId: 'a' })).rejects.toMatchObject({
      code: 'RUN_CHECKPOINT_MISSING',
    });
  });
  it('模型完成但节点记录失败后可恢复，宿主复用原operationId', async () => {
    class CrashOnceHost extends TestHost {
      crash = true;
      override async recordNodeResult(record: NodeRecord) {
        if (record.nodeId === 'text' && record.result.status === 'succeeded' && this.crash) {
          this.crash = false;
          throw new Error('模拟写入节点记录前进程退出');
        }
        await super.recordNodeResult(record);
      }
    }
    const host = new CrashOnceHost();
    const checkpointer = new MemorySaver();
    const graph = definition(
      [node('in', 'input'), generation('text'), node('out', 'output')],
      [wire('in', 'text'), wire('text', 'out')],
      [binding('out', 'result', 'text', 'text')],
    );
    await expect(
      runtime(graph, host, checkpointer).engine.invoke({
        runId: 'crash',
        attemptId: 'same-attempt',
        inputs: {},
      }),
    ).rejects.toThrow('模拟');
    const recovered = await runtime(graph, host, checkpointer).engine.recover({
      runId: 'crash',
      attemptId: 'same-attempt',
    });
    expect(recovered.status).toBe('succeeded');
    expect(host.calls).toHaveLength(1);
    expect(recovered.outputCollections.out).toEqual({ result: '结果 text' });
  });
});

describe('显式批量子图', () => {
  const batch = (items: JsonObject[string]) =>
    definition(
      [
        node('in', 'input'),
        node('batch', 'batch', {
          model,
          prompt: '按条目生成分镜',
          capability: 'text.generate',
          maxConcurrency: 2,
        }),
        node('out', 'output'),
      ],
      [wire('in', 'batch'), wire('batch', 'out')],
      [literal('batch', 'items', items), binding('out', 'result', 'batch', 'items')],
    );

  it('空批量直接收集空数组，不等待不存在的Send任务', async () => {
    const { engine, host } = runtime(batch([]));
    const result = await engine.invoke({ runId: 'empty', attemptId: 'a', inputs: {} });
    expect(result.status).toBe('succeeded');
    expect(result.outputCollections.out).toEqual({ result: [] });
    expect(host.calls).toHaveLength(0);
  });

  it('多个Send按原输入顺序汇合，每项有独立幂等操作标识', async () => {
    const { engine, host } = runtime(batch(['一', '二', '三']));
    const result = await engine.invoke({ runId: 'batch', attemptId: 'a', inputs: {} });
    expect(result.status).toBe('succeeded');
    expect(result.outputCollections.out).toEqual({
      result: [{ text: '结果 batch/0' }, { text: '结果 batch/1' }, { text: '结果 batch/2' }],
    });
    expect(new Set(host.calls.map((call) => call.operationId)).size).toBe(3);
    expect(host.calls.map((call) => call.input.item)).toEqual(['一', '二', '三']);
  });

  it('执行并发由LangGraph限制，不为批量另造调度器', async () => {
    class ConcurrentHost extends TestHost {
      active = 0;
      peak = 0;
      override async executeOperation(request: OperationRequest): Promise<JsonObject> {
        this.active++;
        this.peak = Math.max(this.peak, this.active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        const result = await super.executeOperation(request);
        this.active--;
        return result;
      }
    }
    const host = new ConcurrentHost();
    const { engine } = runtime(batch([1, 2, 3, 4, 5]), host);
    const result = await engine.invoke({ runId: 'bounded', attemptId: 'a', inputs: {} });
    expect(result.status).toBe('succeeded');
    expect(host.peak).toBe(2);
  });

  it('本地资产物化可恢复错误穿透batch，恢复复用各条目操作', async () => {
    class RecoverOnceHost extends TestHost {
      interrupted = false;
      override async executeOperation(request: OperationRequest): Promise<JsonObject> {
        const result = await super.executeOperation(request);
        if (request.itemId === '1' && !this.interrupted) {
          this.interrupted = true;
          throw Object.assign(new Error('待重试资产物化'), { code: 'OPERATION_RECOVERABLE' });
        }
        return result;
      }
    }
    const host = new RecoverOnceHost();
    const checkpointer = new MemorySaver();
    const graph = batch(['一', '二']);
    await expect(
      runtime(graph, host, checkpointer).engine.invoke({
        runId: 'recover-batch',
        attemptId: 'a',
        inputs: {},
      }),
    ).rejects.toMatchObject({ code: 'OPERATION_RECOVERABLE' });
    const result = await runtime(graph, host, checkpointer).engine.recover({
      runId: 'recover-batch',
      attemptId: 'a',
    });
    expect(result.status).toBe('succeeded');
    expect(host.calls).toHaveLength(2);
    expect(result.outputCollections.out).toEqual({
      result: [{ text: '结果 batch/0' }, { text: '结果 batch/1' }],
    });
  });
});

describe('发布校验', () => {
  it('联合依赖环、非控制可达、隐藏默认模型均被拒绝', () => {
    const cyclic = definition(
      [node('in', 'input'), generation('a'), generation('b'), node('out', 'output')],
      [wire('in', 'a'), wire('a', 'b'), wire('b', 'out')],
      [binding('a', 'context', 'b', 'text')],
    );
    expect(validateWorkflow(cyclic).issues.some((issue) => issue.code === 'DEPENDENCY_CYCLE')).toBe(
      true,
    );
    const unreachable = definition(
      [node('in', 'input'), node('out', 'output')],
      [],
      [binding('out', 'result', 'in', 'value')],
    );
    expect(
      validateWorkflow(unreachable).issues.some((issue) => issue.code === 'CONTROL_UNREACHABLE'),
    ).toBe(true);
    const missingModel = definition(
      [node('in', 'input'), node('text', 'text', { prompt: '剧本' }), node('out', 'output')],
      [wire('in', 'text'), wire('text', 'out')],
    );
    expect(validateWorkflow(missingModel).valid).toBe(false);
  });

  it('后继失效同时覆盖执行边和数据引用', () => {
    const graph = definition(
      [node('in', 'input'), generation('a'), generation('b'), node('out', 'output')],
      [wire('in', 'a'), wire('in', 'b'), wire('b', 'out')],
      [binding('b', 'context', 'a', 'text')],
    );
    expect(getInvalidatedNodeIds(graph, 'a')).toEqual(['a', 'b', 'out']);
  });
});
