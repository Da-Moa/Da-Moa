import { badInput } from '../apiPayload/errors';
import type { Page } from '../../../shared/domainTypes';

export type PageCursor = { createdAt: string; id: string };
export type PageQuery = { limit: number; cursor: PageCursor | null };
export type SearchPageQuery = PageQuery & { search: string | null };

// Cursor position is an application contract, decoded once after DTO validation.
export function decodePageCursor(
  encoded: string | undefined,
): PageCursor | null {
  if (encoded !== undefined) {
    try {
      const value = JSON.parse(Buffer.from(encoded, 'base64url').toString());
      if (
        !value ||
        typeof value.createdAt !== 'string' ||
        !/^\d+$/.test(value.createdAt) ||
        value.createdAt !== value.createdAt.trim() ||
        value.createdAt.length > 16 ||
        !Number.isSafeInteger(Number(value.createdAt)) ||
        typeof value.id !== 'string' ||
        !/^[\w-]{1,128}$/.test(value.id) ||
        value.id !== value.id.trim()
      )
        throw new Error();
      return { createdAt: value.createdAt, id: value.id };
    } catch {
      badInput('invalid_cursor', '목록을 다시 불러와 주세요');
    }
  }
  return null;
}

export function pageOf<T>(
  rows: T[],
  limit: number,
  position: (item: T) => { createdAt: number; id: string },
): Page<T> {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  const value = last ? position(last) : null;
  return {
    items,
    nextCursor:
      rows.length > limit && value
        ? Buffer.from(
            JSON.stringify({
              id: value.id,
              createdAt: String(value.createdAt),
            }),
          ).toString('base64url')
        : null,
  };
}
