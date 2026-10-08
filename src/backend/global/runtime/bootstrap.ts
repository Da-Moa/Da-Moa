import { createServer } from 'node:http';
import type { Request, Response, NextFunction } from 'express';
import { networkInterfaces } from 'node:os';
import next from 'next';
import { createBackend, startBackendWorkers } from '../../domain/main';
import { stopReceiptWorker } from '../../domain/settle/service/receiptWorker';
import { disconnectPrismaClients } from '../database/prisma.service';
import { closeDatabasePools } from '../database/dbClient.mjs';
import { createRateLimitController } from '../rateLimit/native';
import { createWsController } from '../websocket/controller/wsController.mjs';
import {
  collectDatabaseMetrics,
  httpMetrics,
  trackHttpResponse,
} from '../monitoring/httpMetrics.mjs';
import { jwtGuard } from '../auth/guard/jwt.guard';
import { webRequest } from '../apiPayload/httpContext';

function serverPort(value: string | undefined, name: string) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(`Invalid ${name}`);
  return port;
}

export async function bootstrap() {
  const development = process.env.NODE_ENV !== 'production';
  const port = serverPort(process.env.PORT || '3000', 'PORT');
  const metricsPort = process.env.METRICS_PORT
    ? serverPort(process.env.METRICS_PORT, 'METRICS_PORT')
    : null;
  if (metricsPort === port)
    throw new Error('METRICS_PORT must differ from PORT');
  const host = process.env.HOST || (development ? '0.0.0.0' : '127.0.0.1');
  const rateLimit = createRateLimitController();
  const websocket = createWsController(port, rateLimit);
  let frontend!: ReturnType<typeof next>;

  const backend = await createBackend(async (app) => {
    // Nest owns the HTTP listener; Next receives page requests on that listener.
    const server = app.getHttpServer();
    frontend = next({ dev: development, httpServer: server, port });
    await frontend.prepare();
    const handlePage = frontend.getRequestHandler();
    server.on('upgrade', websocket.handleUpgrade);
    app.use((request: Request, response: Response, nextRoute: NextFunction) => {
      if (websocket.handleRequest(request, response)) return;
      if (metricsPort !== null) trackHttpResponse(request, response);
      if (rateLimit.handleRequest(request, response)) return;
      const url = new URL(request.url || '/', 'http://localhost');
      const pathname = url.pathname;
      if (
        ['/api/docs', '/api/docs/', '/api/docs/index.html'].includes(pathname)
      ) {
        const denied = jwtGuard(webRequest(request));
        if (denied) {
          response.writeHead(denied.status, Object.fromEntries(denied.headers));
          void denied
            .arrayBuffer()
            .then((body) => response.end(Buffer.from(body)));
          return;
        }
      }
      if (
        pathname === '/api' ||
        pathname.startsWith('/api/') ||
        pathname === '/auth/v1/kakao' ||
        pathname === '/docs' ||
        pathname.startsWith('/docs/')
      ) {
        nextRoute();
        return;
      }
      void handlePage(request, response);
    });
  });

  const metricsServer =
    metricsPort === null
      ? null
      : createServer((request, response) => {
          if (request.method !== 'GET' || request.url !== '/metrics') {
            response.writeHead(404).end();
            return;
          }
          response
            .writeHead(200, {
              'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
              'Cache-Control': 'no-store',
            })
            .end(httpMetrics());
        });
  let metricsTimer: ReturnType<typeof setInterval> | undefined;
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    const timeout = setTimeout(() => process.exit(1), 10_000);
    timeout.unref();
    websocket.close();
    rateLimit.close();
    if (metricsTimer) clearInterval(metricsTimer);
    try {
      await Promise.all([
        backend.app.close(),
        frontend.close(),
        stopReceiptWorker(),
        metricsServer?.listening
          ? new Promise<void>((resolve, reject) =>
              metricsServer.close((error) =>
                error ? reject(error) : resolve(),
              ),
            )
          : undefined,
      ]);
      await disconnectPrismaClients();
      await closeDatabasePools();
      process.exit(0);
    } catch (error) {
      console.error('Application shutdown failed', error);
      process.exit(1);
    }
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  await startBackendWorkers();
  if (metricsServer && metricsPort !== null) {
    await collectDatabaseMetrics();
    metricsTimer = setInterval(() => void collectDatabaseMetrics(), 30_000);
    metricsTimer.unref();
    await new Promise<void>((resolve, reject) => {
      metricsServer.once('error', reject);
      metricsServer.listen(
        metricsPort,
        process.env.HOST || '127.0.0.1',
        resolve,
      );
    });
  }
  await backend.app.listen(port, host);
  const allInterfaces = host === '0.0.0.0' || host === '::';
  const localHost = allInterfaces
    ? 'localhost'
    : host.includes(':')
      ? `[${host}]`
      : host;
  console.log(`Ready on port ${port}\n  Local:   http://${localHost}:${port}`);
  if (allInterfaces) {
    const addresses = new Set(
      Object.values(networkInterfaces()).flatMap((entries) =>
        (entries ?? [])
          .filter((entry) => entry.family === 'IPv4' && !entry.internal)
          .map((entry) => entry.address),
      ),
    );
    for (const address of addresses)
      console.log(`  Network: http://${address}:${port}`);
  }
}
