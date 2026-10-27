import { describe, expect, it } from 'vitest';
import {
  graphDefinitionSchema,
  workflowDefinitionSchema,
  ROOT_EXECUTION_SCOPE_KEY,
  NumberType,
  StringType,
  VideoType,
  type GraphDefinition,
  type RuntimeValue,
} from '@dramaflow/contracts';
import {
  createBindingResolver,
  createLocalGraphInvocation,
  DefaultWorkflowOutputResolver,
  deriveChildScope,
  graphDefinitionLocationSchema,
  mapGraphInvocationInputs,
  type ChildScopeSegment,
} from '../../../src/index.js';
import { nodeRunRepositoryFixture } from '../../fixtures/node-run-fixture.js';

const text: RuntimeValue = { storage: 'inline', type: StringType, value: 'chapter' };
const media: RuntimeValue = {
  storage: 'reference',
  type: VideoType,
  reference: { kind: 'artifact', id: 'video-1' },
};
const graph: GraphDefinition = {
  inputs: [
    { name: 'chapter', type: StringType, required: true },
    { name: 'video', type: VideoType, required: false },
  ],
  nodes: [
    {
      id: 'processChapter',
      type: 'test.process',
      typeVersion: 1,
      name: '处理',
      inputs: { chapter: { type: 'workflow_input', key: 'chapter' } },
      config: {},
      ui: { position: { x: 0, y: 0 } },
    },
  ],
  edges: [],
  outputs: [
    { name: 'result', type: StringType, source: { nodeId: 'processChapter', outputKey: 'result' } },
  ],
};
const run = {
  projectId: 'project',
  workflowId: 'workflow',
  workflowVersionId: 'version',
  workflowRunId: 'run',
};
const location = { workflowVersionId: 'version', path: [{ nodeId: 'boundary', graphKey: 'body' }] };
const segment: ChildScopeSegment = {
  kind: 'iteration_item',
  ownerOccurrenceId: 'owner',
  slot: 'body',
  index: 0,
};
const invocation = (scopeKey = deriveChildScope('root', segment)) =>
  createLocalGraphInvocation({
    definition: graph,
    definitionLocation: location,
    scopeKey,
    run,
    sources: { chosen: text, media },
    mappings: [
      { source: 'chosen', target: 'chapter' },
      { source: 'media', target: 'video' },
    ],
  });

describe('GraphDefinition 与显式输入边界', () => {
  it('根与局部图使用同一 Schema，保留 inputs/nodes/edges/outputs', () => {
    expect(graphDefinitionSchema).toBe(workflowDefinitionSchema);
    expect(graphDefinitionSchema.parse(graph)).toEqual(workflowDefinitionSchema.parse(graph));
    expect(
      graphDefinitionSchema.safeParse({
        ...graph,
        outputs: [{ ...graph.outputs[0], source: { nodeId: 'parentNode', outputKey: 'result' } }],
      }).success,
    ).toBe(false);
    expect(
      graphDefinitionSchema.safeParse({
        ...graph,
        nodes: [
          { ...graph.nodes[0], inputs: { chapter: { type: 'workflow_input', key: 'parentOnly' } } },
        ],
      }).success,
    ).toBe(false);
  });
  it('只选择显式来源、改名并保留 inline/reference 对象', () => {
    const local = invocation();
    expect(local.state.inputs.chapter).toBe(text);
    expect(local.state.inputs.video).toBe(media);
    expect(Object.keys(local.state.inputs)).toEqual(['chapter', 'video']);
    // 不存在的 Artifact 也能通过，边界无 resolver/codec/storage 依赖。
    expect(local.state.inputs.video).toEqual(media);
  });
  it('required 缺失失败，optional 未映射时省略', () => {
    expect(() => mapGraphInvocationInputs(graph.inputs, {}, [])).toThrow('INPUT_REQUIRED');
    expect(
      mapGraphInvocationInputs(graph.inputs, { value: text }, [
        { source: 'value', target: 'chapter' },
      ]),
    ).toEqual({ chapter: text });
  });
  it.each([
    ['UNKNOWN_INPUT', [{ source: 'value', target: 'unknown' }]],
    [
      'DUPLICATE_TARGET',
      [
        { source: 'value', target: 'chapter' },
        { source: 'value', target: 'chapter' },
      ],
    ],
    ['SOURCE_MISSING', [{ source: 'missing', target: 'chapter' }]],
  ])('%s', (code, mappings) => {
    expect(() => mapGraphInvocationInputs(graph.inputs, { value: text }, mappings)).toThrow(code);
  });
  it('检查类型兼容且拒绝非法 RuntimeValue envelope', () => {
    expect(() =>
      mapGraphInvocationInputs(graph.inputs, { value: media }, [
        { source: 'value', target: 'chapter' },
      ]),
    ).toThrow('TYPE_MISMATCH');
    const malformed = { ...text, value: undefined } as unknown as RuntimeValue;
    expect(() =>
      mapGraphInvocationInputs(graph.inputs, { value: malformed }, [
        { source: 'value', target: 'chapter' },
      ]),
    ).toThrow();
  });
  it('保留 false、0、null、空字符串，忽略未选来源与原型属性', () => {
    for (const value of [false, 0, null, '']) {
      const rv: RuntimeValue = { storage: 'inline', type: { kind: 'any' }, value };
      expect(
        mapGraphInvocationInputs(
          [{ name: 'value', type: { kind: 'any' }, required: true }],
          { selected: rv, extra: media },
          [{ source: 'selected', target: 'value' }],
        ).value,
      ).toBe(rv);
    }
    expect(() =>
      mapGraphInvocationInputs(graph.inputs, {}, [{ source: 'toString', target: 'chapter' }]),
    ).toThrow('SOURCE_MISSING');
  });
  it('workflow_input 在局部图只读取当前 invocation input', async () => {
    const local = invocation();
    const bindings = createBindingResolver();
    const result = await bindings.resolveInputs({
      node: graph.nodes[0]!,
      nodeType: {
        type: 'test.process',
        version: 1,
        executionKind: 'action',
        metadata: { name: '处理', category: 'flow' },
        inputs: [{ key: 'chapter', name: '章节', dataType: StringType }],
        outputs: [],
        config: [],
      },
      edges: graph.edges,
      workflowInputs: graph.inputs,
      state: local.state,
    });
    expect(result.chapter).toBe(text);
  });
});

