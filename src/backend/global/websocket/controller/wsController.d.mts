import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { createRateLimitController } from '../../rateLimit/native';

export function createWsController(
  rateLimit: ReturnType<typeof createRateLimitController>,
): {
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void;
  close(): void;
};
