import { describe, expect, it } from 'vitest';
import { cancellationProjection } from '../../../../src/workflow/run/cancellation/current-execution.js';

describe('统一 cancellation read projection', () => {
  const base = {
    status: 'running',
    waitingRevision: 2,
    cancellationRequestedAt: new Date(),
    executions: [
      { kind: 'start', waitingRevision: 0, status: 'recovery_required' },
      { kind: 'resume', waitingRevision: 1, status: 'recovery_required' },
      { kind: 'resume', waitingRevision: 2, status: 'executing' },
    ],
  };
  it('只匹配当前 revision，不被历史 start / resume 的 recovery 污染', () => {
    expect(cancellationProjection(base)).toBe('requested');
    expect(
      cancellationProjection({
        ...base,
        executions: [
          ...base.executions.slice(0, 2),
          { kind: 'resume', waitingRevision: 2, status: 'recovery_required' },
        ],
      }),
    ).toBe('uncertain');
  });
  it.each(['completed', 'failed', 'cancelled'])(
    '%s 终态优先于 cancellation 与旧核查状态',
    (status) => {
      expect(
        cancellationProjection({
          ...base,
          status,
          executions: [{ kind: 'resume', waitingRevision: 2, status: 'recovery_required' }],
        }),
      ).toBe('none');
    },
  );
  it('无请求不推断取消；running 找不到当前 intent 不能映射旧命令', () => {
    expect(cancellationProjection({ ...base, cancellationRequestedAt: null })).toBe('none');
    expect(cancellationProjection({ ...base, executions: base.executions.slice(0, 2) })).toBe(
      'uncertain',
    );
  });
});
