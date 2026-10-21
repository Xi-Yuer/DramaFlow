import { z } from 'zod';

// 业务输入输出不包含 Provider、模型地址或凭证，能力选择只引用服务端配置身份。
export const textGenerationInputSchema = z
  .object({ prompt: z.string().min(1), system: z.string().optional() })
  .strict();

export const textGenerationOutputSchema = z.object({ text: z.string() }).strict();

export const capabilityInvocationSchema = z
  .object({ modelConfigurationId: z.uuid(), input: z.json() })
  .strict();

export type TextGenerationInput = z.infer<typeof textGenerationInputSchema>;
export type TextGenerationOutput = z.infer<typeof textGenerationOutputSchema>;
export type CapabilityInvocation = z.infer<typeof capabilityInvocationSchema>;
