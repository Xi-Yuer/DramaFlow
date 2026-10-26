import { z } from 'zod';

// 两个文本插件共用的地址、凭证和生成参数边界。协议适配留在各自插件。
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
