import { afterEach, describe, expect, it } from 'vitest';
import { SecretsService } from '../../src/secrets/secrets.service.js';

const original = process.env.CREDENTIAL_ENCRYPTION_KEY;
afterEach(() => {
  if (original === undefined) delete process.env.CREDENTIAL_ENCRYPTION_KEY;
  else process.env.CREDENTIAL_ENCRYPTION_KEY = original;
});

describe('凭证加密按所有者隔离', () => {
  it('抽包及归属参数改名后仍能读取既有 v1 密文，保持相同 AAD 隔离', () => {
    process.env.CREDENTIAL_ENCRYPTION_KEY = 'ab'.repeat(32);
    const envelope = 'v1.AAECAwQFBgcICQoL.0vx95gJwCBG2WCe8ptFzGg.VD51KmN4CzQ9Ain7FuxHxsCRWCC7DA';
    const service = new SecretsService();

    expect(service.decrypt(envelope, 'workspace-a')).toBe('test-only-provider-key');
    expect(() => service.decrypt(envelope, 'workspace-b')).toThrow();
  });

  it('使用 env:init 相同的 hex 密钥，密文不包含原值，不同所有者不可互相解密', () => {
    process.env.CREDENTIAL_ENCRYPTION_KEY = 'ab'.repeat(32);
    const service = new SecretsService();
    const encrypted = service.encrypt('test-only-provider-key', 'owner-a');
    expect(encrypted).not.toContain('test-only-provider-key');
    expect(service.decrypt(encrypted, 'owner-a')).toBe('test-only-provider-key');
    expect(() => service.decrypt(encrypted, 'owner-b')).toThrow();
    expect(service.encrypt('test-only-provider-key', 'owner-a')).not.toBe(encrypted);
  });
  it('拒绝不完整密钥和被篡改的密文', () => {
    const service = new SecretsService();
    process.env.CREDENTIAL_ENCRYPTION_KEY = 'not-a-valid-key';
    expect(() => service.encrypt('value', 'owner-a')).toThrow();
    process.env.CREDENTIAL_ENCRYPTION_KEY = 'ef'.repeat(32);
    const encrypted = service.encrypt('value', 'owner-a');
    const parts = encrypted.split('.');
    parts[2] = Buffer.alloc(16).toString('base64url');
    expect(() => service.decrypt(parts.join('.'), 'owner-a')).toThrow();
  });
});
