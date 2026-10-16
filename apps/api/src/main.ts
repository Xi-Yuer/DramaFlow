import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { AuthService } from './auth/auth.service.js';
import { toNodeHandler } from 'better-auth/node';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ApiExceptionFilter } from './infrastructure/api-exception.filter.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });
  app
    .getHttpAdapter()
    .getInstance()
    .all('/api/auth/{*path}', toNodeHandler(app.get(AuthService).auth));
  app.useBodyParser('json', { limit: '36mb' });
  app.setGlobalPrefix('api/v1');
  app.enableCors({
    origin: process.env.WEB_ORIGIN ?? 'http://localhost:3000',
    credentials: true,
  });
  app.useGlobalFilters(new ApiExceptionFilter());
  app.enableShutdownHooks();
  await app.listen(
    Number(process.env.API_PORT ?? process.env.PORT ?? 3001),
    '0.0.0.0',
  );
}
await bootstrap();
