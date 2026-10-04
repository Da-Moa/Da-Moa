export type * from '../Domain/Settle/Shared'

export type Page<T> = { items: T[]; nextCursor: string | null }
export type Member = { userId: string; displayName: string; excludedAt: number | null }
