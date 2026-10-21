import { z } from 'zod';
import {
  providerPluginCatalogSchema,
  modelProviderListSchema,
  modelConfigurationListSchema,
  modelProviderSchema,
  managedModelConfigurationSchema,
  createProjectProviderRequestSchema,
  createProjectModelRequestSchema,
  replaceProviderCredentialsRequestSchema,
  setModelResourceEnabledRequestSchema,
} from '@dramaflow/contracts';
import { ApiError, jsonBody, request } from '../../lib/http';

export const modelKeys = {
  catalog: ['provider-plugins'] as const,
  providers: (projectId: string) => ['model-settings', projectId, 'providers'] as const,
  models: (projectId: string) => ['model-settings', projectId, 'models'] as const,
};
export type CreateProviderInput = z.infer<typeof createProjectProviderRequestSchema>;
export type CreateModelInput = z.infer<typeof createProjectModelRequestSchema>;

// 不保留服务器原始错误、details 或 cause，防止异常响应回显凭证后进入组件 / Query 缓存。
async function safe<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    const status = error instanceof ApiError ? error.status : error instanceof z.ZodError ? 400 : 0;
    const message =
      status === 401
        ? '登录状态已失效，请重新登录'
        : status === 403 || status === 404
          ? '项目或配置不存在，或无权访问'
          : status === 400
            ? '配置未通过校验，请检查所选接入方式、地址、凭证和参数'
            : status === 409
              ? '供应商当前不可用，请刷新并检查启用状态'
              : status === 413
                ? '提交内容过大，请缩短配置后重试'
                : status >= 200 && status < 300
                  ? '服务器返回了无法识别的数据，请刷新列表核对'
                  : '无法确认请求结果，请检查网络并刷新列表核对';
    throw new ApiError(message, status);
  }
}
const providersPath = (id: string) => `/projects/${encodeURIComponent(id)}/providers`;
const modelsPath = (id: string) => `/projects/${encodeURIComponent(id)}/model-configurations`;

async function allPages<T>(
  page: (cursor?: string) => Promise<{ items: T[]; nextCursor: string | null }>,
): Promise<T[]> {
  const items: T[] = [],
    seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const result = await page(cursor);
    items.push(...result.items);
    if (!result.nextCursor) return items;
    if (seen.has(result.nextCursor)) throw new ApiError('分页响应无效', 200);
    seen.add(result.nextCursor);
    cursor = result.nextCursor;
  } while (cursor);
  return items;
}
const cursorQuery = (cursor?: string) => (cursor ? `?cursor=${encodeURIComponent(cursor)}` : '');
export const modelApi = {
  catalog: (signal?: AbortSignal) =>
    safe(() => request('/provider-plugins', providerPluginCatalogSchema, { signal })),
  providers: (projectId: string, signal?: AbortSignal) =>
    safe(() =>
      allPages((cursor) =>
        request(`${providersPath(projectId)}${cursorQuery(cursor)}`, modelProviderListSchema, {
          signal,
        }),
      ),
    ),
  models: (projectId: string, signal?: AbortSignal) =>
    safe(() =>
      allPages((cursor) =>
        request(`${modelsPath(projectId)}${cursorQuery(cursor)}`, modelConfigurationListSchema, {
          signal,
        }),
      ),
    ),
  createProvider: (projectId: string, input: CreateProviderInput) =>
    safe(() =>
      request(providersPath(projectId), modelProviderSchema, {
        method: 'POST',
        body: jsonBody(createProjectProviderRequestSchema.parse(input)),
      }),
    ),
  createModel: (projectId: string, input: CreateModelInput) =>
    safe(() =>
      request(modelsPath(projectId), managedModelConfigurationSchema, {
        method: 'POST',
        body: jsonBody(createProjectModelRequestSchema.parse(input)),
      }),
    ),
  setProviderEnabled: (projectId: string, id: string, enabled: boolean) =>
    safe(() =>
      request(`${providersPath(projectId)}/${encodeURIComponent(id)}`, modelProviderSchema, {
        method: 'PATCH',
        body: jsonBody(setModelResourceEnabledRequestSchema.parse({ enabled })),
      }),
    ),
  setModelEnabled: (projectId: string, id: string, enabled: boolean) =>
    safe(() =>
      request(
        `${modelsPath(projectId)}/${encodeURIComponent(id)}`,
        managedModelConfigurationSchema,
        {
          method: 'PATCH',
          body: jsonBody(setModelResourceEnabledRequestSchema.parse({ enabled })),
        },
      ),
    ),
  replaceCredentials: (projectId: string, id: string, credentials: Record<string, string>) =>
    safe(async () => {
      const response = await fetch(
        `/api/v1${providersPath(projectId)}/${encodeURIComponent(id)}/credentials`,
        {
          method: 'PUT',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: jsonBody(replaceProviderCredentialsRequestSchema.parse({ credentials })),
        },
      );
      // 正式轮换入口只接受 204；不读取或缓存任何返回体。
      if (response.status !== 204) throw new ApiError('轮换结果未确认', response.status);
    }),
};
