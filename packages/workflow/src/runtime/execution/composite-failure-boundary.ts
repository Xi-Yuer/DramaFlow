import type { NodeRunError } from '@dramaflow/contracts';
import {
  ChildExecutionRecordingError,
  classifyGraphExecutionFailure,
  toNodeRunError,
} from '../node/node-execution-error.js';

// 每个 graph invocation owner 只结束自己的 lifecycle，再原样向父图抛出。
// transition 使用既有原子仓储；不查询执行树、不重试、不重放业务节点。
export async function failCompositeExecution(
  childExecutionId: string,
  cause: unknown,
  transition: (error: NodeRunError) => Promise<void>,
): Promise<never> {
  const failure = classifyGraphExecutionFailure(cause);
  if (failure.kind === 'execution') {
    try {
      await transition(toNodeRunError(failure.executionError));
    } catch (recordingError) {
      if (classifyGraphExecutionFailure(recordingError).kind === 'cancellation')
        throw recordingError;
      throw new ChildExecutionRecordingError(childExecutionId, cause, recordingError);
    }
  }
  throw cause;
}
