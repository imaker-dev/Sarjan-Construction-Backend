export interface PaginationMeta {
  total: number;
  limit: number;
  offset: number;
}

export interface OffsetQuery {
  limit?: number;
  offset?: number;
  page?: number;
  paginated?: boolean;
  q?: string;
}

export function resolveOffsetParams(
  query: { limit?: number; offset?: number; page?: number; paginated?: boolean },
  defaultLimit = 50,
  maxLimit = 100,
): { wantsPagination: boolean; limit: number; offset: number } {
  const limit = Math.min(Math.max(1, query.limit ?? defaultLimit), maxLimit);
  const wantsPagination =
    query.offset !== undefined || query.page !== undefined || query.paginated === true;
  const offset =
    query.offset !== undefined
      ? Math.max(0, query.offset)
      : query.page !== undefined
        ? Math.max(0, (query.page - 1) * limit)
        : 0;
  return { wantsPagination, limit, offset };
}

/**
 * Preserves raw array responses for legacy callers while returning
 * `{ items, pagination }` when `offset`, `page`, or `paginated=true` is passed.
 */
export function paginateArray<T>(
  rows: T[],
  query: OffsetQuery,
  matchesSearch?: (row: T, term: string) => boolean,
): T[] | { items: T[]; pagination: PaginationMeta } {
  const term = query.q?.trim().toLowerCase() ?? '';
  const filtered =
    term.length > 0 && matchesSearch !== undefined
      ? rows.filter((r) => matchesSearch(r, term))
      : rows;
  const { wantsPagination, limit, offset } = resolveOffsetParams(query);
  if (!wantsPagination) return filtered;
  return {
    items: filtered.slice(offset, offset + limit),
    pagination: { total: filtered.length, limit, offset },
  };
}
