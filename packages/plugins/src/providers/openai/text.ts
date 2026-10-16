import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';
import { z } from 'zod';
import { textParametersSchema } from '../../manifest.js';
import {
  messageSchema,
  normalizeProviderError,
  ProviderError,
  validateProviderContext,
} from '../../sdk.js';
import type { ProviderContext, TextGenerationRequest, TextGenerationResult } from '../../sdk.js';

const requestSchema = z
  .object({
    modelId: z.string().min(1),
    messages: z.array(messageSchema).min(1),
    parameters: textParametersSchema,
  })
  .strict();

export async function generateOpenAIText(
  request: TextGenerationRequest,
  context: ProviderContext,
): Promise<TextGenerationResult> {
  validateProviderContext(context);
  const parsed = requestSchema.parse(request);
  const model = new ChatOpenAI({
    model: parsed.modelId,
    apiKey: context.apiKey,
    maxRetries: 0,
    timeout: context.timeoutMs ?? 120_000,
    ...(parsed.parameters.temperature !== undefined
      ? { temperature: parsed.parameters.temperature }
      : {}),
    ...(parsed.parameters.maxOutputTokens !== undefined
      ? { maxCompletionTokens: parsed.parameters.maxOutputTokens }
      : {}),
    ...(parsed.parameters.topP !== undefined ? { topP: parsed.parameters.topP } : {}),
    configuration: context.baseUrl ? { baseURL: context.baseUrl } : {},
  });
  const messages = parsed.messages.map((message) => {
    if (message.role === 'system') return new SystemMessage(message.content);
    if (message.role === 'assistant') return new AIMessage(message.content);
    return new HumanMessage(message.content);
  });
  try {
    const response = await model.invoke(messages, { signal: context.signal });
    const text =
      typeof response.content === 'string'
        ? response.content
        : response.content
            .map((part) => ('text' in part && typeof part.text === 'string' ? part.text : ''))
            .join('');
    if (!text.trim())
      throw new ProviderError(
        'INVALID_PROVIDER_OUTPUT',
        '供应商未返回可用文本，请检查模型输出限制后主动重新生成',
      );
    return {
      text,
      ...(response.id ? { providerRequestId: response.id } : {}),
      ...(response.usage_metadata
        ? {
            usage: {
              inputTokens: response.usage_metadata.input_tokens,
              outputTokens: response.usage_metadata.output_tokens,
              totalTokens: response.usage_metadata.total_tokens,
            },
          }
        : {}),
    };
  } catch (error) {
    throw normalizeProviderError(error);
  }
}
