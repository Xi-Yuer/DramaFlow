import { describe, expect, it, vi } from 'vitest';
import { StringType, type NodeDefinition } from '@dramaflow/contracts';
import {
  createBindingResolver,
  createTextGenerationNodeType,
  DefaultDataStoragePolicyResolver,
  DefaultNodeExecutor,
  DefaultRuntimeValueCodec,
  NodeRegistry,
  type CapabilityInvoker,
  type NodeExecutionContext,
} from '../src/index.js';
import { nodeRunRepositoryFixture } from './node-run-fixture.js';

const modelConfigurationId = 'da054b80-9d86-4d23-a1c9-31bc416f91f1';

function fixture() {
  const node: NodeDefinition = {
    id: 'opening',
    type: 'ai.text_generate',
    typeVersion: 1,
    name: '开场对白',
    inputs: {
      prompt: { type: 'workflow_input', key: 'prompt' },
      system: { type: 'constant', value: '使用中文' },
    },
    config: { modelConfigurationId },
    ui: { position: { x: 0, y: 0 } },
  };
  const nodeType = createTextGenerationNodeType();
  const registry = new NodeRegistry([nodeType]);
  const bindings = createBindingResolver();
  const references = { resolve: vi.fn().mockRejectedValue(new Error('文本输入不应读取引用')) };
  const artifacts = { write: vi.fn().mockRejectedValue(new Error('文本输出不应写入 Artifact')) };
  const codec = new DefaultRuntimeValueCodec(
    references,
    artifacts,
    new DefaultDataStoragePolicyResolver(),
  );
  const nodeRuns = nodeRunRepositoryFixture();
  const invoke = vi.fn<CapabilityInvoker['invoke']>().mockResolvedValue({ text: '你好。' });
  const makeExecutor = (capabilities?: CapabilityInvoker) =>
    new DefaultNodeExecutor(registry, bindings, codec, nodeRuns, capabilities);
  const context: NodeExecutionContext = {
    projectId: 'project-a',
    workflowRunId: 'run-a',
    workflow: {
      inputs: [{ name: 'prompt', type: StringType }],
      nodes: [node],
      edges: [],
      outputs: [],
    },
    state: {
      run: {
        projectId: 'project-a',
        workflowId: 'workflow-a',
        workflowVersionId: 'version-a',
        workflowRunId: 'run-a',
      },
      inputs: { prompt: { storage: 'inline', type: StringType, value: '编写开场对白' } },
      outputs: {},
      variables: {},
      execution: {},
    },
  };
  return {
    node,
    nodeType,
    registry,
    references,
    artifacts,
    nodeRuns,
    invoke,
    makeExecutor,
    context,
  };
}

