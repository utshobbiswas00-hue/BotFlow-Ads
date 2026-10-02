/**
 * Refunds (§38) — issue an admin refund against a campaign and inspect what has
 * already been refunded.
 *
 * WHAT A REFUND IS
 * `POST /admin/finance/refunds` credits the CAMPAIGN'S ADVERTISER through the
 * ledger: the campaign's held escrow is released back into the advertiser's
 * available balance. Like every other money movement it is an append-only
 * ledger row (`type: REFUND`, with its own per-campaign reference), so it shows
 * up in the ledger and in the audit log rather than only here.
 *
 * THE REFUNDABLE CAP IS THE SERVER'S, NOT OURS
 * The amount that is still refundable depends on live escrow state — how much
 * of the campaign's budget is still held versus already spent or already
 * refunded — and the client cannot see any of it. We deliberately do NOT
 * re-derive or cap the amount in this panel: a client-side copy of that rule
 * would drift from the ledger and, worse, would silently disagree with the
 * server about the one number that decides whether money moves. An over-ask
 * comes back as a 400 that names the real maximum, and `errMsg` surfaces that
 * message verbatim instead of a generic failure.
 *
 * WHY THERE IS NO "REMAINING REFUNDABLE" FIGURE
 * For the same reason: only the server can compute it, so this screen does not
 * render a plausible-looking placeholder for it. It shows what has actually
 * been recorded instead.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDateTime, formatMoney, groupNumber, parseCents } from '../../lib/format';
import { qk } from '../../lib/queryClient';
import { errMsg } from '../../lib/api';
import { Button } from '../../components/ui/Button';
import { Icon } from '../../components/ui/icons';
import { Money } from '../../components/ui/Money';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { showToast } from '../../store/uiStore';
import { createRefund, listTransactions } from '../lib/api';
import { AdminPageHeader, KpiGrid, KpiTile, Section } from '../components/Kpi';
import { DataTable, Mono, TableFooter, TwoLine, type Column } from '../components/DataTable';
import { Pager } from '../components/Pager';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { QueryState } from '../components/StateBlock';
import type { AdminTransactionRow, RefundResult } from '../lib/types';

const LIMIT = 20;

/**
 * Mirrors the server's `refundSchema.reason` minimum. The server is still the
 * authority (a 422 comes back for anything shorter), but enforcing it here
 * means the operator sees a clear message instead of learning the rule from a
 * failed request after they have already typed their explanation.
 */
const MIN_REASON = 10;

