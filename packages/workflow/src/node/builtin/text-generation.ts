import {
  StringType,
  textGenerationInputSchema,
  textGenerationOutputSchema,
  type TextGenerationInput,
} from '@dramaflow/contracts';
import { z } from 'zod';
import type { NodeType } from '../registry/type.js';

export const textGenerationConfigSchema = z.object({ modelConfigurationId: z.uuid() }).strict();
type TextGenerationConfig = z.infer<typeof textGenerationConfigSchema>;

export class TextGenerationCapabilityNotConfiguredError extends Error {
  readonly code = 'CAPABILITY_NOT_CONFIGURED';

  constructor() {
    super('文本生成能力未配置');
    this.name = 'TextGenerationCapabilityNotConfiguredError';
  }
}

export function createTextGenerationNodeType(): NodeType<
  TextGenerationInput,
  TextGenerationConfig
> {
  return {
    manifest: {
      type: 'ai.text_generate',
      version: 1,
      executionKind: 'action',
      metadata: {
        name: '文本生成',
        category: 'ai',
        description: '使用明确选择的模型配置生成文本',
      },
      inputs: [
        { key: 'prompt', name: '提示词', dataType: StringType, required: true },
        { key: 'system', name: '系统提示词', dataType: StringType },
      ],
      outputs: [{ key: 'text', name: '生成文本', dataType: StringType }],
      config: [
        {
          key: 'modelConfigurationId',
          name: '模型配置',
          type: 'string',
          required: true,
          ui: { component: 'model-selector' },
        },
      ],
      capabilities: [{ type: 'text.generate' }],
      ui: { inputs: { prompt: { component: 'prompt-editor' }, system: { component: 'textarea' } } },
    },
    inputSchema: textGenerationInputSchema,
    configSchema: textGenerationConfigSchema,
    outputSchema: textGenerationOutputSchema,
    async execute(input, config, context) {
      if (!context.capabilities) throw new TextGenerationCapabilityNotConfiguredError();
      const request = { modelConfigurationId: config.modelConfigurationId, input };
      return context.signal
        ? context.capabilities.invoke('text.generate', request, { signal: context.signal })
        : context.capabilities.invoke('text.generate', request);
    },
  };
}
