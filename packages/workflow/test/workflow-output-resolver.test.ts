import {
  NumberType,
  StringType,
  VideoType,
  type RuntimeValue,
  type WorkflowDefinition,
} from '@dramaflow/contracts';
import { describe, expect, it } from 'vitest';
import {
  DefaultWorkflowOutputResolver,
  WorkflowOutputResolutionError,
  type WorkflowState,
} from '../src/index.js';

const video: RuntimeValue = {
  storage: 'reference',
  type: VideoType,
  reference: { kind: 'artifact', id: 'movie' },
};
const state: WorkflowState = {
  run: { workflowId: 'w', workflowVersionId: 'v', workflowRunId: 'r', projectId: 'p' },
  inputs: {},
  variables: {},
  execution: {},
  outputs: {
    generate: { video, internal: { storage: 'inline', type: StringType, value: '内部数据' } },
  },
};
const definition: WorkflowDefinition = {
  inputs: [],
  nodes: [],
  edges: [],
  outputs: [{ name: 'movie', type: VideoType, source: { nodeId: 'generate', outputKey: 'video' } }],
};

describe('Workflow 最终 RuntimeValue 输出解析', () => {
  it.each(['B', 'C'])('候选 %s 唯一存在时原样返回 reference，不读取 route', (nodeId) => {
    const output = {
      name: 'selected',
      type: VideoType,
      sources: [
        { nodeId: 'B', outputKey: 'video' },
        { nodeId: 'C', outputKey: 'video' },
      ],
    };
    const actual = new DefaultWorkflowOutputResolver().resolve(
      { ...definition, outputs: [output] },
      { ...state, execution: {}, outputs: { [nodeId]: { video } } },
    );
    expect(actual.selected).toBe(video);
  });
  it.each([false, true])('多个来源即使相等也歧义，sources 反序=%s', (reverse) => {
    const sources = [
      { nodeId: 'B', outputKey: 'video' },
      { nodeId: 'C', outputKey: 'video' },
    ];
    if (reverse) sources.reverse();
    expect(() =>
      new DefaultWorkflowOutputResolver().resolve(
        { ...definition, outputs: [{ name: 'selected', type: VideoType, sources }] },
        { ...state, outputs: { B: { video }, C: { video } } },
      ),
    ).toThrow(
      expect.objectContaining({ code: 'WORKFLOW_OUTPUT_AMBIGUOUS', outputName: 'selected' }),
    );
  });
  it('无候选缺失；唯一来源类型错误不回退', () => {
    const d = {
      ...definition,
      outputs: [
        {
          name: 'selected',
          type: StringType,
          sources: [
            { nodeId: 'B', outputKey: 'text' },
            { nodeId: 'C', outputKey: 'text' },
          ],
        },
      ],
    };
    expect(() => new DefaultWorkflowOutputResolver().resolve(d, { ...state, outputs: {} })).toThrow(
      expect.objectContaining({ code: 'WORKFLOW_OUTPUT_MISSING' }),
    );
    expect(() =>
      new DefaultWorkflowOutputResolver().resolve(d, { ...state, outputs: { B: { text: video } } }),
    ).toThrow(expect.objectContaining({ code: 'WORKFLOW_OUTPUT_TYPE_MISMATCH' }));
  });
  const falsy: RuntimeValue[] = [
    { storage: 'inline', type: StringType, value: '' },
    { storage: 'inline', type: NumberType, value: 0 },
    { storage: 'inline', type: { kind: 'primitive', name: 'boolean' }, value: false },
    { storage: 'inline', type: { kind: 'primitive', name: 'null' }, value: null },
  ];
  it.each(falsy.map((value) => ({ value })))(
    '候选 RuntimeValue 的 $value.value 不是缺失',
    ({ value }) => {
      const actual = new DefaultWorkflowOutputResolver().resolve(
        {
          ...definition,
          outputs: [
            {
              name: 'selected',
              type: value.type,
              sources: [
                { nodeId: 'B', outputKey: 'out' },
                { nodeId: 'C', outputKey: 'out' },
              ],
            },
          ],
        },
        { ...state, outputs: { B: { out: value } } },
      );
      expect(actual.selected).toBe(value);
    },
  );
  it('不接受继承的候选节点或端口', () => {
    const d = {
      ...definition,
      outputs: [
        {
          name: 'selected',
          type: VideoType,
          sources: [
            { nodeId: 'B', outputKey: 'video' },
            { nodeId: 'C', outputKey: 'video' },
          ],
        },
      ],
    };
    for (const outputs of [Object.create({ B: { video } }), { B: Object.create({ video }) }])
      expect(() => new DefaultWorkflowOutputResolver().resolve(d, { ...state, outputs })).toThrow(
        expect.objectContaining({ code: 'WORKFLOW_OUTPUT_MISSING' }),
      );
  });
  const resolver = new DefaultWorkflowOutputResolver();
  it('只按对外声明名称收集来源 RuntimeValue，引用原样复用且不改 State', () => {
    const snapshot = structuredClone(state);
    const outputs = resolver.resolve(definition, state);
    expect(outputs).toEqual({ movie: video });
    expect(outputs.movie).toBe(video);
    expect(outputs).not.toBe(state.outputs);
    expect(state).toEqual(snapshot);
    expect(resolver.resolve({ ...definition, outputs: [] }, state)).toEqual({});
  });
  it.each([
    { nodeId: 'missing', outputKey: 'video' },
    { nodeId: 'generate', outputKey: 'missing' },
  ])('拒绝缺失来源 $nodeId.$outputKey，不回退到最后节点', (source) => {
    expect(() =>
      resolver.resolve(
        {
          ...definition,
          outputs: [
            { name: definition.outputs[0]!.name, type: definition.outputs[0]!.type, source },
          ],
        },
        state,
      ),
    ).toThrow(expect.objectContaining({ code: 'WORKFLOW_OUTPUT_MISSING', outputName: 'movie' }));
  });
  it('拒绝继承来的来源节点或输出键，不接受类型不匹配', () => {
    for (const outputs of [
      Object.create(state.outputs),
      { generate: Object.create(state.outputs.generate!) },
    ])
      expect(() => resolver.resolve(definition, { ...state, outputs })).toThrow(
        WorkflowOutputResolutionError,
      );
    expect(() =>
      resolver.resolve(
        { ...definition, outputs: [{ ...definition.outputs[0]!, type: NumberType }] },
        state,
      ),
    ).toThrow(expect.objectContaining({ code: 'WORKFLOW_OUTPUT_TYPE_MISMATCH' }));
  });
});
