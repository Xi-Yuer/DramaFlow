import { describe, expect, it } from 'vitest';
import {
  capabilityInvocationSchema,
  textGenerationInputSchema,
  textGenerationOutputSchema,
} from '../src/index.js';

const modelConfigurationId = 'da054b80-9d86-4d23-a1c9-31bc416f91f1';

describe('文本生成能力契约', () => {
  it('只接受文本业务输入输出，并保留提示词原文', () => {
    const input = { prompt: '  编写开场对白  ', system: '使用中文' };
    expect(textGenerationInputSchema.parse(input)).toEqual(input);
    expect(textGenerationInputSchema.parse({ prompt: '编写对白' })).toEqual({ prompt: '编写对白' });
    expect(textGenerationOutputSchema.parse({ text: '你好。' })).toEqual({ text: '你好。' });
    for (const value of [{}, { prompt: '' }, { prompt: 1 }, { prompt: '对白', apiKey: 'secret' }])
      expect(textGenerationInputSchema.safeParse(value).success).toBe(false);
    for (const value of [{}, { text: 1 }, { text: '对白', rawResponse: {} }])
      expect(textGenerationOutputSchema.safeParse(value).success).toBe(false);
  });

  it('能力调用只传明确配置 ID 与 JSON 业务输入，不携带基础设施配置', () => {
    const invocation = { modelConfigurationId, input: { prompt: '编写对白' } };
    expect(capabilityInvocationSchema.parse(invocation)).toEqual(invocation);
    for (const value of [
      { input: {} },
      { modelConfigurationId: 'not-a-uuid', input: {} },
      { ...invocation, apiKey: 'secret' },
      { ...invocation, baseURL: 'https://provider.example.test' },
      { ...invocation, input: new Uint8Array([1]) },
    ])
      expect(capabilityInvocationSchema.safeParse(value).success).toBe(false);
  });
});
