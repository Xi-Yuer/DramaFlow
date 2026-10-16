import { z } from 'zod';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    ...options,
    credentials: 'same-origin',
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = z
      .object({ message: z.union([z.string(), z.array(z.string())]).optional() })
      .safeParse(data);
    const message = error.success ? error.data.message : undefined;
    throw new ApiError(
      Array.isArray(message) ? message.join('；') : (message ?? `请求失败 (${response.status})`),
      response.status,
      data,
    );
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success)
    throw new ApiError(
      '服务器响应格式不符合平台协议，请检查服务版本',
      response.status,
      parsed.error.issues,
    );
  return parsed.data;
}

export const jsonBody = (value: unknown) => JSON.stringify(value);
