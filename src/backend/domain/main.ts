import {
  configureOpenApi,
  configureSwaggerUi,
} from '../global/apiPayload/swagger';
import 'reflect-metadata';
import { createValidationPipe } from '../global/apiPayload/validation.pipe';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from './app.module';
import cookieParser from 'cookie-parser';

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
  app.use(cookieParser());
  app.useGlobalPipes(createValidationPipe());
  try {
    await beforeInit?.(app);
    configureSwaggerUi(app);
    await app.init();
    configureOpenApi(app);
    return { app, handle: express };
  } catch (error) {
    await app.close();
    throw error;
  }
}
