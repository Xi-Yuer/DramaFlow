const messages = {
  PLUGIN_REGISTRATION_INVALID: '插件声明无效',
  PLUGIN_ALREADY_REGISTERED: '插件版本已注册',
  PLUGIN_NOT_AVAILABLE: '所选插件版本不可用',
  CAPABILITY_NOT_AVAILABLE: '所选插件不提供请求的能力',
  CAPABILITY_CONFIGURATION_INVALID: '插件配置无效',
  CAPABILITY_CREDENTIALS_INVALID: '插件凭证无效或缺失',
  CAPABILITY_MODEL_INVALID: '必须明确选择模型',
  CAPABILITY_SETTINGS_INVALID: '模型参数无效',
  CAPABILITY_INPUT_INVALID: '能力输入无效',
  CAPABILITY_OUTPUT_INVALID: '供应商返回的能力输出无效',
  CAPABILITY_INVOCATION_FAILED: '外部能力调用失败',
  CAPABILITY_DEBUG_MODE_UNSUPPORTED: '外部能力调用不支持全局 LangChain 详细日志',
} as const;

export type CapabilityErrorCode = keyof typeof messages;
export type CapabilityFailureCategory = 'timeout' | 'network' | 'execution';
export type CapabilityCallOutcome = 'rejected' | 'outcome_unknown';

// 只接受平台定义的摘要，绝不持有供应商 message、response、headers 或 cause。
export class CapabilityError extends Error {
  readonly status?: number;
  readonly category: CapabilityFailureCategory;
  readonly outcome?: CapabilityCallOutcome;

  constructor(
    public readonly code: CapabilityErrorCode,
    details: {
      status?: number;
      outcome?: CapabilityCallOutcome;
      category?: CapabilityFailureCategory;
    } = {},
  ) {
    super(messages[code]);
    this.name = 'CapabilityError';
    if (Number.isInteger(details.status) && details.status! >= 100 && details.status! <= 599)
      this.status = details.status;
    this.outcome = details.outcome;
    this.category = details.category ?? 'execution';
  }
}

function failureCategory(error: unknown): CapabilityFailureCategory {
  const seen = new Set<unknown>();
  for (let current = error; current && !seen.has(current);) {
    seen.add(current);
    if (current instanceof DOMException && current.name === 'TimeoutError') return 'timeout';
    if (typeof current !== 'object') break;
    if (
      'code' in current &&
      typeof current.code === 'string' &&
      [
        'ECONNRESET',
        'ECONNREFUSED',
        'ENOTFOUND',
        'EAI_AGAIN',
        'ETIMEDOUT',
        'EPIPE',
        'UND_ERR_CONNECT_TIMEOUT',
        'UND_ERR_SOCKET',
      ].includes(current.code)
    )
      return 'network';
    current = 'cause' in current ? current.cause : undefined;
  }
  return 'execution';
}

export function externalCapabilityError(
  error: unknown,
  details: { status?: number; category?: CapabilityFailureCategory } = {},
): CapabilityError {
  const status =
    details.status ??
    (typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof error.status === 'number' &&
    Number.isInteger(error.status) &&
    error.status >= 100 &&
    error.status <= 599
      ? error.status
      : undefined);
  return new CapabilityError('CAPABILITY_INVOCATION_FAILED', {
    category: details.category ?? failureCategory(error),
    ...(status === undefined ? {} : { status }),
    // 连接断开、超时、5xx 等不能证明供应商未受理，禁止据此自动重试。
    outcome: status !== undefined && status >= 400 && status < 500 ? 'rejected' : 'outcome_unknown',
  });
}
