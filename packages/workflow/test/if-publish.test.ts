import { describe, expect, it, vi } from 'vitest';
import { LogicEngine } from 'json-logic-engine';
import { z } from 'zod';
import {
  NumberType,
  StringType,
  workflowDefinitionSchema,
  type WorkflowDefinition,
  type ConditionExpression,
} from '@dramaflow/contracts';
import {
  createIfNodeType,
  createTextGenerationNodeType,
  NodeRegistry,
  validateWorkflowDefinitionSemantics,
  validateWorkflowForPublish,
} from '../src/index.js';

function registry() {
  return new NodeRegistry([createTextGenerationNodeType(), createIfNodeType()]);
}
function definition(): WorkflowDefinition {
  return {
    inputs: [{ name: 'value', type: StringType, required: true }],
    nodes: [
      {
        id: 'if_1',
        type: 'flow.if',
        typeVersion: 1,
        name: '条件',
        inputs: { value: { type: 'workflow_input', key: 'value' } },
        config: { condition: { '===': [{ var: 'value' }, 'Approved '] } },
        ui: { position: { x: 0, y: 0 } },
      },
      ...['B', 'C'].map((id) => ({
        id,
        type: 'ai.text_generate',
        typeVersion: 1,
        name: id,
        inputs: { prompt: { type: 'constant' as const, value: '写作' } },
        config: { modelConfigurationId: '00000000-0000-4000-8000-000000000001' },
        ui: { position: { x: 0, y: 0 } },
      })),
    ],
    edges: [
      {
        id: 'true',
        kind: 'control',
        source: { nodeId: 'if_1', portKey: 'true' },
        target: { nodeId: 'B' },
      },
      {
        id: 'false',
        kind: 'control',
        source: { nodeId: 'if_1', portKey: 'false' },
        target: { nodeId: 'C' },
      },
    ],
    outputs: [],
  };
}
function check(input = definition(), types = registry()) {
  return validateWorkflowDefinitionSemantics(workflowDefinitionSchema.parse(input), types);
}
function rejects(mutate: (definition: WorkflowDefinition) => void, code: string) {
  const graph = definition();
  mutate(graph);
  expect(() => check(graph)).toThrow(expect.objectContaining({ code }));
}