export function RefundsPage() {
  const queryClient = useQueryClient();
  const [composerOpen, setComposerOpen] = useState(false);
  const [page, setPage] = useState(1);

  // The ledger endpoint already filters by type, so this is the existing
  // `listTransactions` call — no new API function was added for the refund list.
  const query = useQuery({
    queryKey: [...qk.adminTransactions, { type: 'REFUND', page }],
    queryFn: () => listTransactions({ type: 'REFUND', page, limit: LIMIT }),
  });

  const refund = useMutation({
    mutationFn: (body: { campaignId: string; amountCents: number; reason: string }) =>
      createRefund(body),
    onSuccess: (res: RefundResult) => {
      showToast(
        'success',
        `Refund issued: ${formatMoney(res.amountCents)} to the advertiser (balance now ${formatMoney(
          res.newBalanceCents,
        )}) · ${res.reference}`,
      );
      setComposerOpen(false);
      void queryClient.invalidateQueries({ queryKey: qk.adminTransactions });
      void queryClient.invalidateQueries({ queryKey: qk.adminDashboard });
    },
    // An over-ask is a 400 naming the real maximum. `errMsg` returns the
    // server's message verbatim, which is the whole point — we never invent a
    // cap and we never paraphrase the one the server applies.
    onError: (e) => showToast('error', errMsg(e)),
  });

  const rows = query.data?.items ?? [];
  const pageTotalCents = rows.reduce((sum, r) => sum + r.amountCents, 0);
  const allRefunds = query.data?.total ?? 0;

  const columns: Column<AdminTransactionRow>[] = [
    {
      key: 'reference',
      header: 'Reference',
      render: (t) => (
        <TwoLine
          primary={<Mono title={t.reference}>{t.reference}</Mono>}
          secondary={t.description ? <span className="text-xs">{t.description}</span> : undefined}
        />
      ),
    },
    {
      key: 'user',
      header: 'Advertiser',
      render: (t) => <span className="text-sm">{t.userName}</span>,
    },
    {
      key: 'status',
      header: 'Status',
      hideBelow: 'md',
      render: (t) => <StatusBadge status={t.status} />,
    },
    {
      key: 'amount',
      header: 'Amount',
      align: 'right',
      nowrap: true,
      render: (t) => (
        <span className="num text-sm font-medium">
          <Money cents={t.amountCents} currency={t.currency} signed />
        </span>
      ),
    },
    {
      key: 'balanceAfter',
      header: 'Balance after',
      align: 'right',
      hideBelow: 'lg',
      nowrap: true,
      render: (t) => (
        <span className="num text-xs text-mute">
          <Money cents={t.balanceAfter} currency={t.currency} />
        </span>
      ),
    },
    {
      key: 'created',
      header: 'When',
      align: 'right',
      nowrap: true,
      render: (t) => <span className="text-xs text-mute">{formatDateTime(t.createdAt)}</span>,
    },
  ];

  return (
    <>
      <AdminPageHeader
        title="Refunds"
        description="Release a campaign's held escrow back to its advertiser. Every refund is a ledger row and is audited."
        actions={
          <Button
            size="sm"
            icon={<Icon name="dollar" size={15} />}
            onClick={() => setComposerOpen(true)}
          >
            Issue a refund
          </Button>
        }
      />

      <div className="space-y-6">
        <div className="flex items-start gap-3 bg-surface border border-line rounded-2xl p-4">
          <span className="w-8 h-8 rounded-xl bg-app border border-line flex items-center justify-center shrink-0 text-mute">
            <Icon name="info" size={16} />
          </span>
          <div className="text-xs text-mute max-w-3xl space-y-1.5">
            <p>
              A refund credits the <span className="text-ink font-medium">advertiser&apos;s available
              balance</span> out of the campaign&apos;s held escrow. It moves through the ledger as a
              REFUND row with its own reference, so it can only be applied once and it appears in the
              ledger and audit log — not just on this screen. It cannot exceed what is still
              refundable from that campaign.
            </p>
            <p>
              The <span className="text-ink font-medium">reason is mandatory and is the only durable
              record of why</span> the money was returned. Months later it is what distinguishes a
              deliberate refund from a mistake, so write it for the person who will read the audit
              trail without any other context.
            </p>
            <p>
              Remaining refundable escrow is <span className="text-ink font-medium">not shown
              here</span>: only the server can compute it from live escrow and ledger state. If you
              ask for more than is refundable, the request is refused with the real maximum, and this
              panel shows that message as-is.
            </p>
          </div>
        </div>

        <KpiGrid>
          <KpiTile
            label="Refunds recorded"
            value={groupNumber(allRefunds)}
            sub="All REFUND ledger rows"
            icon="refresh"
          />
          <KpiTile
            label="Refunded on this page"
            value={<Money cents={pageTotalCents} />}
            sub={`Latest ${rows.length} of ${allRefunds}`}
            icon="dollar"
          />
          <KpiTile label="Page" value={groupNumber(page)} sub={`${LIMIT} per page`} icon="doc" />
        </KpiGrid>

        <Section
          title="Recent refunds"
          description="The REFUND rows already on the ledger, newest first — what has actually been returned, not what could be."
          actions={
            <Button
              variant="secondary"
              size="sm"
              icon={<Icon name="refresh" size={15} />}
              onClick={() => void query.refetch()}
            >
              Refresh
            </Button>
          }
        >
          <QueryState
            isPending={query.isPending}
            isError={query.isError}
            error={query.error}
            onRetry={() => void query.refetch()}
          >
            <DataTable
              rows={rows}
              columns={columns}
              rowKey={(t) => t.id}
              emptyTitle="No refunds yet"
              emptyMessage="No REFUND ledger rows exist. A refund issued from this screen will appear here."
            />
            {query.data ? (
              <TableFooter>
                <Pager
                  page={query.data.page}
                  limit={query.data.limit}
                  total={query.data.total}
                  hasMore={query.data.hasMore}
                  busy={query.isFetching}
                  onPage={setPage}
                />
              </TableFooter>
            ) : null}
          </QueryState>
        </Section>
      </div>

      {/*
        The composer and the confirmation are the same dialog on purpose: the
        refund is irreversible and ledger-backed, so the operator composes and
        commits in one place. The amount is typed in DOLLARS and converted with
        `parseCents` — the same string-arithmetic convention the balance
        adjustment uses — so a value like "49.99" becomes 4999 and a float of
        dollars is never sent as cents.
      */}
      <ConfirmDialog
        open={composerOpen}
        title="Issue a refund"
        description="The amount is credited to the campaign's advertiser from the campaign's held escrow, through the ledger, and is audited. The ledger refuses a refund larger than what is still refundable — that maximum is computed server-side."
        confirmLabel="Issue refund"
        danger
        pending={refund.isPending}
        fields={[
          {
            name: 'campaignId',
            label: 'Campaign ID',
            placeholder: 'Internal campaign id',
            required: true,
            mono: true,
            hint: 'The campaign whose escrow is refunded. The advertiser is resolved server-side.',
          },
          {
            name: 'amount',
            label: 'Amount in USD (e.g. 49.99)',
            placeholder: '49.99',
            required: true,
            hint: 'Converted to integer cents exactly — never sent as a float of dollars.',
          },
          {
            name: 'reason',
            label: 'Reason (recorded in the audit trail)',
            type: 'textarea',
            required: true,
            maxLength: 500,
            hint: `Minimum ${MIN_REASON} characters. This is the only durable record of why the refund was made.`,
          },
        ]}
        onCancel={() => setComposerOpen(false)}
        onConfirm={(values) => {
          const campaignId = (values.campaignId ?? '').trim();
          const reason = (values.reason ?? '').trim();
          const amountCents = parseCents(values.amount ?? '');

          if (!campaignId) {
            showToast('error', 'A campaign id is required');
            return;
          }
          if (amountCents === null || amountCents <= 0) {
            showToast('error', 'Enter a positive dollar amount, e.g. 49.99');
            return;
          }
          // The client-side minimum is feedback, not authority: the server
          // enforces its own rule. Refusing short reasons here means the
          // operator gets a clear message instead of a bare 422.
          if (reason.length < MIN_REASON) {
            showToast(
              'error',
              `A refund reason of at least ${MIN_REASON} characters is required — ${reason.length} entered. The API would reject a shorter one.`,
            );
            return;
          }

          refund.mutate({ campaignId, amountCents, reason });
        }}
      />
    </>
  );
}
