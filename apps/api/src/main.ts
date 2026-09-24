import 'reflect-metadata';
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { getConfig } from './config/config';
import { configureApp } from './bootstrap';

async function bootstrap(): Promise<void> {
  const config = getConfig();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true, bodyParser: false });
  app.useLogger(app.get(Logger));
  configureApp(app, config);
  app.enableShutdownHooks();
  await app.listen(config.PORT, '0.0.0.0');
}

bootstrap().catch((err: unknown) => {
  // Falha de inicialização (ex.: configuração inválida) — nunca imprime valores de segredos.
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