describe('flow.if@1 协议与发布阶段门禁', () => {
  it('候选精确覆盖同一 If 的两个终端分支，顺序无优先级', () => {
    for (const ids of [
      ['B', 'C'],
      ['C', 'B'],
    ]) {
      const d = definition();
      d.outputs = [
        {
          name: 'result',
          type: StringType,
          sources: ids.map((nodeId) => ({ nodeId, outputKey: 'text' })),
        },
      ];
      expect(
        validateWorkflowForPublish(workflowDefinitionSchema.parse(d), registry()),
      ).toHaveLength(3);
    }
  });
  it.each(['single', 'unrelated', 'same-branch', 'other-if', 'missing-port', 'type', 'no-if'])(
    '拒绝不安全候选：%s',
    (kind) => {
      const d = definition();
      d.nodes.push({ ...d.nodes[1]!, id: 'D' });
      const sources = [
        { nodeId: 'B', outputKey: 'text' },
        { nodeId: 'C', outputKey: 'text' },
      ];
      d.outputs = [{ name: 'result', type: StringType, sources }];
      let types = registry();
      let code = 'CONDITIONAL_WORKFLOW_OUTPUT_UNSUPPORTED';
      if (kind === 'single')
        d.outputs = [{ name: 'result', type: StringType, source: sources[0]! }];
      if (kind === 'unrelated') sources[1]!.nodeId = 'D';
      if (kind === 'same-branch') {
        const text = createTextGenerationNodeType();
        types = new NodeRegistry([
          createIfNodeType(),
          {
            ...text,
            manifest: {
              ...text.manifest,
              outputs: [
                ...text.manifest.outputs,
                { key: 'other', name: '另一输出', dataType: StringType },
              ],
            },
            outputSchema: z.object({ text: z.string(), other: z.string() }),
          },
        ]);
        sources[1] = { nodeId: 'B', outputKey: 'other' };
      }
      if (kind === 'other-if') {
        d.nodes.push({ ...d.nodes[0]!, id: 'if_2' }, { ...d.nodes[1]!, id: 'E' });
        d.edges.push(
          {
            id: 'other-true',
            kind: 'control',
            source: { nodeId: 'if_2', portKey: 'true' },
            target: { nodeId: 'D' },
          },
          {
            id: 'other-false',
            kind: 'control',
            source: { nodeId: 'if_2', portKey: 'false' },
            target: { nodeId: 'E' },
          },
        );
        sources[1]!.nodeId = 'D';
      }
      if (kind === 'missing-port') {
        sources[1]!.outputKey = 'missing';
        code = 'OUTPUT_PORT_NOT_FOUND';
      }
      if (kind === 'type') {
        d.outputs[0]!.type = NumberType;
        code = 'WORKFLOW_OUTPUT_TYPE_MISMATCH';
      }
      if (kind === 'no-if') {
        d.nodes = d.nodes.filter((node) => node.id !== 'if_1');
        d.edges = [];
      }
      expect(() => validateWorkflowForPublish(workflowDefinitionSchema.parse(d), types)).toThrow(
        expect.objectContaining({ code }),
      );
    },
  );
  it('精确注册 control，无 Action execute、无 matched 或其他业务输出', () => {
    const entry = registry().get('flow.if', 1);
    expect(entry.manifest).toMatchObject({
      type: 'flow.if',
      version: 1,
      executionKind: 'control',
      inputs: [{ key: 'value', dataType: StringType, required: true }],
      outputs: [],
      controlOutputs: [{ key: 'true' }, { key: 'false' }],
    });
    expect(entry.execute).toBeUndefined();
    expect(() => registry().getAction('flow.if', 1)).toThrow();
    expect(entry.outputSchema.parse({})).toEqual({});
    expect(entry.outputSchema.safeParse({ matched: true }).success).toBe(false);
  });
  it('true/false 按 Manifest 静态识别，配置与字符串不转换、trim 或注入默认值', () => {
    const graph = definition();
    const original = structuredClone(graph);
    expect(check(graph)).toHaveLength(3);
    expect(graph).toEqual(original);
    const entry = createIfNodeType();
    expect(entry.inputSchema.parse({ value: ' Approved ' })).toEqual({ value: ' Approved ' });
    const condition = { '!==': [{ var: 'value' }, 'Approved '] };
    expect(entry.configSchema.parse({ condition })).toEqual({ condition });
    expect(entry.inputSchema.parse({ value: '' })).toEqual({ value: '' });
    expect(
      entry.configSchema.safeParse({ condition: { '===': [{ var: 'value' }, ''] } }).success,
    ).toBe(true);
  });
  it.each([undefined, 0, false, null, [], {}].map((value) => ({ value })))(
    'value=$value 不能默认为 false',
    ({ value }) => {
      expect(createIfNodeType().inputSchema.safeParse({ value }).success).toBe(false);
      rejects((graph) => {
        graph.nodes[0]!.inputs.value = { type: 'constant', value: value ?? null };
      }, 'INPUT_VALUE_INVALID');
    },
  );
  const invalidConfigs: WorkflowDefinition['nodes'][number]['config'][] = [
    {},
    { operator: 'equals' },
    { expected: 'x' },
    { operator: 'contains', expected: 'x' },
    { operator: 'EQUALS', expected: 'x' },
    { operator: 'equals', expected: false },
    { operator: 'equals', expected: 0 },
    { operator: 'equals', expected: null },
    { operator: 'equals', expected: 'x', extra: true },
    { condition: null },
    { condition: {} },
    { condition: { '>': [{ var: 'value' }, 1] } },
    { condition: { '===': [{ var: 'credential' }, 'x'] } },
    { condition: { '===': [{ var: 'foo.bar' }, 'x'] } },
    { condition: { and: [{ '===': [{ var: 'value' }, 'x'] }] } },
    { condition: { '===': [{ var: 'value' }, false] } },
    { condition: { '===': [{ var: 'value' }, 'x'] }, expected: 'x' },
  ];
  it.each(invalidConfigs)('拒绝无效配置 %j', (config) =>
    rejects((graph) => {
      graph.nodes[0]!.config = config;
    }, 'NODE_CONFIG_INVALID'),
  );
  it('Publish 只验证 condition，不求值；四种表达式和复杂度限制共用协议，门禁仍保留', () => {
    const run = vi.spyOn(LogicEngine.prototype, 'run');
    try {
      const conditions: ConditionExpression[] = [
        { '===': [{ var: 'value' }, 'x'] },
        { '!==': [{ var: 'value' }, 'x'] },
        { in: ['x', { var: 'value' }] },
        { '!': { in: ['x', { var: 'value' }] } },
      ];
      for (const condition of conditions) {
        const graph = definition();
        graph.nodes[0]!.config = { condition };
        expect(check(graph)).toHaveLength(3);
        expect(validateWorkflowForPublish(graph, registry())).toHaveLength(3);
      }
      let deep: WorkflowDefinition['nodes'][number]['config'][string] = {
        in: ['x', { var: 'value' }],
      };
      for (let index = 0; index < 20; index++) deep = { '!': deep };
      rejects((graph) => {
        graph.nodes[0]!.config = { condition: deep };
      }, 'NODE_CONFIG_INVALID');
      rejects((graph) => {
        graph.nodes[0]!.config = { condition: { in: Array.from({ length: 40 }, () => 'x') } };
      }, 'NODE_CONFIG_INVALID');
      expect(run).not.toHaveBeenCalled();
    } finally {
      run.mockRestore();
    }
  });
  it('沿用必填、Workflow Input、Template 和 DataEdge 的 string 规则', () => {
    rejects((graph) => {
      graph.nodes[0]!.inputs = {};
    }, 'INPUT_SOURCE_MISSING');
    rejects((graph) => {
      graph.inputs[0]!.required = false;
    }, 'INPUT_SOURCE_OPTIONAL');
    rejects((graph) => {
      graph.inputs[0]!.type = NumberType;
    }, 'INPUT_TYPE_MISMATCH');
    const graph = definition();
    graph.nodes[0]!.inputs.value = {
      type: 'template',
      value: '{{x}}',
      variables: { x: { type: 'workflow_input', key: 'value' } },
    };
    expect(check(graph)).toHaveLength(3);
    graph.nodes.push({ ...graph.nodes[1]!, id: 'A' });
    graph.nodes[0]!.inputs = {};
    graph.edges.push({
      id: 'value',
      kind: 'data',
      source: { nodeId: 'A', portKey: 'text' },
      target: { nodeId: 'if_1', portKey: 'value' },
    });
    expect(check(graph)).toHaveLength(4);
    const text = createTextGenerationNodeType();
    const types = new NodeRegistry([
      {
        ...text,
        manifest: {
          ...text.manifest,
          outputs: [{ key: 'text', name: '数字', dataType: NumberType }],
        },
      },
      createIfNodeType(),
    ]);
    expect(() => check(graph, types)).toThrow(
      expect.objectContaining({ code: 'INPUT_TYPE_MISMATCH' }),
    );
  });
  it.each(['maybe', 'other'])('未声明出口 %s 拒绝', (portKey) =>
    rejects((graph) => {
      graph.edges[0]!.source.portKey = portKey;
    }, 'NAMED_CONTROL_PORT_UNSUPPORTED'),
  );
  it('If 无名称出口、目标命名控制输入及 Action 未声明出口均拒绝', () => {
    rejects((graph) => {
      delete graph.edges[0]!.source.portKey;
    }, 'CONTROL_OUTPUT_PORT_REQUIRED');
    rejects((graph) => {
      graph.edges[0]!.target.portKey = 'true';
    }, 'NAMED_CONTROL_PORT_UNSUPPORTED');
    rejects((graph) => {
      graph.edges.push({
        id: 'action',
        kind: 'control',
        source: { nodeId: 'B', portKey: 'xxx' },
        target: { nodeId: 'C' },
      });
    }, 'NAMED_CONTROL_PORT_UNSUPPORTED');
  });
  it.each(['true', 'false'])('缺少 %s 分支拒绝', (branch) =>
    rejects((graph) => {
      graph.edges = graph.edges.filter((edge) => edge.source.portKey !== branch);
    }, 'CONTROL_OUTPUT_BRANCH_MISSING'),
  );
  it('不放开其他 control 类型、版本或 execution kind', () => {
    const original = createIfNodeType();
    for (const manifest of [
      { ...original.manifest, type: 'flow.other' },
      { ...original.manifest, version: 2 },
      { ...original.manifest, executionKind: 'interaction' as const },
    ]) {
      const types = new NodeRegistry([{ ...original, manifest }, createTextGenerationNodeType()]);
      const graph = definition();
      graph.nodes[0]!.type = manifest.type;
      graph.nodes[0]!.typeVersion = manifest.version;
      expect(() => check(graph, types)).toThrow(
        expect.objectContaining({ code: 'NODE_EXECUTION_KIND_UNSUPPORTED' }),
      );
    }
  });
  it('简单 If 可通过生产 Publish，但发布不调用业务 execute 或条件求值', () => {
    const text = createTextGenerationNodeType();
    const execute = vi.spyOn(text, 'execute');
    const types = new NodeRegistry([text, createIfNodeType()]);
    const graph = definition();
    expect(check(graph, types)).toHaveLength(3);
    expect(validateWorkflowForPublish(graph, types)).toHaveLength(3);
    expect(execute).not.toHaveBeenCalled();
  });
  it('Compiler 能力边界拒绝汇合与跨分支依赖，不新增永久 Contract 限制', () => {
    const graph = definition();
    graph.nodes.push({ ...graph.nodes[1]!, id: 'D' });
    graph.edges.push(
      { id: 'BD', kind: 'control', source: { nodeId: 'B' }, target: { nodeId: 'D' } },
      { id: 'CD', kind: 'control', source: { nodeId: 'C' }, target: { nodeId: 'D' } },
      { id: 'BC', kind: 'control', source: { nodeId: 'B' }, target: { nodeId: 'C' } },
    );
    graph.outputs = [
      { name: 'result', type: StringType, source: { nodeId: 'B', outputKey: 'text' } },
    ];
    expect(() => workflowDefinitionSchema.parse(graph)).not.toThrow();
    expect(check(graph)).toHaveLength(4);
    expect(() => validateWorkflowForPublish(graph, registry())).toThrow(
      expect.objectContaining({ code: 'IF_CONVERGENCE_UNSUPPORTED' }),
    );
  });
});
