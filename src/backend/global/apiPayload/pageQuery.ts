import type {
  PageQueryDTO,
  SearchPageQueryDTO,
} from './dto/req/page.request.dto';
import { badInput } from './errors';
import {
  decodePageCursor,
  type PageQuery,
  type SearchPageQuery,
} from '../util/pagenationUtil';

// Called only after the Nest DTO pipe has validated field types and lengths.
export function parsePageQuery(query: PageQueryDTO): PageQuery {
  return { limit: query.limit, cursor: decodePageCursor(query.cursor) };
}

export function parseSearchPageQuery(
  query: SearchPageQueryDTO,
): SearchPageQuery {
  const page = parsePageQuery(query);
  const search = query.q === undefined ? null : query.q.trim();
  if (search === '') badInput();
  return { ...page, search };
}
