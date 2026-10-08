import {
  configureRequestSchemas,
  configureSwaggerUi,
} from '../global/apiPayload/swagger';
import 'reflect-metadata';
import { createValidationPipe } from '../global/apiPayload/validation.pipe';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from './app.module';
import { PrismaService } from '../global/database/prisma.service';
import { ReceiptWorker } from './settle/service/receiptWorker';

export async function createBackend(
  beforeInit?: (app: INestApplication) => Promise<void>,
) {
  // Guards run before the limited JSON body interceptor and DTO pipes.
  const app = await NestFactory.create(AppModule, {
    bodyParser: false,
    logger: ['error', 'warn'],
  });
  const express = app.getHttpAdapter().getInstance();
  express.disable('x-powered-by');
  app.useGlobalPipes(createValidationPipe());
  await beforeInit?.(app);
  configureSwaggerUi(app);
  await app.init();
  configureRequestSchemas(app);
  return { app, handle: express };
}

export async function startBackendWorkers(app: INestApplication) {
  const database = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (database)
    await app
      .get(PrismaService)
      .client.$connect()
      .catch(() =>
        console.warn(
          'Backend database initialization unavailable; requests will retry',
        ),
      );
  if (
    (process.env.DATABASE_URL || process.env.POSTGRES_URL) &&
    process.env.RECEIPT_WORKER_ENABLED !== 'false'
  )
    await app.get(ReceiptWorker).start();
}
