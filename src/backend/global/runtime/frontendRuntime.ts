import { TokenService } from '../auth/service/token.service';
import { Inject, Injectable } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import next from 'next';
import { RateLimitService } from '../rateLimit/rateLimit.service';
import { trackHttpResponse } from '../monitoring/httpMetrics.mjs';
import { nativeJwtGuard } from '../auth/guard/jwt.guard';

@Injectable()
export class FrontendRuntime {
  constructor(@Inject(TokenService) private readonly tokens: TokenService) {}

  private frontend?: ReturnType<typeof next>;
  private server?: Server;
  private readonly upgrades = new Set<
    (request: IncomingMessage, socket: Duplex, head: Buffer) => void
  >();

  async prepare(
    app: INestApplication,
    rateLimit: RateLimitService,
    options: { dev: boolean; port: number; metrics: boolean },
  ) {
    this.server = app.getHttpServer();
    this.frontend = next({
      dev: options.dev,
      httpServer: this.server,
      port: options.port,
    });
    await this.frontend.prepare();
    const handlePage = this.frontend.getRequestHandler();
    app.use((request: Request, response: Response, nextRoute: NextFunction) => {
      if (options.metrics) trackHttpResponse(request, response);
      if (rateLimit.handleRequest(request, response)) return;
      const pathname = new URL(request.url || '/', 'http://localhost').pathname;
      if (
        ['/api/docs', '/api/docs/', '/api/docs/index.html'].includes(pathname)
      ) {
        const denied = nativeJwtGuard(request, this.tokens);
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
      if (this.upgrades.size) {
        void handlePage(request, response);
        return;
      }
      // Next lazily attaches its upgrade handler on the first page request.
      const existing = new Set(this.server!.listeners('upgrade'));
      const handling = handlePage(request, response);
      for (const listener of this.server!.listeners('upgrade'))
        if (!existing.has(listener))
          this.upgrades.add(
            listener as (
              request: IncomingMessage,
              socket: Duplex,
              head: Buffer,
            ) => void,
          );
      void handling;
    });
  }

  async close() {
    try {
      await this.frontend?.close();
    } finally {
      for (const listener of this.upgrades)
        this.server?.off('upgrade', listener);
      this.upgrades.clear();
      this.server = undefined;
      this.frontend = undefined;
    }
  }
}
