import { Alert, Button, Select, Space } from 'antd';
import type { InvocationRecoveryState } from './invocation-recovery';
export function InvocationRecoveryControls({
  state,
  onRetry,
  onSelect,
}: {
  state: InvocationRecoveryState;
  onRetry(): void;
  onSelect(key: string): void;
}) {
  if (!state) return null;
  const unresolved = state.entries.filter((entry) => entry.phase !== 'found');
  const found = state.entries.filter((entry) => entry.run);
  if (!state.checking && !state.notice && !unresolved.length && !found.length) return null;
  return (
    <section aria-label="运行身份恢复">
      <Space orientation="vertical">
        {state.checking ? <span role="status">正在核对本地运行恢复标识…</span> : null}
        {state.notice ? <Alert type="warning" showIcon title={state.notice} /> : null}
        {unresolved.length ? (
          <Alert
            type="warning"
            showIcon
            title="上一次运行请求尚未确认"
            description={`${unresolved.length} 个请求等待核对；不会自动重新提交。${unresolved.some((entry) => entry.phase === 'conflict') ? '部分运行身份冲突，未恢复到其他 Run。' : ''}`}
          />
        ) : null}
        <Button size="small" loading={state.checking} onClick={onRetry}>
          重新查询运行身份
        </Button>
        {found.length ? (
          <Select
            aria-label="选择恢复的运行"
            value={state.selected?.invocationKey}
            onChange={onSelect}
            options={found.map(({ receipt, run }) => ({
              value: receipt.invocationKey,
              label: `${run!.id} · ${run!.status}`,
            }))}
          />
        ) : null}
      </Space>
    </section>
  );
}
