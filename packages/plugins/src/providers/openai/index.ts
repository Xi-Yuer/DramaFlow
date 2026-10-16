import OpenAI from 'openai';
import { z } from 'zod';
import {
  imageParametersSchema,
  textParametersSchema,
  openaiConnectionSchema,
  openaiManifest,
} from '../../manifest.js';
import { normalizeProviderError, ProviderError, validateProviderContext } from '../../sdk.js';
import type { ModelProvider } from '../../sdk.js';
import { generateOpenAIText } from './text.js';

const imageRequestSchema = z
  .object({
    modelId: z.string().min(1),
    prompt: z.string().min(1),
    parameters: imageParametersSchema,
  })
  .strict();

export const openaiProvider: ModelProvider = {
  manifest: openaiManifest,
  validateConnection: (configuration) => openaiConnectionSchema.parse(configuration),
  validateParameters(capability, parameters) {
    if (capability === 'text.generate' || capability === 'chat')
      return textParametersSchema.parse(parameters);
    if (capability === 'image.generate') return imageParametersSchema.parse(parameters);
    throw new ProviderError('UNSUPPORTED_CAPABILITY', 'OpenAI 适配器没有安装此能力的实现');
  },
  generateText: generateOpenAIText,
  async generateImages(request, context) {
    validateProviderContext(context);
    const { modelId, prompt, parameters } = imageRequestSchema.parse(request);
    const client = new OpenAI({
      apiKey: context.apiKey,
      ...(context.baseUrl ? { baseURL: context.baseUrl } : {}),
      maxRetries: 0,
      timeout: context.timeoutMs ?? 300_000,
    });
    try {
      const response = await client.images.generate(
        {
          model: modelId,
          prompt,
          n: parameters.n,
          output_format: parameters.outputFormat,
          ...(parameters.size ? { size: parameters.size } : {}),
          ...(parameters.quality ? { quality: parameters.quality } : {}),
          ...(parameters.background ? { background: parameters.background } : {}),
        },
        { signal: context.signal },
      );
      const images = (response.data ?? []).map((image) => ({
        mimeType: `image/${parameters.outputFormat}`,
        ...(image.b64_json ? { base64: image.b64_json } : {}),
        ...(image.url ? { url: image.url } : {}),
        ...(image.revised_prompt ? { revisedPrompt: image.revised_prompt } : {}),
      }));
      if (!images.length || images.some((image) => !image.base64 && !image.url)) {
        throw new ProviderError(
          'OUTCOME_UNKNOWN',
          '供应商返回缺少图片数据，需人工核实本次请求',
          true,
        );
      }
      return {
        images,
        ...(response._request_id ? { providerRequestId: response._request_id } : {}),
      };
    } catch (error) {
      throw normalizeProviderError(error);
    }
  },
};
