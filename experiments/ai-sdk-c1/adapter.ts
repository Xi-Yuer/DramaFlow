import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { generateText, isStepCount } from 'ai';
import { z } from 'zod';
import type { CapabilityInvocationContext } from '../../packages/plugins/src/plugin/provider-plugin.ts';

// 只在实验使用，未注册到生产 PluginRegistry。
const configurationSchema = z
  .object({
    provider: z.enum(['openai', 'anthropic']),
    baseURL: z.url().refine((value) => {
      const url = new URL(value);
      return (
        ['http:', 'https:'].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      );
    }),
    timeoutMs: z.number().int().positive(),
  })
  .strict();
const credentialsSchema = z.object({ apiKey: z.string().trim().min(1) }).strict();
const inputSchema = z.object({ prompt: z.string().min(1), system: z.string().optional() }).strict();
const settingsSchema = z
  .object({
    maxOutputTokens: z.number().int().positive(),
    temperature: z.number().min(0).max(2),
  })
  .strict();

export async function invokeText(
  input: unknown,
  context: CapabilityInvocationContext,
  transport: typeof globalThis.fetch,
): Promise<{ text: string }> {
  const configuration = configurationSchema.parse(context.configuration);
  const credentials = credentialsSchema.parse(context.credentials);
  const prompt = inputSchema.parse(input);
  const settings = settingsSchema.parse(context.settings);
  const options = { apiKey: credentials.apiKey, baseURL: configuration.baseURL, fetch: transport };
  // 每次 invocation 创建，不读取环境 key、不使用全局默认 Provider 或字符串路由。
  const model =
    configuration.provider === 'openai'
      ? createOpenAI(options).chat(context.model)
      : createAnthropic(options).messages(context.model);
  const result = await generateText({
    model,
    ...prompt,
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
  if (
    result.finishReason !== 'stop' ||
    result.toolCalls.length ||
    (result.warnings?.length ?? 0) ||
    !result.text.trim() ||
    result.text.includes(credentials.apiKey)
  )
    throw new Error('C1_OUTPUT_INVALID');
  return { text: result.text };
}
