import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);
  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const requestId = randomUUID();
    const path = host.switchToHttp().getRequest<Request>().originalUrl.split('?')[0] ?? '';
    const sensitive =
      /^\/api\/v1\/(?:provider-plugins|provider-catalog|model-catalog|providers|model-configurations)(?:\/|$)/.test(
        path,
      );
    if (sensitive) response.setHeader('Cache-Control', 'no-store');
    if (
      sensitive &&
      typeof error === 'object' &&
      error !== null &&
      'type' in error &&
      error.type === 'entity.too.large'
    ) {
      response.status(413).json({ code: 'HTTP_413', message: '请求内容过大', requestId });
      return;
    }
    if (error instanceof HttpException) {
      const body = error.getResponse();
      const value =
        typeof body === 'object' && body !== null
          ? (body as Record<string, unknown>)
          : { message: body };
      if (sensitive) {
        const status = error.getStatus();
        const knownCodes = new Set([
          'MODEL_MANAGEMENT_REQUEST_INVALID',
          'MODEL_MANAGEMENT_UNAVAILABLE',
          'MODEL_RESOURCE_NOT_FOUND',
          'MODEL_PROVIDER_CONFIGURATION_INVALID',
          'MODEL_CONFIGURATION_INVALID',
          'MODEL_CONFIGURATION_UNAVAILABLE',
          'MODEL_PROVIDER_UNAVAILABLE',
          'MODEL_CREDENTIALS_UNAVAILABLE',
        ]);
        response.status(status).json({
          code:
            typeof value.code === 'string' && knownCodes.has(value.code)
              ? value.code
              : `HTTP_${status}`,
          message:
            status === 401
              ? '请先登录'
              : status === 403
                ? '无权访问或请求来源无效'
                : status === 404
                  ? '项目或模型资源不存在或无权访问'
                  : status === 409
                    ? '所选模型资源当前不可用'
                    : status === 413
                      ? '请求内容过大'
                      : status >= 500
                        ? '模型配置服务暂时不可用'
                        : '模型管理请求不符合协议',
          requestId,
        });
        return;
      }
      response.status(error.getStatus()).json({
        code: typeof value.code === 'string' ? value.code : `HTTP_${error.getStatus()}`,
        message: typeof value.message === 'string' ? value.message : '请求失败',
        ...(value.issues ? { details: value.issues } : {}),
        ...((value.code === 'WORKFLOW_QUEUE_UNAVAILABLE' ||
          value.code === 'WORKFLOW_INVOCATION_CONFLICT') &&
        typeof value.workflowRunId === 'string'
          ? { workflowRunId: value.workflowRunId }
          : {}),
        ...(value.code === 'WORKFLOW_QUEUE_UNAVAILABLE' && typeof value.invocationKey === 'string'
          ? { invocationKey: value.invocationKey }
          : {}),
        requestId,
      });
      return;
    }
    if (error instanceof ZodError) {
      response.status(400).json({
        code: 'VALIDATION_FAILED',
        message: '数据不符合协议',
        ...(sensitive ? {} : { details: error.issues }),
        requestId,
      });
      return;
    }
    this.logger.error(
      `未处理的服务错误，requestId=${requestId}，type=${sensitive ? 'model-management' : error instanceof Error ? error.name : 'unknown'}`,
    );
    response.status(500).json({
      code: 'INTERNAL_ERROR',
      message: '服务暂时无法处理请求，请通过请求标识检查服务日志',
      requestId,
    });
  }
}
