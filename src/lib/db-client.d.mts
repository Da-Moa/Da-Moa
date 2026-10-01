import type { Client, ClientConfig, Pool } from 'pg'
export function createDatabaseClient(value: string, options?: ClientConfig & { instrument?: boolean }): Client
export function getDatabasePool(value: string): Pool
