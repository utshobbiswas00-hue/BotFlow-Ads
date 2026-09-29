import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useInfiniteQuery } from '@tanstack/react-query';
import { PAGINATION, type Paginated } from '@botflow/shared';
import { api, errMsg } from '../../lib/api';
import { formatDate } from '../../lib/format';
import { showToast } from '../../store/uiStore';
import { PageHeader } from '../../components/layout/PageHeader';
import { Card, CardTitle } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Money } from '../../components/ui/Money';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { EmptyState, ErrorState, LoadMore } from '../../components/ui/EmptyState';
import { ListSkeleton } from '../../components/ui/Skeleton';
import { Icon } from '../../components/ui/icons';
import type { InvoiceView } from './types';
import { downloadStatementCsv, downloadStatementJson, type StatementPeriod } from './download';

/**
 * Advertiser billing — the list of issued invoices plus the statement
 * (CSV/JSON) export. Route: `/billing`.
 *
 * All money is rendered as the API reports it (totalCents via <Money>) —
 * nothing is summed or rounded in the UI.
 */
export function BillingPage() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState<null | 'csv' | 'json'>(null);

  const q = useInfiniteQuery({
    queryKey: ['billing', 'invoices'],
    queryFn: ({ pageParam }): Promise<Paginated<InvoiceView>> =>
      api.get<Paginated<InvoiceView>>('/api/billing/invoices', {
        page: pageParam,
        limit: PAGINATION.DEFAULT_LIMIT,
      }),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.hasMore ? last.page + 1 : undefined),
  });

  const items = q.data?.pages.flatMap((p) => p.items) ?? [];

  const download = async (kind: 'csv' | 'json') => {
    const period: StatementPeriod = { from: from || undefined, to: to || undefined };
    setBusy(kind);
    try {
      if (kind === 'csv') await downloadStatementCsv(period);
      else await downloadStatementJson(period);
      showToast('success', `Statement (${kind.toUpperCase()}) saved`);
    } catch (e) {
      showToast('error', errMsg(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <PageHeader title="Billing" subtitle="Your invoices and statements" />

      <div className="mt-3 space-y-3">
        {q.isPending ? (
          <ListSkeleton rows={5} />
        ) : q.isError ? (
          <ErrorState message={errMsg(q.error)} onRetry={() => void q.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState
            icon="doc"
            title="No invoices"
            message="Invoices appear here after your first campaign spend."
          />
        ) : (
          <>
            <div className="space-y-3">
              {items.map((inv) => (
                <Link
                  key={inv.id}
                  to={`/billing/${inv.id}`}
                  className="bg-surface border border-line rounded-2xl p-4 flex items-center gap-3 active:opacity-80"
                >
                  <span className="w-10 h-10 rounded-xl bg-accent/10 text-link flex items-center justify-center shrink-0">
                    <Icon name="doc" size={19} />
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm font-semibold truncate">{inv.number}</span>
                    <span className="block text-xs text-mute mt-0.5">
                      {formatDate(inv.periodStart)} – {formatDate(inv.periodEnd)}
                    </span>
                  </span>
                  <span className="text-right shrink-0">
                    <Money cents={inv.totalCents} currency={inv.currency} className="text-sm font-semibold" />
                    <StatusBadge status={inv.status} className="mt-1" />
                  </span>
                  <Icon name="chevronRight" size={16} className="text-mute shrink-0" />
                </Link>
              ))}
            </div>
            <LoadMore
              hasMore={q.hasNextPage ?? false}
              loading={q.isFetchingNextPage}
              onClick={() => void q.fetchNextPage()}
            />
          </>
        )}
      </div>

      <Card className="mt-3">
        <CardTitle>Statement</CardTitle>
        <p className="text-xs text-mute mb-3">
          Row-by-row export of your completed charges and refunds. Leave the period empty for the last 180 days.
        </p>
        <div className="grid grid-cols-2 gap-2.5">
          <Input label="From" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          <Input label="To" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-2.5 mt-3">
          <Button
            variant="secondary"
            size="sm"
            loading={busy === 'csv'}
            disabled={busy !== null}
            onClick={() => void download('csv')}
          >
            CSV
          </Button>
          <Button
            variant="secondary"
            size="sm"
            loading={busy === 'json'}
            disabled={busy !== null}
            onClick={() => void download('json')}
          >
            JSON
          </Button>
        </div>
      </Card>
    </>
  );
}
