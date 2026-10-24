import { describe, expect, it, vi } from 'vitest';
import {
  NumberType,
  StringType,
  type NodeDefinition,
  type WorkflowDefinition,
} from '@dramaflow/contracts';
import {
  ActionNodeCompilationStrategy,
  DefaultDataStoragePolicyResolver,
  DefaultNodeExecutor,
  DefaultRuntimeValueCodec,
  NodeRegistry,
  WorkflowPublishValidationError,
  createBindingResolver,
  createFormatTextNodeType,
  formatTextTemplateDefault,
  validateWorkflowForPublish,
  type CapabilityInvoker,
  type NodeExecutionContext,
} from '../src/index.js';
import { auditedNodeRunRepositoryFixture } from './node-run-fixture.js';

function node(template = formatTextTemplateDefault): NodeDefinition {
  return {
    id: 'format',
    type: 'data.format_text',
    typeVersion: 1,
    name: '格式化',
    inputs: {
      text: { type: 'constant', value: 'A' },
      index: { type: 'constant', value: 0 },
    },
    config: { template },
    ui: { position: { x: 0, y: 0 } },
  };
}

function definition(template = formatTextTemplateDefault): WorkflowDefinition {
  const current = node(template);
  return {
    inputs: [],
    nodes: [current],
    edges: [],
    outputs: [
      { name: 'text', type: StringType, source: { nodeId: current.id, outputKey: 'text' } },
    ],
  };
}

function fixture(template = formatTextTemplateDefault) {
  const current = node(template);
  const nodeType = createFormatTextNodeType();
  const execute = vi.spyOn(nodeType, 'execute');
  const registry = new NodeRegistry([nodeType]);
  const references = { resolve: vi.fn().mockRejectedValue(new Error('文本格式化不应读取引用')) };
  const artifacts = { write: vi.fn().mockRejectedValue(new Error('文本格式化不应写入 Artifact')) };
  const codec = new DefaultRuntimeValueCodec(
    references,
    artifacts,
    new DefaultDataStoragePolicyResolver(),
  );
  const nodeRuns = auditedNodeRunRepositoryFixture();
  const invoke = vi.fn<CapabilityInvoker['invoke']>();
  const executor = new DefaultNodeExecutor(registry, createBindingResolver(), codec, nodeRuns, {
    invoke,
  });
  const context: NodeExecutionContext = {
    scopeKey: 'root',
    projectId: 'project-a',
    workflowRunId: 'run-a',
    workflow: definition(template),
    capabilities: { invoke },
    state: {
      run: {
        projectId: 'project-a',
        workflowId: 'workflow-a',
        workflowVersionId: 'version-a',
        workflowRunId: 'run-a',
      },
      inputs: {},
      outputs: {},
      variables: {},
      execution: {},
    },
  };
  return {
    current,
    nodeType,
    execute,
    registry,
    references,
    artifacts,
    nodeRuns,
    invoke,
    executor,
    context,
  };
}

