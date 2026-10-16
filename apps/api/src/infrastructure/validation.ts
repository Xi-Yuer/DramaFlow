import { BadRequestException } from '@nestjs/common';
import type { z } from 'zod';
import type { Prisma } from '@dramaflow/database';

export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new BadRequestException({
      message: '请求格式不正确',
      issues: result.error.issues,
    });
  return result.data;
}

export function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
