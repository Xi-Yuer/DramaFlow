import { Alert, Button } from 'antd';
import type { GraphExecutionProjection } from '../projection/graph-execution-projection';

export function GraphExecutionNotice({
  projection,
  onRefresh,
}: {
  projection?: GraphExecutionProjection;
  onRefresh?: () => void;
}) {
  if (!projection || projection.phase === 'resolved' || projection.phase === 'no_execution')
    return null;
  return (
    <Alert
      role="status"
      showIcon
      type={projection.phase === 'loading' || projection.phase === 'ambiguous' ? 'info' : 'warning'}
      title={projection.reason}
      action={
        onRefresh && projection.phase !== 'loading' ? (
          <Button size="small" onClick={onRefresh}>
            重新读取执行状态
          </Button>
        ) : undefined
      }
    />
  );
}
