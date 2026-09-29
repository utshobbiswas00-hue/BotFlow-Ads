import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, errMsg } from '../../lib/api';
import { formatDate, formatDateTime } from '../../lib/format';
import { showToast } from '../../store/uiStore';
import { PageHeader } from '../../components/layout/PageHeader';
import { Card, CardTitle } from '../../components/ui/Card';
import { Button } from '../../components/ui/Button';
import { Money } from '../../components/ui/Money';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { ErrorState } from '../../components/ui/EmptyState';
import { Skeleton } from '../../components/ui/Skeleton';
import { Icon } from '../../components/ui/icons';
import type { InvoiceView } from './types';
import { downloadStatementCsv, downloadStatementJson } from './download';

/**
 * One invoice — totals and line items exactly as the API returns them.
 * Route: `/billing/:id`.
 *
 * Money rule: subtotalCents / refundCents / totalCents and every line's
 * amountCents are rendered verbatim through <Money>; the UI never sums or
 * rounds anything.
 */
export function InvoiceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [busy, setBusy] = useState<null | 'csv' | 'json'>(null);

  const q = useQuery({
    queryKey: ['billing', 'invoices', id ?? ''],
    queryFn: (): Promise<InvoiceView> => api.get<InvoiceView>(`/api/billing/invoices/${id}`),
    enabled: Boolean(id),
  });

  const inv = q.data;

  const download = async (kind: 'csv' | 'json') => {
    if (!inv) return;
    // Statement for exactly this invoice's period (date portion of the
    // server-issued ISO bounds — same values the backend stamps filenames with).
    const period = { from: inv.periodStart.slice(0, 10), to: inv.periodEnd.slice(0, 10) };
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
      <PageHeader back title={inv?.number ?? 'Invoice'} subtitle="Invoice detail" />

      <div className="mt-3">
        {q.isPending ? (
          <div className="space-y-3">
            <Skeleton className="h-44 rounded-2xl" />
            <Skeleton className="h-56 rounded-2xl" />
          </div>
        ) : q.isError ? (
          <ErrorState message={errMsg(q.error)} onRetry={() => void q.refetch()} />
        ) : inv ? (
          <div className="space-y-3">
            {/* Summary — the API's own totals, displayed as-is */}
            <Card>
              <div className="flex items-center justify-between gap-3">
                <StatusBadge status={inv.status} />
                <span className="text-xs text-mute">Issued {formatDateTime(inv.issuedAt)}</span>
              </div>

              <p className="text-[11px] text-mute uppercase tracking-wide mt-4 mb-1">Billed period</p>
              <p className="text-sm font-medium">
                {formatDate(inv.periodStart)} – {formatDate(inv.periodEnd)}
              </p>

              <div className="mt-4 pt-3 border-t border-line space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-mute">Subtotal</span>
                  <Money cents={inv.subtotalCents} currency={inv.currency} />
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-mute">Refunds</span>
                  <Money cents={inv.refundCents} currency={inv.currency} />
                </div>
                <div className="flex items-center justify-between pt-1">
                  <span className="text-sm font-semibold">Total</span>
                  <Money cents={inv.totalCents} currency={inv.currency} className="text-lg font-bold" />
                </div>
              </div>

              {inv.paidAt && (
                <p className="flex items-center gap-1.5 text-xs text-ok mt-3">
                  <Icon name="check" size={14} />
                  Paid {formatDate(inv.paidAt)}
                </p>
              )}
              <p className="text-[11px] text-mute mt-3">Currency: {inv.currency}</p>
            </Card>

            {/* Line items — the frozen ledger snapshot, one row per entry */}
            <Card>
              <CardTitle>Line items ({inv.lineItems.length})</CardTitle>
              {inv.lineItems.length === 0 ? (
                <p className="text-sm text-mute text-center py-4">No line items on this invoice.</p>
              ) : (
                <div>
                  {inv.lineItems.map((li, i) => (
                    <div
                      key={li.reference + i}
                      className="flex items-start justify-between gap-3 py-2.5 border-b border-line last:border-b-0"
                    >
                      <div className="min-w-0">
                        <p className="text-sm truncate">{li.description}</p>
                        <p className="text-[11px] text-mute mt-0.5 truncate">
                          {formatDate(li.occurredAt)} · {li.reference}
                        </p>
                        {li.quantity !== 1 && (
                          <p className="text-[11px] text-mute mt-0.5">
                            {li.quantity} ×{' '}
                            <Money cents={li.unitAmountCents} currency={inv.currency} className="text-[11px]" />
                          </p>
                        )}
                      </div>
                      <Money
                        cents={li.amountCents}
                        currency={inv.currency}
                        signed
                        className="text-sm font-medium shrink-0"
                      />
                    </div>
                  ))}
                </div>
              )}
            </Card>

            {/* Statement scoped to this invoice's period */}
            <Card>
              <CardTitle>Statement for this period</CardTitle>
              <p className="text-xs text-mute mb-3">
                Export of the completed ledger rows between {formatDate(inv.periodStart)} and{' '}
                {formatDate(inv.periodEnd)}.
              </p>
              <div className="grid grid-cols-2 gap-2.5">
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
          </div>
        ) : null}
      </div>
    </>
  );
}
