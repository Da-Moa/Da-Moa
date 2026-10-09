import { Injectable } from '@nestjs/common';
import { createServer, type Server } from 'node:http';
import { collectDatabaseMetrics, httpMetrics } from './httpMetrics.mjs';

@Injectable()
export class MetricsServer {
  private server?: Server;
  private timer?: ReturnType<typeof setInterval>;
  private collecting?: Promise<void>;
  private stopping?: Promise<void>;

  private collect() {
    if (!this.collecting) {
      this.collecting = collectDatabaseMetrics().finally(() => {
        this.collecting = undefined;
      });
    }
    return this.collecting;
  }

  async start(port: number, host: string) {
    if (this.server || this.stopping)
      throw new Error('Metrics server already started or closed');
    this.server = createServer((request, response) => {
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
    await this.collect();
    await new Promise<void>((resolve, reject) => {
      const server = this.server!;
      const failed = (error: Error) => {
        server.off('listening', ready);
        reject(error);
      };
      const ready = () => {
        server.off('error', failed);
        resolve();
      };
      server.once('error', failed);
      server.once('listening', ready);
      server.listen(port, host);
    });
    this.timer = setInterval(() => void this.collect(), 30_000);
    this.timer.unref();
  }

  getUrl() {
    const address = this.server?.address();
    if (!address || typeof address === 'string')
      throw new Error('Metrics server is not listening');
    return `http://${address.address.includes(':') ? `[${address.address}]` : address.address}:${address.port}`;
  }

  stop() {
    this.stopping ??= (async () => {
      if (this.timer) clearInterval(this.timer);
      this.timer = undefined;
      await this.collecting;
      if (this.server?.listening)
        await new Promise<void>((resolve, reject) =>
          this.server!.close((error) => (error ? reject(error) : resolve())),
        );
      this.server = undefined;
    })();
    return this.stopping;
  }
}
