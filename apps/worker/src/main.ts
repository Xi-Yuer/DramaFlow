import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import {
  DatabaseService,
  RedisService,
  StorageService,
  WorkflowCheckpointerService,
} from '@dramaflow/server';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);
  app.enableShutdownHooks();
  try {
    await Promise.all([
      app.get(DatabaseService).client.$queryRaw`SELECT 1`,
      app.get(RedisService).ping(),
      app.get(StorageService).ping(),
      app.get(WorkflowCheckpointerService).ping(),
    ]);
    new Logger('Worker').log('Workflow 执行队列与 Outbox Dispatcher 就绪。');
  } catch (error) {
    await app.close();
    throw error;
  }
}
await bootstrap();
