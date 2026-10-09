import { TokenService } from '../auth/service/token.service';
import { Inject, Injectable } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { createRateLimitController } from './native';

@Injectable()
export class RateLimitService {
  constructor(@Inject(TokenService) private readonly tokens: TokenService) {}

  private engine?: ReturnType<typeof createRateLimitController>;
  private closed = false;

  private controller() {
    if (this.closed) throw new Error('Rate limiter is closed');
    return (this.engine ??= createRateLimitController(this.tokens));
  }

  handleRequest(request: IncomingMessage, response: ServerResponse) {
    return this.controller().handleRequest(request, response);
  }

  limitWebsocket(token: string | null, socket: Duplex) {
    return this.controller().limitWebsocket(token, socket);
  }

  close() {
    this.closed = true;
    this.engine?.close();
    this.engine = undefined;
  }
}
