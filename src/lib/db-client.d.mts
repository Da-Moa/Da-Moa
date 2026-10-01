import type { Client, ClientConfig } from '@neondatabase/serverless'
export function createDatabaseClient(value: string, options?: ClientConfig & { instrument?: boolean }): Client
