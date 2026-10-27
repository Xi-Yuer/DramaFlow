import { StringType, conditionExpressionSchema } from '@dramaflow/contracts';
import { z } from 'zod';
import type { NodeDeclaration } from '../registry/type.js';

// 只描述值契约：原样保留字符串，不 trim / coerce，不注入条件默认值。
// 条件由共享安全子集验证；此声明不执行条件，也不参与路由。
export function createIfNodeType(): NodeDeclaration {
  return {
    manifest: {
      type: 'flow.if',
      version: 1,
      executionKind: 'control',
      metadata: {
        name: '条件分支',
        category: 'flow',
        description: '按字符串条件选择 true 或 false 分支',
      },
      inputs: [{ key: 'value', name: '输入值', dataType: StringType, required: true }],
      outputs: [],
      controlOutputs: [
        { key: 'true', name: '条件成立' },
        { key: 'false', name: '条件不成立' },
      ],
      config: [{ key: 'condition', name: '条件', type: 'condition', required: true }],
    },
    inputSchema: z.object({ value: z.string() }).strict(),
    configSchema: z.object({ condition: conditionExpressionSchema }).strict(),
    outputSchema: z.object({}).strict(),
  };
}
