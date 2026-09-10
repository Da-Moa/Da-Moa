import type { Client } from '@neondatabase/serverless'
export const migrationFiles: string[]
export function applyMigrations(client: Pick<Client, 'query'>): Promise<void>
