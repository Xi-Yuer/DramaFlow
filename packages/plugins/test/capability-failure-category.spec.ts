import { describe, expect, it } from 'vitest';
import { externalCapabilityError } from '../src/plugin/capability-error.js';

describe('Provider 失败来源的安全分类', () => {
  it('使用 timeout 类型 / 底层网络 code，不解析 message；不保留原始 cause', () => {
    const timed = externalCapabilityError(new DOMException('secret', 'TimeoutError'));
    expect(timed).toMatchObject({ category: 'timeout', outcome: 'outcome_unknown' });
    const network = externalCapabilityError(
      new Error('private provider URL', {
        cause: Object.assign(Error('secret'), { code: 'ECONNRESET' }),
      }),
    );
    expect(network).toMatchObject({ category: 'network', outcome: 'outcome_unknown' });
    expect(externalCapabilityError(Error('timeout ECONNRESET')).category).toBe('execution');
    expect(network).not.toHaveProperty('cause');
    expect(network.message).not.toContain('private');
  });
});
