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
      resolver.resolve({ ...definition, outputs: [{ ...definition.outputs[0]!, source }] }, state),
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
