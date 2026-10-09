import { Injectable, Inject } from '@nestjs/common';
import type { Server } from 'node:http';
import { RealtimePublisher } from '../util/invalidationUtil';
import { RealtimeAuthorizationService } from '../auth/service/realtimeAuthorization.service';
import { RateLimitService } from '../rateLimit/rateLimit.service';
import { createWsController } from './controller/wsController.mjs';

@Injectable()
export class RealtimeTransport {
  private server?: Server;
  private controller?: ReturnType<typeof createWsController>;
  private closing?: Promise<void>;

  constructor(
    @Inject(RealtimePublisher) private readonly publisher: RealtimePublisher,
    @Inject(RealtimeAuthorizationService)
    private readonly authorization: RealtimeAuthorizationService,
    @Inject(RateLimitService) private readonly rateLimit: RateLimitService,
  ) {}

  attach(server: Server) {
    if (this.closing) throw new Error('Realtime transport is closed');
    if (this.server === server) return;
    if (this.server) throw new Error('Realtime transport already has a server');
    this.server = server;
    this.controller = createWsController(
      this.rateLimit,
      (token) => this.authorization.authenticate(token),
      this.publisher,
    );
    server.on('upgrade', this.controller.handleUpgrade);
  }

  close() {
    this.closing ??= (async () => {
      if (!this.controller) return;
      this.server?.off('upgrade', this.controller.handleUpgrade);
      await this.controller.close();
      this.controller = undefined;
      this.server = undefined;
    })();
    return this.closing;
  }
}
