import { describe, expect, it } from 'vitest';
import {
  StringType,
  humanReviewInputV1Schema,
  humanReviewConfigV1Schema,
  humanReviewDecisionV1Schema,
  humanReviewOutputV1Schema,
  humanReviewInterruptPayloadV1Schema,
  saveWorkflowDraftRequestSchema,
  workflowDraftDefinitionSchema,
} from '../src/index.js';

const payload = () => ({
  kind: 'human_review',
  schemaVersion: 1,
  nodeId: 'review_1',
  content: { storage: 'inline', type: StringType, value: '待审核文本' },
});

describe('Human Review V1 领域协议', () => {
  it('输入必填 string，静态 instruction 可省略；原样保留空白、换行和空字符串', () => {
    for (const text of ['', '  原文\n不裁剪  ']) {
      expect(humanReviewInputV1Schema.parse({ content: text })).toEqual({ content: text });
      expect(humanReviewConfigV1Schema.parse({ instruction: text })).toEqual({ instruction: text });
    }
    expect(humanReviewConfigV1Schema.parse({})).toEqual({});
    for (const content of [undefined, null, 1, {}, new Uint8Array([1])])
      expect(humanReviewInputV1Schema.safeParse({ content }).success).toBe(false);
    expect(
      humanReviewConfigV1Schema.safeParse({ instruction: { type: 'template', value: '{{x}}' } })
        .success,
    ).toBe(false);
    expect(humanReviewConfigV1Schema.safeParse({ title: '另一标题' }).success).toBe(false);
    // 形似模板的静态文字仍只是文字，不解析为运行时引用。
    expect(humanReviewConfigV1Schema.parse({ instruction: '{{content}}' }).instruction).toBe(
      '{{content}}',
    );
  });
  it.each([
    { action: 'approve' },
    { action: 'reject' },
    { action: 'reject', feedback: '角色服装需要修改' },
    { action: 'approve', feedback: '' },
  ])('合法 decision 原样保留 %j', (decision) => {
    expect(humanReviewDecisionV1Schema.parse(decision)).toEqual(decision);
  });
  it.each([
    {},
    { action: 'comment' },
    { action: 'Approve' },
    { action: true },
    { action: 'approve', feedback: null },
    { action: 'approve', feedback: 1 },
    { action: 'approve', approved: true },
    { action: 'reject', schemaVersion: 2 },
  ])('拒绝非法 action / 反馈 / 额外字段 %j', (decision) => {
    expect(humanReviewDecisionV1Schema.safeParse(decision).success).toBe(false);
  });
  it('稳定输出要求 feedback string 且不包含 approved', () => {
    const output = { content: '原文', action: 'reject', feedback: '' };
    expect(humanReviewOutputV1Schema.parse(output)).toEqual(output);
    expect(
      humanReviewOutputV1Schema.safeParse({ content: '原文', action: 'approve' }).success,
    ).toBe(false);
    expect(humanReviewOutputV1Schema.safeParse({ ...output, approved: false }).success).toBe(false);
    expect(humanReviewOutputV1Schema.safeParse({ ...output, action: 'comment' }).success).toBe(
      false,
    );
  });
  it('payload 固定 kind / schemaVersion，保留 RuntimeValue 并可 JSON 往返', () => {
    const value = { ...payload(), instruction: '请核对角色' };
    expect(humanReviewInterruptPayloadV1Schema.parse(value)).toEqual(value);
    expect(humanReviewInterruptPayloadV1Schema.parse(JSON.parse(JSON.stringify(value)))).toEqual(
      value,
    );
    for (const change of [
      { kind: 'other' },
      { schemaVersion: 2 },
      { nodeId: '' },
      { content: '裸文本' },
    ])
      expect(humanReviewInterruptPayloadV1Schema.safeParse({ ...value, ...change }).success).toBe(
        false,
      );
  });
  it('payload 结构保留 Artifact reference，不 materialize 内容或携带运行身份', () => {
    const reference = {
      ...payload(),
      content: {
        storage: 'reference',
        type: StringType,
        reference: { kind: 'artifact', id: 'artifact_1' },
      },
    };
    expect(humanReviewInterruptPayloadV1Schema.parse(reference)).toEqual(reference);
    for (const key of ['workflowRunId', 'threadId', 'nodeRunId', 'interruptId'])
      expect(
        humanReviewInterruptPayloadV1Schema.safeParse({ ...payload(), [key]: 'forbidden' }).success,
      ).toBe(false);
    expect(
      humanReviewInterruptPayloadV1Schema.safeParse({
        ...reference,
        content: { ...reference.content, url: 'https://example.test/temporary' },
      }).success,
    ).toBe(false);
  });
  it.each([new Uint8Array([1]), new Date(), () => 'value', 1n])(
    'RuntimeValue 拒绝非 JSON 内容 %s',
    (value) => {
      expect(
        humanReviewInterruptPayloadV1Schema.safeParse({
          ...payload(),
          content: { storage: 'inline', type: StringType, value },
        }).success,
      ).toBe(false);
    },
  );
  it('Human Review 可作为未完成 Draft 节点保存，完整 JSON 往返保留名称与配置', () => {
    const definition = {
      inputs: [],
      nodes: [
        {
          id: 'review',
          type: 'flow.human_review',
          typeVersion: 1,
          name: '核对人物',
          inputs: {},
          config: { instruction: '检查服装' },
          ui: { position: { x: 0, y: 0 } },
        },
      ],
      edges: [],
      outputs: [],
    };
    expect(workflowDraftDefinitionSchema.parse(definition)).toEqual(definition);
    const request = { expectedRevision: 1, definition };
    expect(saveWorkflowDraftRequestSchema.parse(JSON.parse(JSON.stringify(request)))).toEqual(
      request,
    );
  });
});