describe('正式文本 AI Node 的 Runtime 连接', () => {
  it('通过真实 Registry / Binding / Codec / Executor，调用明确能力并记录 RuntimeValue 输入输出', async () => {
    const f = fixture();
    const snapshot = structuredClone({ node: f.node, state: f.context.state });
    expect(f.registry.getAction('ai.text_generate', 1).manifest.capabilities).toEqual([
      { type: 'text.generate' },
    ]);
    const result = await f.makeExecutor({ invoke: f.invoke }).execute(f.node, f.context);
    expect(f.invoke).toHaveBeenCalledExactlyOnceWith('text.generate', {
      modelConfigurationId,
      input: { prompt: '编写开场对白', system: '使用中文' },
    });
    expect(result).toEqual({
      output: { text: { storage: 'inline', type: StringType, value: '你好。' } },
    });
    expect(f.nodeRuns.updateInputs).toHaveBeenCalledExactlyOnceWith('node-run-1', {
      prompt: { storage: 'inline', type: StringType, value: '编写开场对白' },
      system: { storage: 'inline', type: StringType, value: '使用中文' },
    });
    expect(f.nodeRuns.markCompleted).toHaveBeenCalledExactlyOnceWith('node-run-1', result.output);
    expect(f.nodeRuns.markFailed).not.toHaveBeenCalled();
    expect(f.references.resolve).not.toHaveBeenCalled();
    expect(f.artifacts.write).not.toHaveBeenCalled();
    expect({ node: f.node, state: f.context.state }).toEqual(snapshot);
  });

  it('允许省略 system，缺少 prompt 在 validate_input 失败，能力不会被调用', async () => {
    const f = fixture();
    f.node.inputs = { prompt: f.node.inputs.prompt! };
    await f.makeExecutor({ invoke: f.invoke }).execute(f.node, f.context);
    expect(f.invoke).toHaveBeenCalledExactlyOnceWith('text.generate', {
      modelConfigurationId,
      input: { prompt: '编写开场对白' },
    });
    f.invoke.mockClear();
    f.node.inputs = {};
    await expect(
      f.makeExecutor({ invoke: f.invoke }).execute(f.node, f.context),
    ).rejects.toMatchObject({
      stage: 'validate_input',
    });
    expect(f.invoke).not.toHaveBeenCalled();
  });

  it.each(['apiKey', 'secret', 'baseURL', 'model', 'provider'])(
    '严格拒绝节点配置中的 %s，不能把凭证或厂商配置混入 Workflow',
    async (field) => {
      const f = fixture();
      f.node.config = { modelConfigurationId, [field]: 'untrusted-value' };
      await expect(
        f.makeExecutor({ invoke: f.invoke }).execute(f.node, f.context),
      ).rejects.toMatchObject({
        stage: 'validate_config',
      });
      expect(f.invoke).not.toHaveBeenCalled();
      expect(f.nodeRuns.markFailed).toHaveBeenCalledWith(
        'node-run-1',
        expect.objectContaining({ stage: 'validate_config' }),
      );
    },
  );

  it.each<Record<string, string>>([{}, { modelConfigurationId: 'not-a-uuid' }])(
    '未明确选择有效模型配置时，在调用外部能力前失败：%j',
    async (config) => {
      const f = fixture();
      f.node.config = config;
      await expect(
        f.makeExecutor({ invoke: f.invoke }).execute(f.node, f.context),
      ).rejects.toMatchObject({ stage: 'validate_config' });
      expect(f.invoke).not.toHaveBeenCalled();
      expect(f.nodeRuns.markCompleted).not.toHaveBeenCalled();
    },
  );

  it('没有能力 Invoker 时明确失败，并沿 NodeRun 的 execute 阶段记录', async () => {
    const f = fixture();
    await expect(f.makeExecutor().execute(f.node, f.context)).rejects.toMatchObject({
      stage: 'execute',
      cause: { code: 'CAPABILITY_NOT_CONFIGURED', message: '文本生成能力未配置' },
    });
    expect(f.nodeRuns.markCompleted).not.toHaveBeenCalled();
    expect(f.nodeRuns.markFailed).toHaveBeenCalledWith(
      'node-run-1',
      expect.objectContaining({ stage: 'execute', code: 'NODE_EXECUTION_FAILED' }),
    );
  });

  it('生产注入的 Invoker 优先于调用上下文，不允许外来上下文替换已授权能力', async () => {
    const f = fixture();
    const foreignInvoke = vi.fn().mockResolvedValue({ text: '外来结果' });
    await f.makeExecutor({ invoke: f.invoke }).execute(f.node, {
      ...f.context,
      capabilities: { invoke: foreignInvoke },
    });
    expect(f.invoke).toHaveBeenCalledTimes(1);
    expect(foreignInvoke).not.toHaveBeenCalled();
  });

  it('原有四参数 Executor 仍可使用显式上下文能力', async () => {
    const f = fixture();
    await f.makeExecutor().execute(f.node, { ...f.context, capabilities: { invoke: f.invoke } });
    expect(f.invoke).toHaveBeenCalledTimes(1);
  });

  it('模型调用失败沿 execute 传播，NodeRun 不保存供应商原始错误或秘密', async () => {
    const f = fixture();
    f.invoke.mockRejectedValue(new Error('credential-and-provider-body-marker'));
    await expect(
      f.makeExecutor({ invoke: f.invoke }).execute(f.node, f.context),
    ).rejects.toMatchObject({
      stage: 'execute',
      code: 'NODE_EXECUTION_FAILED',
    });
    expect(f.nodeRuns.markCompleted).not.toHaveBeenCalled();
    expect(JSON.stringify(f.nodeRuns.markFailed.mock.calls)).not.toContain(
      'credential-and-provider-body-marker',
    );
    expect(f.nodeRuns.markFailed).toHaveBeenCalledWith(
      'node-run-1',
      expect.objectContaining({ stage: 'execute' }),
    );
  });

  it('模板在输入解析后把渲染字符串交给文本节点', async () => {
    const f = fixture();
    f.node.inputs = {
      prompt: {
        type: 'template',
        value: '请根据 {{outline}} 和 {{characters}} 生成剧本',
        variables: {
          outline: { type: 'node_output', nodeId: 'outline', portKey: 'text' },
          characters: { type: 'node_output', nodeId: 'characters', portKey: 'text' },
        },
      },
      system: {
        type: 'template',
        value: '风格：{{style}}',
        variables: { style: { type: 'workflow_input', key: 'style' } },
      },
    };
    await f.makeExecutor({ invoke: f.invoke }).execute(f.node, {
      ...f.context,
      state: {
        ...f.context.state,
        inputs: { style: { storage: 'inline', type: StringType, value: '简洁' } },
        outputs: {
          outline: { text: { storage: 'inline', type: StringType, value: '第一幕' } },
          characters: { text: { storage: 'inline', type: StringType, value: '阿青' } },
        },
      },
    });
    expect(f.invoke).toHaveBeenCalledExactlyOnceWith('text.generate', {
      modelConfigurationId,
      input: { prompt: '请根据 第一幕 和 阿青 生成剧本', system: '风格：简洁' },
    });
    expect(f.nodeRuns.updateInputs).toHaveBeenCalledExactlyOnceWith('node-run-1', {
      prompt: {
        storage: 'inline',
        type: StringType,
        value: '请根据 第一幕 和 阿青 生成剧本',
      },
      system: { storage: 'inline', type: StringType, value: '风格：简洁' },
    });
    expect(f.references.resolve).not.toHaveBeenCalled();
    expect(f.artifacts.write).not.toHaveBeenCalled();
  });

  it('能力返回非法业务输出时由 Executor 的 outputSchema 拒绝，不记录成功或部分输出', async () => {
    const f = fixture();
    f.invoke.mockResolvedValue({ text: 42 });
    await expect(
      f.makeExecutor({ invoke: f.invoke }).execute(f.node, f.context),
    ).rejects.toMatchObject({
      stage: 'validate_output',
    });
    expect(f.nodeRuns.markCompleted).not.toHaveBeenCalled();
    expect(f.nodeRuns.markFailed).toHaveBeenCalledWith(
      'node-run-1',
      expect.objectContaining({ stage: 'validate_output' }),
    );
  });
});
