import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { Type } from '@nestjs/common';
import { NodeRegistry } from '@dramaflow/workflow';
import { WorkflowCapabilitiesFactory } from '@dramaflow/server';
import { z } from 'zod';

if (
  process.env.DRAMAFLOW_INTEGRATION !== '1' ||
  new URL(process.env.DATABASE_URL ?? 'http://invalid').pathname !==
    '/dramaflow_test' ||
  !process.env.WORKFLOW_QUEUE_PREFIX?.startsWith('dramaflow-test-')
)
  throw new Error('文本 AI Worker 测试仅允许隔离数据库 / 队列');

const source: unknown = await import(
  new URL('../../../worker/dist/app.module.js', import.meta.url).href
);
const { AppModule } = z
  .object({
    AppModule: z.custom<Type<unknown>>((value) => typeof value === 'function'),
  })
  .parse(source);
const app = await NestFactory.createApplicationContext(AppModule, {
  logger: false,
  abortOnError: false,
});
try {
  // 使用正式 Worker 模块与 Registry；本子进程不注册测试节点，不替换 Compiler / Codec。
  app.get(NodeRegistry).getAction('ai.text_generate', 1);
  if (process.env.DRAMAFLOW_LIVE_AI === '1') {
    // 真实验收只收集平台白名单摘要，不发送原始异常、供应商响应或凭证。
    const factory = app.get(WorkflowCapabilitiesFactory);
    const create = factory.forRun.bind(factory);
    const diagnostic = z.object({
      code: z.enum([
        'MODEL_CONFIGURATION_INVALID',
        'MODEL_CONFIGURATION_UNAVAILABLE',
        'MODEL_PROVIDER_UNAVAILABLE',
        'MODEL_CREDENTIALS_UNAVAILABLE',
        'PLUGIN_NOT_AVAILABLE',
        'CAPABILITY_NOT_AVAILABLE',
        'CAPABILITY_CONFIGURATION_INVALID',
        'CAPABILITY_CREDENTIALS_INVALID',
        'CAPABILITY_SETTINGS_INVALID',
        'CAPABILITY_MODEL_INVALID',
        'CAPABILITY_INPUT_INVALID',
        'CAPABILITY_OUTPUT_INVALID',
        'CAPABILITY_INVOCATION_FAILED',
        'CAPABILITY_DEBUG_MODE_UNSUPPORTED',
      ]),
      status: z.number().int().min(100).max(599).optional(),
      outcome: z.enum(['rejected', 'outcome_unknown']).optional(),
    });
    factory.forRun = (...scope) => {
      const invoker = create(...scope);
      return {
        invoke: async (...args) => {
          try {
            return await invoker.invoke(...args);
          } catch (error) {
            const summary = diagnostic.safeParse(error);
            if (summary.success)
              process.send?.({ event: 'capability_failed', ...summary.data });
            throw error;
          }
        },
      };
    };
  }
  await new Promise<void>((resolve, reject) => {
    if (!process.send) return reject(new Error('缺少测试 IPC'));
    process.send({ event: 'ready', pid: process.pid }, (error) =>
      error ? reject(error) : resolve(),
    );
  });
  await new Promise<void>((resolve) => process.once('message', resolve));
} finally {
  await app.close();
  process.disconnect();
}
