import { PAGINATION } from '@botflow/shared';

export interface PaginationInput {
  page?: number | string;
  limit?: number | string;
}

export interface Pagination {
  page: number;
  limit: number;
  skip: number;
  take: number;
}

export function getPagination(input: PaginationInput = {}): Pagination {
  const page = clamp(toInt(input.page, 1), 1, 100_000);
  const limit = clamp(toInt(input.limit, PAGINATION.DEFAULT_LIMIT), 1, PAGINATION.MAX_LIMIT);
  return { page, limit, skip: (page - 1) * limit, take: limit };
}

export interface PaginatedResult<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
  hasMore: boolean;
}

export function buildPaginated<T>(items: T[], total: number, p: Pagination): PaginatedResult<T> {
  return {
    items,
    page: p.page,
    limit: p.limit,
    total,
    hasMore: p.skip + items.length < total,
  };
}

/** Offset-paginated Prisma helper. */
export async function paginate<T>(
  p: Pagination,
  count: () => Promise<number>,
  find: (args: { skip: number; take: number }) => Promise<T[]>,
): Promise<PaginatedResult<T>> {
  const [total, items] = await Promise.all([count(), find({ skip: p.skip, take: p.take })]);
  return buildPaginated(items, total, p);
}

function toInt(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}
