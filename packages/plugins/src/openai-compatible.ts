import { textGenerationInputSchema, textGenerationOutputSchema } from '@dramaflow/contracts';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { ChatOpenAICompletions } from '@langchain/openai';
import { RunTree } from 'langsmith';
import { withRunTree } from 'langsmith/traceable';
import { z } from 'zod';
import { CapabilityError } from './capability-error.js';
import type { ProviderPlugin } from './provider-plugin.js';

export const openAICompatibleConfigurationSchema = z
  .object({
    baseURL: z
      .url()
      .max(2048)
      .refine((value) => {
        const url = new URL(value);
        return (
          (url.protocol === 'https:' || url.protocol === 'http:') &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash
        );
      }, '模型地址须为不含认证、查询参数或 fragment 的 HTTP(S) 地址'),
    timeoutMs: z.number().int().min(100).max(180_000).default(60_000),
  })
  .strict();

export const openAICompatibleCredentialsSchema = z
  .object({
    apiKey: z.string().trim().min(1).max(4096),
  })
  .strict();

export const textGenerationSettingsSchema = z
  .object({
    temperature: z.number().finite().min(0).max(2).optional(),
    maxOutputTokens: z.number().int().min(1).max(65_536).optional(),
  })
  .strict();

// 当前 LangChain 转换器会丢弃 message.refusal；仅在适配器内检查原始协议字段。
const completionResponseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({ refusal: z.unknown().optional() }),
      }),
    )
    .length(1),
});

export class OpenAICompatiblePlugin implements ProviderPlugin {
  readonly id = 'openai_compatible';
  readonly version = 1;
  readonly configSchema = openAICompatibleConfigurationSchema;
  readonly credentialsSchema = openAICompatibleCredentialsSchema;
  readonly capabilities: ProviderPlugin['capabilities'] = [
    {
      type: 'text.generate',
      inputSchema: textGenerationInputSchema,
      outputSchema: textGenerationOutputSchema,
      modelSettingsSchema: textGenerationSettingsSchema,
      async invoke(rawInput, context) {
        // LangChain 的全局 verbose 会自动打印原始异常；不能让它越过凭证边界。
        if (process.env.LANGCHAIN_VERBOSE === 'true')
          throw new CapabilityError('CAPABILITY_DEBUG_MODE_UNSUPPORTED');
        const input = textGenerationInputSchema.parse(rawInput);
        const configuration = openAICompatibleConfigurationSchema.parse(context.configuration);
        const credentials = openAICompatibleCredentialsSchema.parse(context.credentials);
        const settings = textGenerationSettingsSchema.parse(context.settings);
        const model = new ChatOpenAICompletions({
          model: context.model,
          apiKey: credentials.apiKey,
          configuration: {
            baseURL: configuration.baseURL,
            organization: '',
            project: '',
            maxRetries: 0,
            timeout: configuration.timeoutMs,
            logLevel: 'off',
            fetchOptions: { redirect: 'error' },
          },
          maxRetries: 0,
          timeout: configuration.timeoutMs,
          streaming: false,
          disableStreaming: true,
          streamUsage: false,
          cache: false,
          callbacks: [],
          verbose: false,
          __includeRawResponse: true,
          ...(settings.temperature === undefined ? {} : { temperature: settings.temperature }),
          ...(settings.maxOutputTokens === undefined
            ? {}
            : { maxTokens: settings.maxOutputTokens }),
        });
        const messages = [
          ...(input.system === undefined ? [] : [new SystemMessage(input.system)]),
          new HumanMessage(input.prompt),
        ];
        const signal = AbortSignal.any([
          AbortSignal.timeout(configuration.timeoutMs),
          ...(context.signal === undefined ? [] : [context.signal]),
        ]);
        // 隔离父图 callback / tracing context；供应商凭证与原始错误不进入自动 trace。
        const output = await withRunTree(
          new RunTree({ name: 'DramaFlow text capability', tracingEnabled: false }),
          () =>
            model.invoke(messages, {
              callbacks: [],
              signal,
            }),
        );
        const response = completionResponseSchema.safeParse(
          output.additional_kwargs.__raw_response,
        );
        if (
          !response.success ||
          response.data.choices.some((choice) => Boolean(choice.message.refusal)) ||
          typeof output.content !== 'string' ||
          output.content.trim().length === 0 ||
          output.response_metadata.finish_reason === 'length' ||
          output.response_metadata.finish_reason === 'content_filter' ||
          output.tool_calls?.length ||
          output.invalid_tool_calls?.length ||
          output.additional_kwargs.refusal
        )
          throw new CapabilityError('CAPABILITY_OUTPUT_INVALID');
        return { text: output.content };
      },
    },
  ];
}
