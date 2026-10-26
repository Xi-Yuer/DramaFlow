import type { z } from 'zod';

export interface CapabilityInvocationContext {
  readonly configuration: unknown;
  readonly credentials: unknown;
  readonly model: string;
  readonly settings: unknown;
  readonly signal?: AbortSignal;
}

export interface ProviderCapability {
  readonly metadata?: { readonly name: string; readonly description?: string };
  readonly type: string;
  readonly inputSchema: z.ZodType;
  readonly outputSchema: z.ZodType;
  readonly modelSettingsSchema: z.ZodObject;
  invoke(input: unknown, context: CapabilityInvocationContext): Promise<unknown>;
}

// 仅由应用构建时注册的受信任服务端实现，不接受远程代码或动态 npm 包。
export interface ProviderPlugin {
  // 显式允许产品配置；缺省仍可由 Runtime 使用，但不出现在配置目录或接受新绑定。
  readonly management?: { readonly name: string; readonly description?: string };
  readonly id: string;
  readonly version: number;
  readonly configSchema: z.ZodObject;
  readonly credentialsSchema: z.ZodObject;
  readonly capabilities: readonly ProviderCapability[];
}

export interface InvokeCapabilityInput extends CapabilityInvocationContext {
  readonly pluginId: string;
  readonly pluginVersion: number;
  readonly capability: string;
  readonly input: unknown;
}