describe('Local State 隔离与声明输出', () => {
  it('父数据不继承，两个 invocation 的输入 map/状态互不污染', () => {
    const parent = invocation('root');
    parent.state.outputs.parentNode = { result: text };
    const a = invocation();
    const b = invocation();
    expect(a.state.inputs).not.toBe(b.state.inputs);
    expect(a.state.run).not.toBe(run);
    expect(a.state.outputs).toEqual({});
    expect(a.state.execution).toEqual({});
    expect(a.state.variables).toEqual({});
    expect(a.state.execution).not.toBe(b.state.execution);
    a.state.outputs.processChapter = { result: text };
    expect(b.state.outputs).toEqual({});
    expect(parent.state.outputs).toEqual({ parentNode: { result: text } });
  });
  it('单/多命名输出复用原 resolver，reference 保持不变', () => {
    const resolver = new DefaultWorkflowOutputResolver();
    const local = invocation();
    local.state.outputs.processChapter = { result: text, video: media };
    expect(resolver.resolve(graph, local.state).result).toBe(text);
    const result = resolver.resolve(
      {
        outputs: [
          ...graph.outputs,
          {
            name: 'video',
            type: VideoType,
            source: { nodeId: 'processChapter', outputKey: 'video' },
          },
        ],
      },
      { outputs: local.state.outputs },
    );
    expect(result.video).toBe(media);
    expect(Object.keys(result)).toEqual(['result', 'video']);
    expect(resolver.resolve({ outputs: [] }, { outputs: local.state.outputs })).toEqual({});
  });
  it('输出缺失、类型不符继续失败', () => {
    const resolver = new DefaultWorkflowOutputResolver();
    expect(() => resolver.resolve(graph, { outputs: {} })).toThrowError(
      expect.objectContaining({ code: 'WORKFLOW_OUTPUT_MISSING' }),
    );
    expect(() =>
      resolver.resolve(graph, {
        outputs: { processChapter: { result: { storage: 'inline', type: NumberType, value: 1 } } },
      }),
    ).toThrowError(expect.objectContaining({ code: 'WORKFLOW_OUTPUT_TYPE_MISMATCH' }));
  });
});

describe('Scope 与 Definition Location', () => {
  it('保留 root，重入与字段顺序不改变 child scope', () => {
    expect(ROOT_EXECUTION_SCOPE_KEY).toBe('root');
    const first = deriveChildScope('root', segment);
    expect(first).not.toBe('root');
    expect(first).not.toContain('owner');
    expect(
      deriveChildScope('root', {
        index: 0,
        slot: 'body',
        ownerOccurrenceId: 'owner',
        kind: 'iteration_item',
      }),
    ).toBe(first);
    expect(invocation().scopeKey).toBe(invocation().scopeKey);
  });
  it('nested、parent、kind、owner、slot、index、callKey 区分调用', () => {
    const a = deriveChildScope('root', segment);
    const scopes = [
      a,
      deriveChildScope(a, segment),
      deriveChildScope('root', { ...segment, index: 1 }),
      deriveChildScope('root', { ...segment, ownerOccurrenceId: 'other' }),
      deriveChildScope('root', { ...segment, slot: 'other' }),
      deriveChildScope('root', {
        kind: 'subworkflow_call',
        ownerOccurrenceId: 'owner',
        slot: 'body',
        callKey: '0',
      }),
      deriveChildScope('root', {
        kind: 'subworkflow_call',
        ownerOccurrenceId: 'owner',
        slot: 'body',
        callKey: '1',
      }),
    ];
    expect(new Set(scopes).size).toBe(scopes.length);
    expect(() =>
      deriveChildScope('root', { ...segment, attempt: 2 } as ChildScopeSegment),
    ).toThrow();
    expect(() => deriveChildScope('root', { ...segment, index: -1 })).toThrow();
  });
  it('相同 definition location 可对应不同 scope；location 不包含 scope', () => {
    const a = invocation();
    const b = invocation(deriveChildScope('root', { ...segment, index: 1 }));
    expect(a.definitionLocation).toEqual(b.definitionLocation);
    expect(a.scopeKey).not.toBe(b.scopeKey);
    expect(
      graphDefinitionLocationSchema.parse({ workflowVersionId: 'version', path: [] }).path,
    ).toEqual([]);
    expect(graphDefinitionLocationSchema.safeParse({ ...location, scopeKey: 'root' }).success).toBe(
      false,
    );
  });
  it('相同 scope 重用 occurrence；不同 scope 保持同 nodeId 而分离 occurrence', async () => {
    const repository = nodeRunRepositoryFixture();
    const a = { workflowRunId: 'run', scopeKey: invocation().scopeKey, nodeId: 'processChapter' };
    const b = { ...a, scopeKey: deriveChildScope('root', { ...segment, index: 1 }) };
    const occurrence = await repository.getOrCreateOccurrence(a);
    expect(await repository.getOrCreateOccurrence(a)).toEqual(occurrence);
    expect((await repository.getOrCreateOccurrence(b)).id).not.toBe(occurrence.id);
  });
});
