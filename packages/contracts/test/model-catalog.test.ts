import { describe, expect, it } from 'vitest';
import { modelCatalogQuerySchema, modelCatalogSchema } from '../src/index.js';

describe('模型目录协议', () => {
  it('查询只接受可选能力，目录项不携带凭证字段', () => {
    expect(modelCatalogQuerySchema.parse({})).toEqual({});
    expect(modelCatalogQuerySchema.parse({ capability: 'text.generate' })).toEqual({
      capability: 'text.generate',
    });
    expect(modelCatalogQuerySchema.safeParse({ capability: '' }).success).toBe(false);
    expect(
      modelCatalogQuerySchema.safeParse({ capability: 'text.generate', apiKey: 'x' }).success,
    ).toBe(false);
    const item = {
      id: 'gpt-4o',
      displayName: 'GPT-4o',
      providerDefinitionId: 'openai',
      capabilities: [{ type: 'text.generate', name: '文本生成' }],
    };
    expect(modelCatalogSchema.parse({ items: [item] })).toEqual({ items: [item] });
    expect(
      modelCatalogSchema.safeParse({ items: [{ ...item, credentials: { apiKey: 'secret' } }] })
        .success,
    ).toBe(false);
  });
});
