import { CapabilityError } from '../plugin/capability-error.js';

// 只检查本次调用实际使用的凭证，不记录正文、凭证或原始响应。
export function assertTextDoesNotEchoCredential(text: string, credential: string): void {
  if (text.includes(credential)) throw new CapabilityError('CAPABILITY_OUTPUT_INVALID');
}
