import { textGenerationInputSchema, textGenerationOutputSchema } from '@dramaflow/contracts';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { APICallError, generateText, isStepCount, wrapLanguageModel } from 'ai';
import { z } from 'zod';
import { CapabilityError, externalCapabilityError } from '../plugin/capability-error.js';
import type { ProviderPlugin } from '../plugin/provider-plugin.js';
import {
  openAICompatibleConfigurationSchema,
  openAICompatibleCredentialsSchema,
  textGenerationSettingsSchema,
} from './parameters.js';
import { assertTextDoesNotEchoCredential } from './text-output.js';

const configurationSchema = openAICompatibleConfigurationSchema.extend({
  provider: z.enum(['openai', 'anthropic']),
});
// 只开放两种协议共同支持的参数范围，并要求显式限制生成长度。
const settingsSchema = textGenerationSettingsSchema.extend({
  temperature: z.number().finite().min(0).max(1).optional(),
  maxOutputTokens: z.number().int().min(1).max(65_536),
});
// OpenAI SDK 的统一 content 不保留 refusal，必须在实现内部校验原始响应。
const completionSchema = z.object({
  choices: z.array(z.object({ message: z.object({ refusal: z.unknown().optional() }) })).length(1),
});

export class TextGenerationPlugin implements ProviderPlugin {
  readonly id = 'text_generation';
  readonly version = 1;
  readonly management = {
    name: 'OpenAI / Anthropic 文本生成',
    description: '明确选择 OpenAI 或 Anthropic 协议、服务地址及模型。',
  };
  readonly configSchema = configurationSchema;
  readonly credentialsSchema = openAICompatibleCredentialsSchema;
  readonly capabilities: ProviderPlugin['capabilities'] = [
    {
      type: 'text.generate',
      metadata: { name: '文本生成' },
      inputSchema: textGenerationInputSchema,
      outputSchema: textGenerationOutputSchema,
      modelSettingsSchema: settingsSchema,
      async invoke(rawInput, context) {
        const input = textGenerationInputSchema.parse(rawInput);
        const configuration = configurationSchema.parse(context.configuration);
        const credentials = openAICompatibleCredentialsSchema.parse(context.credentials);
        const settings = settingsSchema.parse(context.settings);
        // 每次调用使用本次解密的 key；不使用默认 Provider、环境凭证或全局 client 缓存。
        const options = {
          baseURL: configuration.baseURL,
          apiKey: credentials.apiKey,
          fetch: ((url, init) =>
            globalThis.fetch(url, { ...init, redirect: 'manual' })) satisfies typeof fetch,
        };
        const providerModel =
          configuration.provider === 'openai'
            ? createOpenAI(options).chat(context.model)
            : createAnthropic(options).messages(context.model);
        try {
          const result = await generateText({
            model: wrapLanguageModel({
              model: providerModel,
              middleware: {
                specificationVersion: 'v4',
                async wrapGenerate({ doGenerate }) {
                  const output = await doGenerate();
                  // 在 SDK 自动 warning logger 之前拒绝被忽略的参数，不修改全局日志设置。
                  if (output.warnings.length)
                    throw new CapabilityError('CAPABILITY_SETTINGS_INVALID');
                  if (configuration.provider === 'openai') {
                    const response = completionSchema.safeParse(output.response?.body);
                    if (
                      !response.success ||
                      response.data.choices.some((choice) => Boolean(choice.message.refusal))
                    )
                      throw new CapabilityError('CAPABILITY_OUTPUT_INVALID');
                  }
                  return output;
                },
              },
            }),
            ...input,
            ...settings,
            maxRetries: 0,
            stopWhen: isStepCount(1),
            abortSignal: AbortSignal.any([
              AbortSignal.timeout(configuration.timeoutMs),
              ...(context.signal === undefined ? [] : [context.signal]),
            ]),
            telemetry: { isEnabled: false, recordInputs: false, recordOutputs: false },
            include: { requestBody: false, requestMessages: false, responseBody: false },
          });
          if (result.finishReason !== 'stop' || result.toolCalls.length || !result.text.trim())
            throw new CapabilityError('CAPABILITY_OUTPUT_INVALID');
          assertTextDoesNotEchoCredential(result.text, credentials.apiKey);
          return { text: result.text };
        } catch (error) {
          if (error instanceof CapabilityError) throw error;
          // SDK 使用 statusCode；只交给既有安全投影，不保留原始错误或 cause。
          throw externalCapabilityError({
            status: APICallError.isInstance(error) ? error.statusCode : undefined,
          });
        }
      },
    },
  ];
}
