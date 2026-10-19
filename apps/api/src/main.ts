import { NestFactory } from '@nestjs/core';
import { AuthService } from './auth/auth.service.js';
import { mountAuth } from './auth/auth.http.js';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { ApiExceptionFilter } from './http/exception.filter.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });
  mountAuth(app.getHttpAdapter().getInstance(), app.get(AuthService));
  app.useBodyParser('json', { limit: '1mb' });
  app.setGlobalPrefix('api/v1');
  app.enableCors({ origin: process.env.WEB_ORIGIN ?? 'http://localhost:3000' });
  app.useGlobalFilters(new ApiExceptionFilter());
  app.enableShutdownHooks();
  await app.listen(
    Number(process.env.API_PORT ?? process.env.PORT ?? 3001),
    '0.0.0.0',
  );
}
await bootstrap();
