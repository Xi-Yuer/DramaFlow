import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import {
  DatabaseService,
  RedisService,
  StorageService,
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
    ]);
    new Logger('Worker').log('基础设施连接就绪；当前未注册业务任务。');
  } catch (error) {
    await app.close();
    throw error;
  }
}
await bootstrap();
