import type { PluginManifest, RemoteModel } from '@dramaflow/contracts';

const MODEL_LIMIT = 500;
const PAGE_LIMIT = 5;

export class ModelListError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelListError';
  }
}

/** 用已保存的凭证向厂商拉取模型。模型 ID 不来自本地目录。 */
export async function listRemoteModels(
  manifest: PluginManifest,
  credentials: Record<string, string>,
  fetchImpl: typeof fetch = fetch,
): Promise<{ items: RemoteModel[]; unavailableReason: string | null }> {
  if (manifest.modelListing === 'none')
    return {
      items: [],
      unavailableReason: '这个插件没有公开的模型列表，请填写控制台中的模型 ID',
    };
  const apiKey = credentials.apiKey ?? '';
  const baseUrl = (credentials.baseUrl ?? '').replace(/\/+$/, '');
  if (!apiKey) throw new ModelListError('请先填写 API Key');
  if (!baseUrl.startsWith('https://')) throw new ModelListError('接口地址需要是 https 链接');
  const headers = new Headers({ Accept: 'application/json' });
  let url: string;
  if (manifest.modelListing === 'anthropic') {
    headers.set('x-api-key', apiKey);
    headers.set('anthropic-version', '2023-06-01');
    const prefix = baseUrl.endsWith('/v1') ? baseUrl : `${baseUrl}/v1`;
    url = `${prefix}/models?limit=1000`;
  } else {
    headers.set('Authorization', `Bearer ${apiKey}`);
    url = `${baseUrl}/models`;
  }
  const items: RemoteModel[] = [];
  const seen = new Set<string>();
  for (let page = 0; page < PAGE_LIMIT && url; page += 1) {
    const payload = await readJson(url, headers, apiKey, fetchImpl);
    for (const model of parseModels(payload)) {
      if (seen.has(model.id)) continue;
      seen.add(model.id);
      items.push(model);
      if (items.length >= MODEL_LIMIT) return { items, unavailableReason: null };
    }
    url = nextPage(payload, url);
  }
  return { items, unavailableReason: null };
}

async function readJson(url: string, headers: Headers, secret: string, fetchImpl: typeof fetch) {
  let response: Response;
  try {
    response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new ModelListError('无法连接模型列表接口');
  }
  const body = await response.text();
  if (!response.ok) throw new ModelListError(vendorMessage(response.status, body, secret));
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new ModelListError('模型列表响应无法解析');
  }
}

function parseModels(payload: unknown): RemoteModel[] {
  if (typeof payload !== 'object' || payload === null) return [];
  const record = payload as Record<string, unknown>;
  const rows = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.models)
      ? record.models
      : [];
  const items: RemoteModel[] = [];
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const model = row as Record<string, unknown>;
    const rawId =
      typeof model.id === 'string' ? model.id : typeof model.name === 'string' ? model.name : '';
    const id = rawId.replace(/^models\//, '').trim();
    if (!id || id.length > 160) continue;
    const display = typeof model.display_name === 'string' ? model.display_name.trim() : '';
    items.push({ id, label: (display || id).slice(0, 80) });
  }
  return items;
}

function nextPage(payload: unknown, currentUrl: string) {
  if (typeof payload !== 'object' || payload === null) return '';
  const record = payload as Record<string, unknown>;
  if (record.has_more !== true) return '';
  const rows = Array.isArray(record.data) ? record.data : [];
  const last = rows.at(-1);
  if (typeof last !== 'object' || last === null) return '';
  const id = (last as Record<string, unknown>).id;
  if (typeof id !== 'string' || !id) return '';
  const url = new URL(currentUrl);
  url.searchParams.set('after_id', id);
  return url.toString();
}

function vendorMessage(status: number, body: string, secret: string) {
  let message = `厂商模型列表请求失败（${status}）`;
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === 'object' && parsed !== null) {
      const record = parsed as Record<string, unknown>;
      const error = record.error;
      const nested =
        typeof error === 'object' && error !== null
          ? (error as Record<string, unknown>).message
          : undefined;
      const direct = typeof record.message === 'string' ? record.message : nested;
      if (typeof direct === 'string' && direct.trim()) message = direct.trim();
    }
  } catch {
    // 非 JSON 错误保持状态码说明。
  }
  if (secret) message = message.replaceAll(secret, '***');
  return message.slice(0, 200);
}
