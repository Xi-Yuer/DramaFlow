import { HumanReviewStateError } from '@dramaflow/server';
import {
  NodeExecutionError,
  NodeRegistrationError,
  WorkflowRunNotWaitingError,
  WorkflowRunNotPendingError,
  WorkflowResumeAlreadySubmittedError,
  WorkflowRunRecordingError,
  WorkflowInvocationValidationError,
  WorkflowInvocationConflictError,
} from '@dramaflow/workflow';
import {
  ConflictException,
  BadRequestException,
  HttpException,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

export type WorkflowResourceNotFoundCode =
  'WORKFLOW_VERSION_NOT_FOUND' | 'WORKFLOW_RUN_NOT_FOUND';

export function workflowResourceNotFound(code: WorkflowResourceNotFoundCode) {
  return new NotFoundException({
    code,
    message:
      code === 'WORKFLOW_VERSION_NOT_FOUND'
        ? '工作流版本不存在或无权访问'
        : '工作流运行不存在或无权访问',
  });
}

const configurationMessages = new Map([
  ['REFERENCE_RUNTIME_NOT_CONFIGURED', '运行时引用解析服务尚未配置'],
  ['ARTIFACT_WRITER_NOT_CONFIGURED', 'Artifact 写入服务尚未配置'],
  ['WORKFLOW_CHECKPOINT_UNAVAILABLE', '工作流 Checkpoint 尚未就绪'],
]);

function errorCode(error: Error): unknown {
  if ('code' in error) return error.code;
  if (error instanceof HttpException) {
    const body = error.getResponse();
    if (typeof body === 'object' && body !== null && 'code' in body)
      return body.code;
  }
  return undefined;
}

export function workflowRuntimeHttpError(
  error: unknown,
  notFoundCode: WorkflowResourceNotFoundCode,
): HttpException {
  if (error instanceof HumanReviewStateError) return error;
  if (error instanceof WorkflowInvocationConflictError)
    return new ConflictException({
      code: error.code,
      message: error.message,
      workflowRunId: error.workflowRunId,
    });
  if (error instanceof WorkflowInvocationValidationError) {
    const response = { code: error.code, message: error.message };
    if (error.code === 'WORKFLOW_INVOCATION_TYPE_SCHEMA_UNAVAILABLE')
      return new ServiceUnavailableException(response);
    if (error.code === 'WORKFLOW_INVOCATION_CONTRACT_INVALID')
      return new InternalServerErrorException(response);
    return new BadRequestException(response);
  }
  if (
    error instanceof WorkflowRunNotWaitingError ||
    error instanceof WorkflowRunNotPendingError
  )
    return new ConflictException(
      {
        code: error.code,
        message:
          error instanceof WorkflowRunNotWaitingError
            ? '工作流运行当前不在 waiting 状态'
            : '工作流运行当前不在 pending 状态',
      },
      { cause: error },
    );
  if (error instanceof WorkflowResumeAlreadySubmittedError)
    return new ConflictException({
      code: error.code,
      message: '本轮等待已提交恢复请求',
    });
  if (
    error instanceof HttpException &&
    error.getStatus() === 503 &&
    errorCode(error) === 'WORKFLOW_QUEUE_UNAVAILABLE'
  ) {
    const body = error.getResponse();
    const accepted = typeof body === 'object' && body !== null ? body : {};
    return new ServiceUnavailableException({
      code: 'WORKFLOW_QUEUE_UNAVAILABLE',
      message: '执行命令已持久保存，入队结果尚未确认',
      ...('workflowRunId' in accepted &&
      typeof accepted.workflowRunId === 'string'
        ? { workflowRunId: accepted.workflowRunId }
        : {}),
      ...('invocationKey' in accepted &&
      typeof accepted.invocationKey === 'string'
        ? { invocationKey: accepted.invocationKey }
        : {}),
    });
  }
  if (error instanceof HttpException && error.getStatus() === 404)
    return workflowResourceNotFound(notFoundCode);
  if (
    error instanceof HttpException &&
    error.getStatus() === 409 &&
    errorCode(error) === 'WORKFLOW_REVISION_CONFLICT'
  )
    return new ConflictException(
      { code: 'WORKFLOW_REVISION_CONFLICT', message: '工作流草稿修订已变化' },
      { cause: error },
    );

  // 只从有界 cause 链提取白名单配置码，不序列化 cause / stack / 驱动或供应商消息。
  const seen = new Set<Error>();
  let cause = error;
  for (
    let depth = 0;
    depth < 8 && cause instanceof Error && !seen.has(cause);
    depth++
  ) {
    seen.add(cause);
    const code = errorCode(cause);
    if (typeof code === 'string' && configurationMessages.has(code))
      return new ServiceUnavailableException(
        { code, message: configurationMessages.get(code) },
        { cause: error },
      );
    cause = cause.cause;
  }
  if (error instanceof WorkflowRunRecordingError)
    return new ServiceUnavailableException(
      {
        code: 'WORKFLOW_RUN_RECORDING_FAILED',
        message: '工作流运行记录暂时无法保存',
      },
      { cause: error },
    );
  if (error instanceof NodeExecutionError)
    return new InternalServerErrorException(
      { code: error.code, message: '工作流节点执行失败' },
      { cause: error },
    );
  if (error instanceof NodeRegistrationError)
    return new InternalServerErrorException(
      {
        code: 'WORKFLOW_COMPILATION_FAILED',
        message: '工作流引用的节点类型版本不可用',
      },
      { cause: error },
    );
  return new InternalServerErrorException(
    {
      code: 'WORKFLOW_RUNTIME_FAILED',
      message: '工作流暂时无法执行，请查询运行记录',
    },
    { cause: error },
  );
}
