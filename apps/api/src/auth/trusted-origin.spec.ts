import { afterEach, describe, expect, it } from 'vitest';
import { authBaseUrl, isUntrustedWriteOrigin } from './trusted-origin.js';

describe('trusted origin', () => {
  const previous = process.env.BETTER_AUTH_URL;
  afterEach(() => {
    if (previous === undefined) delete process.env.BETTER_AUTH_URL;
    else process.env.BETTER_AUTH_URL = previous;
  });

  it('读取方法不校验来源', () => {
    expect(isUntrustedWriteOrigin('GET', 'https://evil.example')).toBe(false);
    expect(isUntrustedWriteOrigin('HEAD', undefined)).toBe(false);
    expect(isUntrustedWriteOrigin('OPTIONS', undefined)).toBe(false);
  });

  it('写入必须来自配置站点的来源', () => {
    process.env.BETTER_AUTH_URL = 'https://studio.example/app';
    expect(isUntrustedWriteOrigin('POST', 'https://studio.example')).toBe(false);
    expect(isUntrustedWriteOrigin('PUT', 'https://evil.example')).toBe(true);
    expect(isUntrustedWriteOrigin('PATCH', undefined)).toBe(true);
  });

  it('未配置时使用本地开发地址', () => {
    delete process.env.BETTER_AUTH_URL;
    expect(authBaseUrl()).toBe('http://localhost:3000');
    expect(isUntrustedWriteOrigin('POST', 'http://localhost:3000')).toBe(false);
  });
});
