import { describe, expect, it, vi } from 'vitest';
import { MemorySaver } from '@langchain/langgraph';
import {
  StringType,
  humanReviewInterruptPayloadV1Schema,
  workflowDraftDefinitionSchema,
  type WorkflowDefinition,
  type WorkflowRun,
} from '@dramaflow/contracts';
import {
  createHumanReviewNodeType,
  createHumanReviewInterruptPayload,
  humanReviewOutputFromDecision,
  createIfNodeType,
  createTextGenerationNodeType,
  NodeRegistry,
  DefaultWorkflowCompiler,
  validateWorkflowForPublish,
} from '../../../src/index.js';

function registry() {
  return new NodeRegistry([
    createTextGenerationNodeType(),
    createIfNodeType(),
    createHumanReviewNodeType(),
  ]);
}
function workflow(): WorkflowDefinition {
  return {
    inputs: [],
    nodes: [
      {
        id: 'review',
        type: 'flow.human_review',
        typeVersion: 1,
        name: '核对人物设定',
        inputs: { content: { type: 'constant', value: '原文' } },
        config: {},
        ui: { position: { x: 0, y: 0 } },
      },
    ],
    edges: [],
    outputs: [],
  };
}
const run: WorkflowRun = {
  id: 'run',
  workflowId: 'workflow',
  workflowVersionId: 'version',
  projectId: 'project',
  threadId: 'thread',
  invocationKey: 'invocation',
  inputs: {},
  status: 'running',
  createdAt: '2026-10-23T00:00:00.000Z',
  startedAt: '2026-10-23T00:00:00.000Z',
};

