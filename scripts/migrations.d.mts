import type { Client } from 'pg'
export const migrationFiles: string[]
export function applyMigrations(client: Pick<Client, 'query'>): Promise<void>
