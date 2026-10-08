import type { RealtimePublisher } from '../../util/invalidationUtil';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { createRateLimitController } from '../../rateLimit/native';

export function createWsController(
  rateLimit: ReturnType<typeof createRateLimitController>,
  authenticate: (token: string | null) => Promise<{ status: number; id?: string }>,
  publisher: RealtimePublisher,
): {
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void;
  close(): void;
};
