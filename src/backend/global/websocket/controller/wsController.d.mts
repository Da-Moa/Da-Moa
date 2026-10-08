import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { createRateLimitController } from '../../rateLimit/native';

export function createWsController(
  port: number,
  rateLimit: ReturnType<typeof createRateLimitController>,
): {
  handleRequest(request: IncomingMessage, response: ServerResponse): boolean;
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void;
  close(): void;
};