describe('data.format_text@1 正式 Action', () => {
  it('以普通 Action 注册，不声明 Provider 能力，并使用现有 Action 编译策略', () => {
    const f = fixture();
    const action = f.registry.getAction('data.format_text', 1);
    expect(action.manifest).toMatchObject({
      type: 'data.format_text',
      version: 1,
      executionKind: 'action',
      metadata: { category: 'data' },
      config: [{ key: 'template', defaultValue: '{{text}}-{{index}}' }],
    });
    expect(action.manifest.capabilities).toBeUndefined();
    expect(new ActionNodeCompilationStrategy().supports(action.manifest)).toBe(true);
    expect(f.registry.listManifests().map((item) => item.type)).toEqual(['data.format_text']);
  });

  it('Publish 接受合法模板，非法模板在配置校验失败', () => {
    const registry = new NodeRegistry([createFormatTextNodeType()]);
    expect(validateWorkflowForPublish(definition(), registry)).toMatchObject([
      { node: { id: 'format', type: 'data.format_text' } },
    ]);
    expect(() => validateWorkflowForPublish(definition('{{caption}}'), registry)).toThrow(
      WorkflowPublishValidationError,
    );
    expect(() => validateWorkflowForPublish(definition('{{caption}}'), registry)).toThrow(
      expect.objectContaining({ code: 'NODE_CONFIG_INVALID', nodeId: 'format' }),
    );
  });

  it('经 Binding、Codec 和 Executor 得到 A-0，NodeRun 完成且不调用 Provider', async () => {
    const f = fixture();
    const result = await f.executor.execute(f.current, f.context);
    expect(result).toEqual({
      output: { text: { storage: 'inline', type: StringType, value: 'A-0' } },
    });
    expect(f.execute).toHaveBeenCalledOnce();
    expect(f.execute.mock.calls[0]?.[0]).toEqual({ text: 'A', index: 0 });
    expect(f.execute.mock.calls[0]?.[1]).toEqual({ template: '{{text}}-{{index}}' });
    expect(f.nodeRuns.getRecords()).toEqual([
      expect.objectContaining({
        nodeId: 'format',
        attempt: 1,
        status: 'completed',
        inputs: {
          text: { storage: 'inline', type: StringType, value: 'A' },
          index: { storage: 'inline', type: NumberType, value: 0 },
        },
        outputs: { text: { storage: 'inline', type: StringType, value: 'A-0' } },
      }),
    ]);
    expect(f.invoke).not.toHaveBeenCalled();
    expect(f.references.resolve).not.toHaveBeenCalled();
    expect(f.artifacts.write).not.toHaveBeenCalled();
  });

  it('重复变量、多变量和空字符串仍只做确定性替换', async () => {
    const repeated = fixture('{{index}}:{{text}}/{{text}}');
    await expect(repeated.executor.execute(repeated.current, repeated.context)).resolves.toEqual({
      output: { text: { storage: 'inline', type: StringType, value: '0:A/A' } },
    });
    const empty = fixture();
    empty.current.inputs.text = { type: 'constant', value: '' };
    await expect(empty.executor.execute(empty.current, empty.context)).resolves.toEqual({
      output: { text: { storage: 'inline', type: StringType, value: '-0' } },
    });
    expect(repeated.invoke).not.toHaveBeenCalled();
    expect(empty.invoke).not.toHaveBeenCalled();
  });

  it('未知变量和非法模板在 validate_config 失败，不执行、不完成 NodeRun', async () => {
    for (const template of ['{{caption}}', '{{text}', '{{}}']) {
      const f = fixture(template);
      await expect(f.executor.execute(f.current, f.context)).rejects.toMatchObject({
        stage: 'validate_config',
        code: 'NODE_CONFIG_VALIDATION_FAILED',
      });
      expect(f.execute).not.toHaveBeenCalled();
      expect(f.invoke).not.toHaveBeenCalled();
      expect(f.nodeRuns.getRecords()).toEqual([
        expect.objectContaining({
          status: 'failed',
          error: expect.objectContaining({ stage: 'validate_config' }),
        }),
      ]);
    }
  });

  it('输入不符合 schema 时在 validate_input 失败，输出不符合 schema 时不记成功', async () => {
    const invalidInput = fixture();
    invalidInput.current.inputs.text = { type: 'constant', value: 1 };
    await expect(
      invalidInput.executor.execute(invalidInput.current, invalidInput.context),
    ).rejects.toMatchObject({ stage: 'validate_input', code: 'NODE_INPUT_VALIDATION_FAILED' });
    expect(invalidInput.execute).not.toHaveBeenCalled();
    expect(invalidInput.invoke).not.toHaveBeenCalled();

    const invalidOutput = fixture();
    invalidOutput.execute.mockResolvedValueOnce({ text: 1 } as never);
    await expect(
      invalidOutput.executor.execute(invalidOutput.current, invalidOutput.context),
    ).rejects.toMatchObject({ stage: 'validate_output', code: 'NODE_OUTPUT_VALIDATION_FAILED' });
    expect(invalidOutput.nodeRuns.getRecords()[0]?.status).toBe('failed');
    expect(invalidOutput.invoke).not.toHaveBeenCalled();
    expect(invalidOutput.artifacts.write).not.toHaveBeenCalled();
  });
});
