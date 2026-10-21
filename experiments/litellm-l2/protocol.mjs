// 仅为 L2 验证正式协议，不被生产 packages / apps 引用。
const outcomes = new Set(['definitely_rejected', 'definitely_failed', 'outcome_unknown']);
const messages = {
  GATEWAY_UNREACHABLE: '模型兼容服务不可达',
  GATEWAY_AUTH_REJECTED: '模型兼容服务拒绝认证',
  PROVIDER_REJECTED: '模型服务拒绝请求',
  MODEL_CALL_UNCERTAIN: '模型调用结果无法确认',
  MODEL_OUTPUT_INVALID: '模型返回结果无效，生成结果无法确认',
  CALL_NOT_DISPATCHED: '模型请求未发送',
};

export function failure(code, outcome, httpStatus) {
  if (!Object.hasOwn(messages, code) || !outcomes.has(outcome)) throw new Error('无效安全错误枚举');
  return {
    code,
    outcome,
    message: messages[code],
    ...(Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599
      ? { httpStatus }
      : {}),
  };
}

export function projectResponse(status, value, { credentials = [] } = {}) {
  if (status >= 200 && status < 300) {
    const choices = value?.choices;
    const choice = Array.isArray(choices) && choices.length === 1 ? choices[0] : undefined;
    if (
      typeof choice?.message?.content !== 'string' ||
      !choice.message.content.trim() ||
      choice.finish_reason !== 'stop' ||
      choice.message.refusal ||
      choice.message.tool_calls?.length ||
      credentials.some(
        (credential) =>
          typeof credential === 'string' &&
          credential.length > 0 &&
          choice.message.content.includes(credential),
      )
    )
      return { ok: false, error: failure('MODEL_OUTPUT_INVALID', 'outcome_unknown', status) };
    return { ok: true, output: { text: choice.message.content } };
  }
  if (value?.error?.type === 'no_db_connection' || value?.error?.type === 'auth_error')
    return { ok: false, error: failure('GATEWAY_AUTH_REJECTED', 'definitely_rejected', status) };
  // 固定渠道的认证 / 权限 / 配额拒绝契约，同时匹配归一化类型。
  // 400/422 可能来自生成后的 Gateway 输出校验，不能当作未生成证明。
  const rejectionTypes = {
    401: 'authentication_error',
    403: 'permission_error',
    429: 'throttling_error',
  };
  if (rejectionTypes[status] && value?.error?.type === rejectionTypes[status])
    return { ok: false, error: failure('PROVIDER_REJECTED', 'definitely_rejected', status) };
  return { ok: false, error: failure('MODEL_CALL_UNCERTAIN', 'outcome_unknown', status) };
}

export function projectTransport(error, { dispatched, httpStatus } = {}) {
  if (!dispatched) return { ok: false, error: failure('CALL_NOT_DISPATCHED', 'definitely_failed') };
  const code = error?.cause?.code ?? error?.code;
  if (httpStatus === undefined && (code === 'ECONNREFUSED' || code === 'ENOTFOUND'))
    return { ok: false, error: failure('GATEWAY_UNREACHABLE', 'definitely_failed') };
  return { ok: false, error: failure('MODEL_CALL_UNCERTAIN', 'outcome_unknown', httpStatus) };
}

export function projectOperation(invocationId, elapsedMs, projected) {
  return {
    event: 'model_invocation_finished',
    invocationId,
    elapsedMs: Math.max(0, Math.round(elapsedMs)),
    success: projected.ok,
    ...(projected.ok
      ? {}
      : {
          code: projected.error.code,
          outcome: projected.error.outcome,
          ...(projected.error.httpStatus === undefined
            ? {}
            : { httpStatus: projected.error.httpStatus }),
        }),
  };
}

export async function invokeOnce(url, gatewayKey, body, deadlineMs) {
  const start = performance.now();
  if (deadlineMs <= 0)
    return {
      elapsedMs: 0,
      status: null,
      raw: '',
      value: null,
      headers: {},
      transportError: { name: 'DeadlineBeforeDispatch', code: null },
      projected: projectTransport(null, { dispatched: false }),
    };
  let status;
  try {
    // 信号持续覆盖连接、响应头与完整 body；没有外层 retry、fallback 或补发。
    const response = await fetch(url, {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gatewayKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(deadlineMs),
    });
    status = response.status;
    const raw = await response.text();
    let value = null;
    try {
      value = JSON.parse(raw);
    } catch {
      value = null;
    }
    return {
      elapsedMs: performance.now() - start,
      status,
      raw,
      value,
      headers: Object.fromEntries(response.headers),
      projected: projectResponse(status, value, { credentials: [gatewayKey, body.api_key] }),
    };
  } catch (error) {
    return {
      elapsedMs: performance.now() - start,
      status: status ?? null,
      raw: '',
      value: null,
      headers: {},
      transportError: {
        name: error?.name ?? 'Error',
        code: error?.cause?.code ?? error?.code ?? null,
      },
      projected: projectTransport(error, { dispatched: true, httpStatus: status }),
    };
  }
}
