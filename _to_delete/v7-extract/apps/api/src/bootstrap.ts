import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { INestApplication } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { json, raw } from 'express';
import { AppConfig } from './config';
import { AppModule } from './app.module';
import { TokenVerifier } from './auth/verifier';
import { requestId } from './common/request-id';

/** Builds the HTTP app. Tests pass a local verifier; production passes the OIDC one. */
export async function createApp(config: AppConfig, verifier: TokenVerifier): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(config, verifier), { logger: config.NODE_ENV === 'test' ? (process.env.TEST_LOG ? ['error'] : false) : ['error', 'warn', 'log'] });
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(requestId);
  app.use((_req: unknown, res: { setHeader(k: string, v: string): void }, next: () => void) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    next();
  });
  app.use(json({ limit: config.BODY_LIMIT }));
  // CSV imports arrive as the raw request body (text/csv); a POST with any other type leaves body empty and is rejected with 415.
  app.use('/imports', raw({ type: ['text/csv', 'text/plain', 'application/csv', 'application/vnd.ms-excel'], limit: 5 * 1024 * 1024 }));
  // File bytes arrive raw on the upload route only; everything else is JSON.
  app.use('/files', raw({ type: () => true, limit: config.MAX_UPLOAD_BYTES }));
  app.enableCors({
    origin: config.CORS_ORIGINS,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Tenant-Id', 'X-Request-Id', 'Idempotency-Key'],
    exposedHeaders: ['X-Request-Id'],
    maxAge: 600,
  });
  app.enableShutdownHooks();
  return app;
}
