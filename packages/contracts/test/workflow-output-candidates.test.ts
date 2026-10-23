import { describe, expect, it } from 'vitest';
import {
  StringType,
  workflowDefinitionSchema,
  workflowDraftDefinitionSchema,
  saveWorkflowDraftRequestSchema,
  workflowVersionResponseSchema,
} from '../src/index.js';
const source = (nodeId: string) => ({ nodeId, outputKey: 'text' });
const definition = (output: unknown) => ({
  inputs: [],
  edges: [],
  nodes: ['B', 'C'].map((id) => ({
    id,
    type: 'test.text',
    typeVersion: 1,
    name: id,
    inputs: {},
    config: {},
    ui: { position: { x: 0, y: 0 } },
  })),
  outputs: [output],
});
describe('Workflow Output 候选协议与 Draft 边界', () => {
  const base = { name: 'result', type: StringType };
  it('旧 source 与合法 sources 都无损解析', () => {
    for (const output of [
      { ...base, source: source('B') },
      { ...base, sources: [source('B'), source('C')] },
    ])
      expect(workflowDefinitionSchema.parse(definition(output))).toEqual(definition(output));
  });
  it.each([
    { ...base, source: source('B'), sources: [source('B'), source('C')] },
    { ...base },
    { ...base, sources: [source('B'), source('B')] },
    { ...base, sources: [source('missing'), source('C')] },
  ])('非法来源结构拒绝 %j', (output) =>
    expect(workflowDraftDefinitionSchema.safeParse(definition(output)).success).toBe(false),
  );
  it.each([{ sources: [] }, { sources: [source('B')] }])(
    '不足的候选可保存 Draft，但不能成为正式 Definition',
    ({ sources }) => {
      const draft = definition({ ...base, sources });
      expect(
        saveWorkflowDraftRequestSchema.parse({ expectedRevision: 1, definition: draft }).definition,
      ).toEqual(draft);
      expect(workflowDefinitionSchema.safeParse(draft).success).toBe(false);
      expect(
        workflowVersionResponseSchema.safeParse({
          id: 'v',
          workflowId: 'w',
          projectId: '00000000-0000-4000-8000-000000000001',
          version: 1,
          sourceRevision: 1,
          publishedAt: '2026-10-23T00:00:00.000Z',
          definition: draft,
        }).success,
      ).toBe(false);
    },
  );
});