describe('正式 Human Review 声明与纯业务转换', () => {
  it('Registry 按精确版本注册 interaction，无 execute、分支出口或能力调用', () => {
    const types = registry();
    const node = types.get('flow.human_review', 1);
    expect(node.manifest.executionKind).toBe('interaction');
    expect(node).not.toHaveProperty('execute');
    expect(node.manifest.controlOutputs).toBeUndefined();
    expect(node.manifest.capabilities).toBeUndefined();
    expect(() => types.getAction('flow.human_review', 1)).toThrow('不是普通');
    expect(() => types.get('flow.human_review', 2)).toThrow('不可用');
    expect(() => types.register(createHumanReviewNodeType())).toThrow('已注册');
    expect(types.getAction('ai.text_generate', 1).manifest.executionKind).toBe('action');
    expect(types.get('flow.if', 1).manifest.executionKind).toBe('control');
  });
  it('Manifest 与严格输入、配置、输出 Schema 一致，未增加 title 或 approved', () => {
    const node = createHumanReviewNodeType();
    expect(node.manifest.inputs).toEqual([
      { key: 'content', name: '待审核内容', dataType: StringType, required: true },
    ]);
    expect(node.manifest.config).toEqual([
      { key: 'instruction', name: '审核说明', type: 'string', required: false },
    ]);
    expect(node.configSchema.parse({})).toEqual({});
    expect(node.configSchema.safeParse({ instruction: 1 }).success).toBe(false);
    expect(node.inputSchema.safeParse({}).success).toBe(false);
    expect(node.manifest.outputs.map((port) => [port.key, port.dataType])).toEqual([
      ['content', StringType],
      ['action', StringType],
      ['feedback', StringType],
    ]);
    expect(() => new NodeRegistry([{ ...node, execute: vi.fn(async () => ({})) }])).toThrow(
      '其他执行种类',
    );
  });
  it.each(['approve', 'reject'])(
    '%s 正常转换，content 原样透传，缺省 feedback 为字符串空值',
    (action) => {
      const input = { content: '  原文\n第二行\r\n  ' };
      const decision = { action };
      const snapshot = structuredClone({ input, decision });
      expect(humanReviewOutputFromDecision(input, decision)).toEqual({
        content: input.content,
        action,
        feedback: '',
      });
      expect({ input, decision }).toEqual(snapshot);
      expect(
        humanReviewOutputFromDecision({ content: '' }, { action, feedback: '  修改意见\n' }),
      ).toEqual({ content: '', action, feedback: '  修改意见\n' });
    },
  );
  it.each([
    { action: 'comment' },
    { action: 'reject', feedback: null },
    { action: 'approve', approved: true },
  ])('纯完成边界拒绝非法 decision %j', (decision) => {
    expect(() => humanReviewOutputFromDecision({ content: '原文' }, decision)).toThrow();
  });
  it('input + config 构造准确的 inline string payload，不注入身份、不改变调用方', () => {
    const input = { content: ' 原文\n' };
    const config = { instruction: '请核对 {{content}}' };
    const payload = createHumanReviewInterruptPayload('review', input, config);
    expect(payload).toEqual({
      kind: 'human_review',
      schemaVersion: 1,
      nodeId: 'review',
      content: { storage: 'inline', type: StringType, value: input.content },
      instruction: config.instruction,
    });
    expect(humanReviewInterruptPayloadV1Schema.parse(JSON.parse(JSON.stringify(payload)))).toEqual(
      payload,
    );
    expect(createHumanReviewInterruptPayload('review', input, {})).not.toHaveProperty(
      'instruction',
    );
    expect(
      createHumanReviewInterruptPayload('review', input, { instruction: '' }).instruction,
    ).toBe('');
    expect(input).toEqual({ content: ' 原文\n' });
    expect(config).toEqual({ instruction: '请核对 {{content}}' });
  });
  it('V1 纯业务边界拒绝 reference、非文本、非法 nodeId 或模板配置对象', () => {
    const reference = {
      storage: 'reference',
      type: StringType,
      reference: { kind: 'artifact', id: 'artifact_1' },
    };
    for (const content of [reference, 1, null, new Uint8Array([1])]) {
      expect(() => createHumanReviewInterruptPayload('review', { content }, {})).toThrow();
      expect(() => humanReviewOutputFromDecision({ content }, { action: 'approve' })).toThrow();
    }
    expect(() => createHumanReviewInterruptPayload('', { content: '原文' }, {})).toThrow();
    expect(() =>
      createHumanReviewInterruptPayload(
        'review',
        { content: '原文' },
        { instruction: { type: 'template', value: '{{x}}' } },
      ),
    ).toThrow();
  });
  it('Draft 保留现有 DataEdge / Template / Candidate 的输入表达，不新增 Binding 模式', () => {
    for (const mode of ['data', 'template', 'candidate']) {
      const definition = workflow();
      definition.nodes.unshift(
        ...['a', 'b'].map((id) => ({
          ...structuredClone(definition.nodes[0]!),
          id,
          type: 'ai.text_generate',
          inputs: {},
          config: {},
        })),
      );
      const target = definition.nodes[2]!;
      if (mode === 'data') {
        target.inputs = {};
        definition.edges.push({
          id: 'data',
          kind: 'data',
          source: { nodeId: 'a', portKey: 'text' },
          target: { nodeId: 'review', portKey: 'content' },
        });
      } else if (mode === 'template')
        target.inputs.content = {
          type: 'template',
          value: '参考 {{text}}',
          variables: { text: { type: 'node_output', nodeId: 'a', portKey: 'text' } },
        };
      else
        target.inputs.content = {
          type: 'candidate',
          sources: ['a', 'b'].map((nodeId) => ({ type: 'node_output', nodeId, portKey: 'text' })),
        };
      expect(workflowDraftDefinitionSchema.parse(JSON.parse(JSON.stringify(definition)))).toEqual(
        definition,
      );
    }
  });
  it.each(['type', 'version', 'kind'] as const)(
    '未知 interaction %s 仍在创建服务前拒绝',
    async (variant) => {
      const declaration = createHumanReviewNodeType();
      if (variant === 'type') declaration.manifest.type = 'test.interaction';
      if (variant === 'version') declaration.manifest.version = 2;
      if (variant === 'kind') declaration.manifest.executionKind = 'composite';
      const types = new NodeRegistry([declaration]);
      const definition = workflow();
      definition.nodes[0]!.type = declaration.manifest.type;
      definition.nodes[0]!.typeVersion = declaration.manifest.version;
      expect(() => validateWorkflowForPublish(definition, types)).toThrow(
        expect.objectContaining({ code: 'NODE_EXECUTION_KIND_UNSUPPORTED', nodeId: 'review' }),
      );
      const createExecutor = vi.fn(async () => {
        throw new Error('不能创建执行服务');
      });
      const createValueServices = vi.fn(async () => {
        throw new Error('不能创建值服务');
      });
      const compiler = new DefaultWorkflowCompiler(
        types,
        createExecutor,
        new MemorySaver(),
        createValueServices,
      );
      await expect(compiler.compile(definition, run)).rejects.toMatchObject({
        code: 'NODE_EXECUTION_KIND_UNSUPPORTED',
        nodeId: 'review',
      });
      expect(createExecutor).not.toHaveBeenCalled();
      expect(createValueServices).not.toHaveBeenCalled();
    },
  );
});
