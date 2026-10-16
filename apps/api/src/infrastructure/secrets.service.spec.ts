import { afterEach, describe, expect, it } from 'vitest';
import { SecretsService } from './secrets.service.js';

const original = process.env.CREDENTIAL_ENCRYPTION_KEY;
afterEach(() => {
  if (original === undefined) delete process.env.CREDENTIAL_ENCRYPTION_KEY;
  else process.env.CREDENTIAL_ENCRYPTION_KEY = original;
});

describe('凭证加密与工作空间隔离', () => {
  it('使用 env:init 相同的 hex 密钥，密文不包含原值，工作空间不可互相解密', () => {
    process.env.CREDENTIAL_ENCRYPTION_KEY = 'ab'.repeat(32);
    const service = new SecretsService();
    const encrypted = service.encrypt('test-only-provider-key', 'workspace-a');
    expect(encrypted).not.toContain('test-only-provider-key');
    expect(service.decrypt(encrypted, 'workspace-a')).toBe(
      'test-only-provider-key',
    );
    expect(() => service.decrypt(encrypted, 'workspace-b')).toThrow();
    expect(service.encrypt('test-only-provider-key', 'workspace-a')).not.toBe(
      encrypted,
    );
  });
  it('拒绝不完整密钥和被篡改的密文', () => {
    const service = new SecretsService();
    process.env.CREDENTIAL_ENCRYPTION_KEY = 'not-a-valid-key';
    expect(() => service.encrypt('value', 'workspace')).toThrow();
    process.env.CREDENTIAL_ENCRYPTION_KEY = 'ef'.repeat(32);
    const encrypted = service.encrypt('value', 'workspace');
    const parts = encrypted.split('.');
    parts[2] = Buffer.alloc(16).toString('base64url');
    expect(() => service.decrypt(parts.join('.'), 'workspace')).toThrow();
  });
});
