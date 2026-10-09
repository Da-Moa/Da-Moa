import type { SearchPageQuery } from '../../../global/util/pagenationUtil';
import type { RoundStatus } from '../../../../shared/domain/settle';

export type RoundListQuery = SearchPageQuery & {
  status: RoundStatus | 'active' | null;
};
