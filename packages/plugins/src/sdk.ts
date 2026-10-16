import { z } from 'zod';
import { jsonObjectSchema } from '@dramaflow/contracts';
import type { JsonObject } from '@dramaflow/contracts';
import type { ModelCapability, PluginManifest } from './manifest.js';

export const messageSchema = z
  .object({
    role: z.enum(['system', 'user', 'assistant']),
    content: z.string().min(1),
  })
  .strict();
export type ProviderMessage = z.infer<typeof messageSchema>;

export interface ProviderContext {
  apiKey: string;
  baseUrl?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface TextGenerationRequest {
  modelId: string;
  messages: ProviderMessage[];
  parameters: Record<string, unknown>;
}

export interface ImageGenerationRequest {
  modelId: string;
  prompt: string;
  parameters: Record<string, unknown>;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}
export interface TextGenerationResult {
  text: string;
  usage?: TokenUsage;
  providerRequestId?: string;
}
export interface GeneratedImage {
  mimeType: string;
  base64?: string;
  url?: string;
  revisedPrompt?: string;
}
export interface ImageGenerationResult {
  images: GeneratedImage[];
  providerRequestId?: string;
}

export interface VideoSubmitRequest {
  modelId: string;
  prompt: string;
  parameters: Record<string, unknown>;
  inputAssets: { id: string; url: string; mimeType: string }[];
  idempotencyKey: string;
}
export interface VideoTask {
  providerTaskId: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  progress?: number;
  outputs?: { url: string; mimeType: string }[];
  error?: { code: string; message: string };
}

/** A provider receives only explicitly constructed inputs, never the workflow state or a credential registry. */
export interface ModelProvider {
  readonly manifest: PluginManifest;
  validateConnection(configuration: unknown): JsonObject;
  validateParameters(capability: ModelCapability, parameters: unknown): JsonObject;
  generateText?(
    request: TextGenerationRequest,
    context: ProviderContext,
  ): Promise<TextGenerationResult>;
  generateImages?(
    request: ImageGenerationRequest,
    context: ProviderContext,
  ): Promise<ImageGenerationResult>;
  submitVideo?(request: VideoSubmitRequest, context: ProviderContext): Promise<VideoTask>;
  pollVideo?(providerTaskId: string, context: ProviderContext): Promise<VideoTask>;
  cancelVideo?(providerTaskId: string, context: ProviderContext): Promise<VideoTask>;
}

export class ProviderError extends Error {
  constructor(
    public readonly code:
      | 'INVALID_PARAMETERS'
      | 'UNSUPPORTED_CAPABILITY'
      | 'PROVIDER_REJECTED'
      | 'INVALID_PROVIDER_OUTPUT'
      | 'OUTCOME_UNKNOWN',
    message: string,
    public readonly outcomeUnknown = false,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export function validateProviderConnection(
  provider: ModelProvider,
  configuration: unknown,
): JsonObject {
  try {
    return jsonObjectSchema.parse(provider.validateConnection(configuration));
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(
      'INVALID_PARAMETERS',
      `插件 ${provider.manifest.id} 的连接配置不符合约束`,
    );
  }
}

export function validateProviderParameters(
  provider: ModelProvider,
  capability: ModelCapability,
  parameters: unknown,
): JsonObject {
  if (!provider.manifest.capabilities.includes(capability))
    throw new ProviderError(
      'UNSUPPORTED_CAPABILITY',
      `插件 ${provider.manifest.id} 不支持 ${capability}`,
    );
  try {
    return jsonObjectSchema.parse(provider.validateParameters(capability, parameters));
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(
      'INVALID_PARAMETERS',
      `插件 ${provider.manifest.id} 的 ${capability} 参数不符合约束`,
    );
  }
}

export function validateProviderContext(context: ProviderContext, requireBaseUrl = false): void {
  z.string().min(1).parse(context.apiKey);
  if (requireBaseUrl && !context.baseUrl)
    throw new ProviderError('INVALID_PARAMETERS', '此插件需要明确配置接口地址');
  if (context.baseUrl) {
    const url = z.url().parse(context.baseUrl);
    const parsed = new URL(url);
    if (
      !['https:', 'http:'].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.hash
    ) {
      throw new ProviderError(
        'INVALID_PARAMETERS',
        '接口地址必须使用 HTTP(S)，且不能包含账号、密码或片段',
      );
    }
  }
}

/** Never persist raw SDK errors: they may contain request headers, credentials or provider payloads. */
export function normalizeProviderError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  const status =
    typeof error === 'object' && error !== null && 'status' in error ? error.status : undefined;
  if (typeof status === 'number' && status >= 400 && status < 500 && status !== 408) {
    return new ProviderError(
      'PROVIDER_REJECTED',
      `供应商拒绝请求（HTTP ${status}），请检查模型、凭证和参数`,
    );
  }
  return new ProviderError(
    'OUTCOME_UNKNOWN',
    '未能确认供应商是否已受理请求；需检查执行记录后决定是否重新生成',
    true,
  );
}
