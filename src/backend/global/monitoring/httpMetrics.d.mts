import type { IncomingMessage, ServerResponse } from 'node:http';

export function collectDatabaseMetrics(): Promise<void>;
export function httpMetrics(): string;
export function trackHttpResponse(
  request: IncomingMessage,
  response: ServerResponse,
): void;
