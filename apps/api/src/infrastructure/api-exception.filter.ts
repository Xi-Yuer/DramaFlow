import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);
  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const requestId = randomUUID();
    if (error instanceof HttpException) {
      const body = error.getResponse();
      const value =
        typeof body === 'object' && body !== null
          ? (body as Record<string, unknown>)
          : { message: body };
      response.status(error.getStatus()).json({
        code:
          typeof value.code === 'string'
            ? value.code
            : `HTTP_${error.getStatus()}`,
        message: typeof value.message === 'string' ? value.message : '请求失败',
        ...(value.issues ? { details: value.issues } : {}),
        requestId,
      });
      return;
    }
    if (error instanceof ZodError) {
      response.status(400).json({
        code: 'VALIDATION_FAILED',
        message: '数据不符合协议',
        details: error.issues,
        requestId,
      });
      return;
    }
    if (
      error instanceof Error &&
      'code' in error &&
      error.code === 'CONTEXT_BUDGET_EXCEEDED'
    ) {
      response
        .status(400)
        .json({ code: error.code, message: error.message, requestId });
      return;
    }
    this.logger.error(
      `未处理的服务错误，requestId=${requestId}，type=${error instanceof Error ? error.name : 'unknown'}`,
    );
    response.status(500).json({
      code: 'INTERNAL_ERROR',
      message: '服务暂时无法处理请求，请通过请求标识检查服务日志',
      requestId,
    });
  }
}
