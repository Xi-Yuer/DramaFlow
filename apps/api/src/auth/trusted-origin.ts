const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS']);

export const invalidOriginMessage = '请求来源无效，请刷新页面后重试';

export function authBaseUrl(): string {
  return process.env.BETTER_AUTH_URL ?? 'http://localhost:3000';
}

export function isUntrustedWriteOrigin(
  method: string,
  origin: string | undefined,
): boolean {
  if (safeMethods.has(method)) return false;
  return origin !== new URL(authBaseUrl()).origin;
}
