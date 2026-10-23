import {
  StringType,
  humanReviewInputV1Schema,
  humanReviewConfigV1Schema,
  humanReviewDecisionV1Schema,
  humanReviewOutputV1Schema,
  humanReviewInterruptPayloadV1Schema,
  type HumanReviewInterruptPayloadV1,
  type HumanReviewOutputV1,
} from '@dramaflow/contracts';
import type { NodeDeclaration } from './type.js';

// 正式目录声明，不提供 Action execute；Publish / Compiler 在 interaction 策略接入前继续拒绝。
export function createHumanReviewNodeType(): NodeDeclaration {
  return {
    manifest: {
      type: 'flow.human_review',
      version: 1,
      executionKind: 'interaction',
      metadata: {
        name: '人工审批',
        category: 'flow',
        description: '审核文本并返回通过或拒绝结果',
      },
      inputs: [{ key: 'content', name: '待审核内容', dataType: StringType, required: true }],
      outputs: [
        { key: 'content', name: '审核内容', dataType: StringType },
        { key: 'action', name: '审批决策', dataType: StringType },
        { key: 'feedback', name: '修改意见', dataType: StringType },
      ],
      config: [{ key: 'instruction', name: '审核说明', type: 'string', required: false }],
    },
    inputSchema: humanReviewInputV1Schema,
    configSchema: humanReviewConfigV1Schema,
    outputSchema: humanReviewOutputV1Schema,
  };
}

// 纯业务转换，不调用 interrupt，不解码引用或创建执行记录。
export function createHumanReviewInterruptPayload(
  nodeId: string,
  input: unknown,
  config: unknown,
): HumanReviewInterruptPayloadV1 {
  const parsedInput = humanReviewInputV1Schema.parse(input);
  const parsedConfig = humanReviewConfigV1Schema.parse(config);
  return humanReviewInterruptPayloadV1Schema.parse({
    kind: 'human_review',
    schemaVersion: 1,
    nodeId,
    content: { storage: 'inline', type: StringType, value: parsedInput.content },
    ...(parsedConfig.instruction !== undefined ? { instruction: parsedConfig.instruction } : {}),
  });
}

// 合法 reject 与 approve 都返回正常业务输出；缺省 feedback 明确归一化为空字符串。
export function humanReviewOutputFromDecision(
  input: unknown,
  decision: unknown,
): HumanReviewOutputV1 {
  const parsedInput = humanReviewInputV1Schema.parse(input);
  const parsedDecision = humanReviewDecisionV1Schema.parse(decision);
  return humanReviewOutputV1Schema.parse({
    content: parsedInput.content,
    action: parsedDecision.action,
    feedback: parsedDecision.feedback ?? '',
  });
}
