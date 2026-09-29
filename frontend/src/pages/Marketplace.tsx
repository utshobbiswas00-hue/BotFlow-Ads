import { useMemo, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { CHANNEL_CATEGORIES, type Paginated } from '@botflow/shared';
import { api, errMsg } from '../lib/api';
import { qk } from '../lib/queryClient';
import type { CategoryPolicy, MarketplaceChannelRow, MarketplaceFilters } from '../lib/contracts';
import { categoryLabel, compactNumber } from '../lib/format';
import { MarketplaceChannelCard, type MarketplaceChannelPolicy } from '../components/domain/ChannelCard';
import { PageHeader } from '../components/layout/PageHeader';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Input } from '../components/ui/Input';
import { Select } from '../components/ui/Select';
import { EmptyState, ErrorState, LoadMore } from '../components/ui/EmptyState';
import { ListSkeleton } from '../components/ui/Skeleton';
import { Icon } from '../components/ui/icons';
import { Link } from 'react-router-dom';

const PAGE_LIMIT = 15;

const COUNTRY_OPTIONS = ['BD', 'IN', 'US', 'GB', 'DE', 'AE', 'SA', 'PK', 'MY', 'ID', 'TR', 'RU', 'CA', 'AU'].map((c) => ({
  value: c,
  label: c,
}));
const LANG_OPTIONS = ['en', 'bn', 'hi', 'ur', 'id', 'ms', 'ar', 'tr', 'ru', 'es'].map((c) => ({ value: c, label: c }));

export function MarketplacePage() {
  const [filters, setFilters] = useState<MarketplaceFilters>({});

  // The API contract (backend GET /api/marketplace) only accepts
  // category/country/language/minSubs/maxSubs/minViews/search — anything else
  // is stripped by validation, so only these are offered here.
  const q = useInfiniteQuery({
    queryKey: [...qk.marketplace, filters, PAGE_LIMIT],
    queryFn: ({ pageParam }): Promise<Paginated<MarketplaceChannelRow>> =>
      api.get<Paginated<MarketplaceChannelRow>>('/api/marketplace', {
        page: pageParam,
        limit: PAGE_LIMIT,
        ...(filters.category ? { category: filters.category } : {}),
        ...(filters.country ? { country: filters.country } : {}),
        ...(filters.language ? { language: filters.language } : {}),
        ...(filters.minSubs ? { minSubs: filters.minSubs } : {}),
        ...(filters.maxSubs ? { maxSubs: filters.maxSubs } : {}),
      }),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.hasMore ? last.page + 1 : undefined),
  });

  /* Category moderation policies. A 404 here simply means no badges. */
  const policies = useQuery({
    queryKey: qk.categoryPolicies,
    queryFn: (): Promise<CategoryPolicy[]> => api.get<CategoryPolicy[]>('/api/categories/policies'),
  });
  const policyByCategory = useMemo(() => {
    const map = new Map<string, CategoryPolicy>();
    for (const p of policies.data ?? []) map.set(p.category, p);
    return map;
  }, [policies.data]);
  const policyFor = (category: string): MarketplaceChannelPolicy | null => {
    const p = policyByCategory.get(category);
    if (!p || p.policy === 'ALLOWED') return null;
    return { state: p.policy, note: p.note };
  };

  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  const setF = (patch: Partial<MarketplaceFilters>): void => setFilters((prev) => ({ ...prev, ...patch }));

  return (
    <>
      <PageHeader title="Channel marketplace" subtitle="Find channels for your next campaign" />

      {/* Filters */}
      <Card className="mt-2 space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Select
            label="Category"
            placeholder="All categories"
            value={filters.category ?? ''}
            onChange={(e) => setF({ category: e.target.value || undefined })}
            options={CHANNEL_CATEGORIES.map((c) => ({ value: c, label: categoryLabel(c) }))}
          />
          <Select
            label="Country"
            placeholder="Any country"
            value={filters.country ?? ''}
            onChange={(e) => setF({ country: e.target.value || undefined })}
            options={COUNTRY_OPTIONS}
          />
          <Select
            label="Language"
            placeholder="Any language"
            value={filters.language ?? ''}
            onChange={(e) => setF({ language: e.target.value || undefined })}
            options={LANG_OPTIONS}
          />
          <Input
            label="Min subscribers"
            type="number"
            inputMode="numeric"
            placeholder="Any"
            value={filters.minSubs ? String(filters.minSubs) : ''}
            onChange={(e) => {
              const n = parseInt(e.target.value, 10);
              setF({ minSubs: Number.isFinite(n) && n > 0 ? n : undefined });
            }}
          />
          <Input
            label="Max subscribers"
            type="number"
            inputMode="numeric"
            placeholder="Any"
            value={filters.maxSubs ? String(filters.maxSubs) : ''}
            onChange={(e) => {
              const n = parseInt(e.target.value, 10);
              setF({ maxSubs: Number.isFinite(n) && n > 0 ? n : undefined });
            }}
          />
          <Button
            variant="ghost"
            onClick={() => setFilters({})}
            icon={<Icon name="refresh" size={15} />}
            className="mt-6"
          >
            Reset
          </Button>
        </div>
      </Card>

      {/* Results */}
      <div className="mt-4">
        <p className="text-xs text-mute mb-2">
          {q.data ? `${items.length} channel${items.length === 1 ? '' : 's'} matched your filters` : 'Searching…'}
        </p>
        {q.isPending ? (
          <ListSkeleton rows={4} />
        ) : q.isError ? (
          <ErrorState message={errMsg(q.error)} onRetry={() => void q.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState icon="search" title="No channels found" message="Try different filters to widen your reach." />
        ) : (
          <>
            <div className="space-y-3">
              {items.map((c) => (
                <MarketplaceChannelCard key={c.id} channel={c} policy={policyFor(c.category)} />
              ))}
            </div>
            <LoadMore hasMore={q.hasNextPage ?? false} loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()} />
          </>
        )}
      </div>

      <div className="mt-4">
        <Link to="/advertise/new">
          <Button full icon={<Icon name="plus" size={16} />}>
            Use these channels in a new campaign
          </Button>
        </Link>
      </div>
    </>
  );
}
