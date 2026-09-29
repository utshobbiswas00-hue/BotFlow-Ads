import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { DEFAULT_CURRENCY } from '@botflow/shared';
import { api, errMsg } from '../lib/api';
import { humanError, isLimitError, isNotFoundError, limitMessage } from '../lib/errors';
import { cn } from '../lib/cn';
import { formatDate, formatMoney } from '../lib/format';
import {
  FREE_TIER,
  entitlementsOf,
  isPremiumActive,
  limitPhrase,
  tierLabel,
} from '../lib/premium';
import type {
  PremiumCurrent,
  PremiumMe,
  PremiumPerk,
  PremiumPlan,
  PremiumPlansResponse,
  PremiumQuota,
  PremiumSubscribeResponse,
  PremiumSubscription,
  PremiumEntitlements,
} from '../lib/premium';
import { campaignsQuota, channelsQuota, premiumKeys, usePremiumMe, usePremiumPlans } from '../hooks/usePremium';
import { useBalance, useInvalidateBalance } from '../hooks/useBalance';
import { showToast } from '../store/uiStore';
import { PageHeader } from '../components/layout/PageHeader';
import { QuotaMeter, UpgradePrompt } from '../components/domain/PremiumUI';
import { Card, CardTitle } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { Money } from '../components/ui/Money';
import { Modal } from '../components/ui/Modal';
import { EmptyState, ErrorState } from '../components/ui/EmptyState';
import { Skeleton } from '../components/ui/Skeleton';
import { Icon } from '../components/ui/icons';

/* re-exported so existing importers keep working */
export type {
  PremiumCurrent,
  PremiumMe,
  PremiumPerk,
  PremiumPlan,
  PremiumPlansResponse,
  PremiumQuota,
  PremiumSubscribeResponse,
  PremiumSubscription,
};

/* ---------- helpers ---------- */

function isFreePlan(p: PremiumPlan): boolean {
  return p.tier.toUpperCase() === 'FREE' || p.code.toLowerCase() === 'free' || p.priceCents === 0;
}

function periodLabel(p: PremiumPlan): string {
  if (p.period) return p.period;
  if (p.durationDays > 0) return `${p.durationDays} days`;
  return 'period';
}

/**
 * The purchase is funded from the wallet and the backend debits it server-side,
 * so the reference no longer comes from an external payment — it is our own
 * idempotency key. Generating it once per confirm attempt means a retry after a
 * dropped response cannot charge twice (the backend replays the same key).
 */
function makePaymentReference(planCode: string): string {
  const rand =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  return `wallet-${planCode.toLowerCase().slice(0, 40)}-${rand}`.slice(0, 128);
}

function errorCodeOf(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code.trim().toUpperCase() : '';
}

/** The wallet debit was refused (backend/src/services/wallet.service.ts:105). */
function isInsufficientBalance(err: unknown): boolean {
  return errorCodeOf(err) === 'INSUFFICIENT_BALANCE';
}

/** `{ requiredCents, availableCents }` carried on the error details. */
function shortfallOf(err: unknown): { requiredCents?: number; availableCents?: number } {
  const details = (err as { details?: unknown } | null)?.details;
  if (!details || typeof details !== 'object') return {};
  const d = details as Record<string, unknown>;
  return {
    requiredCents: typeof d.requiredCents === 'number' ? d.requiredCents : undefined,
    availableCents: typeof d.availableCents === 'number' ? d.availableCents : undefined,
  };
}

function subscribeErrorMessage(err: unknown): string {
  if (isInsufficientBalance(err)) {
    const { requiredCents, availableCents } = shortfallOf(err);
    if (typeof requiredCents === 'number' && typeof availableCents === 'number') {
      return `Your wallet is short. This plan costs ${formatMoney(requiredCents)} and you have ${formatMoney(availableCents)} — add funds and try again.`;
    }
    return 'Your wallet balance is too low for this plan. Add funds and try again.';
  }
  return isLimitError(err) ? limitMessage(err) : errMsg(err);
}

function PremiumSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-24 w-full rounded-2xl" />
      <Skeleton className="h-28 w-full rounded-2xl" />
      <Skeleton className="h-52 w-full rounded-2xl" />
      <Skeleton className="h-64 w-full rounded-2xl" />
    </div>
  );
}

function NotAvailableState() {
  return (
    <EmptyState
      icon="shield"
      title="Premium is not available right now"
      message="Premium plans are switched off on this app at the moment. Check back later."
    />
  );
}

/* ---------- comparison table ---------- */

interface ComparisonColumn {
  key: string;
  label: string;
  cell: (rowKey: string) => { value: unknown; display?: string } | undefined;
}

/** Check / cross for booleans, "Unlimited" for -1 limits, everything else as text. */
function PerkCell({ value, display }: { value: unknown; display?: string }) {
  if (typeof value === 'boolean') {
    return value ? (
      <Icon name="check" size={18} className="text-ok inline-block" aria-label="Included" />
    ) : (
      <Icon name="x" size={16} className="text-mute/50 inline-block" aria-label="Not included" />
    );
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return <span className="num text-[13px] font-medium">{value === -1 ? 'Unlimited' : value.toLocaleString()}</span>;
  }
  if (typeof value === 'string' && value.trim()) {
    return <span className="text-[13px] font-medium">{(display ?? '').trim() || value}</span>;
  }
  if (display && display.trim()) {
    return <span className="text-[13px] font-medium">{display}</span>;
  }
  return <span className="text-xs text-mute">—</span>;
}

function ComparisonTable({
  plans,
  freePlan,
  entitlements,
}: {
  plans: PremiumPlan[];
  freePlan: PremiumPlan | undefined;
  entitlements: PremiumEntitlements;
}) {
  const paidPlans = plans.filter((p) => !isFreePlan(p));

  const columns: ComparisonColumn[] = [
    {
      key: '__free__',
      label: 'Free',
      cell: (k) => {
        if (freePlan) {
          const perk = freePlan.perks.find((x) => x.key === k);
          if (perk) return { value: perk.value, display: perk.display };
        }
        if (k in entitlements) return { value: entitlements[k] };
        return undefined;
      },
    },
    ...paidPlans.map(
      (p): ComparisonColumn => ({
        key: p.code,
        label: p.name,
        cell: (k) => {
          const perk = p.perks.find((x) => x.key === k);
          return perk ? { value: perk.value, display: perk.display } : undefined;
        },
      }),
    ),
  ];

  // Union of row keys, in order of first appearance.
  const rowKeys: string[] = [];
  for (const p of plans) {
    for (const perk of p.perks) {
      if (!rowKeys.includes(perk.key)) rowKeys.push(perk.key);
    }
  }
  for (const k of Object.keys(entitlements)) {
    if (!rowKeys.includes(k)) rowKeys.push(k);
  }
  if (rowKeys.length === 0) return null;

  const labelFor = (key: string): string => {
    for (const p of plans) {
      const perk = p.perks.find((x) => x.key === key);
      if (perk) return perk.label;
    }
    return key;
  };

  return (
    <Card padded={false}>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[430px] text-sm">
          <thead>
            <tr className="border-b border-line">
              <th
                scope="col"
                className="text-left px-3.5 py-3 text-xs font-semibold text-mute uppercase tracking-wide whitespace-nowrap"
              >
                Feature
              </th>
              {columns.map((c) => (
                <th scope="col" key={c.key} className="px-2 py-3 text-xs font-bold text-center min-w-[76px]">
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rowKeys.map((key) => (
              <tr key={key}>
                <td className="px-3.5 py-2.5 text-xs text-mute align-middle">{labelFor(key)}</td>
                {columns.map((c) => {
                  const cell = c.cell(key);
                  return (
                    <td key={c.key} className="px-2 py-2.5 text-center align-middle">
                      <PerkCell value={cell?.value} display={cell?.display} />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/* ---------- plan card ---------- */

function PlanCard({
  plan,
  isCurrent,
  onSubscribe,
}: {
  plan: PremiumPlan;
  isCurrent: boolean;
  onSubscribe: (plan: PremiumPlan) => void;
}) {
  const perks = plan.perks ?? [];
  return (
    <Card className={cn('relative space-y-3.5', plan.isFeatured && 'ring-2 ring-accent')}>
      {plan.isFeatured && plan.badgeText && (
        <span className="absolute -top-2.5 left-4 bg-accent text-accentink text-[11px] font-bold px-2.5 py-0.5 rounded-full whitespace-nowrap">
          {plan.badgeText}
        </span>
      )}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-bold text-[15px]">{plan.name}</p>
          {plan.description && <p className="text-xs text-mute mt-1 leading-relaxed">{plan.description}</p>}
        </div>
        <div className="text-right shrink-0">
          <Money cents={plan.priceCents} currency={plan.currency} className="text-xl font-bold" />
          <p className="text-xs text-mute">/ {periodLabel(plan)}</p>
        </div>
      </div>
      {perks.length > 0 && (
        <ul className="space-y-1.5">
          {perks.map((perk) => (
            <li key={perk.key} className="flex items-baseline gap-2 text-sm">
              <Icon name="check" size={14} className="text-ok shrink-0 translate-y-0.5" />
              <span className="text-mute min-w-0 flex-1">{perk.label}</span>
              <span className="num font-medium text-right shrink-0">{perk.display}</span>
            </li>
          ))}
        </ul>
      )}
      {isCurrent ? (
        <Button variant="secondary" full disabled>
          Current plan
        </Button>
      ) : (
        <Button full variant={plan.isFeatured ? 'primary' : 'secondary'} onClick={() => onSubscribe(plan)}>
          {plan.priceCents === 0 ? 'Switch plan' : 'Subscribe'}
        </Button>
      )}
    </Card>
  );
}

/* ---------- live limits ---------- */

/**
 * What the caller may actually do right now, in plain numbers. Every value
 * comes from `entitlements` / `quotas` on GET /api/premium/me
 * (backend/src/routes/premium.routes.ts:96) — nothing is hardcoded, so the page
 * cannot advertise a limit the backend will not honour.
 */
function LimitsCard({ me }: { me?: PremiumMe | null }) {
  const ent = entitlementsOf(me);
  const channels = channelsQuota(me);
  const campaigns = campaignsQuota(me);
  const fee = typeof ent.platformFeePercent === 'number' ? `${ent.platformFeePercent}%` : '—';

  const hasLimits =
    typeof ent.maxChannels === 'number' ||
    typeof ent.maxActiveCampaigns === 'number' ||
    typeof ent.platformFeePercent === 'number' ||
    channels !== null ||
    campaigns !== null;

  if (!hasLimits) return null;

  return (
    <Card className="space-y-3.5">
      <CardTitle>Your live limits</CardTitle>
      <p className="text-sm leading-relaxed">
        You have {limitPhrase(ent.maxChannels, 'channel')}, {limitPhrase(ent.maxActiveCampaigns, 'active campaign')} and a{' '}
        <span className="num font-semibold">{fee}</span> platform fee.
      </p>
      {channels && <QuotaMeter label="Channels" quota={channels} />}
      {campaigns && <QuotaMeter label="Active campaigns" quota={campaigns} />}
      {!channels && !campaigns && (
        <p className="text-xs text-mute">Usage against those limits shows up on My channels and New campaign.</p>
      )}
    </Card>
  );
}

/* ---------- body (rendered once both queries resolved) ---------- */

function PremiumBody({
  plansQ,
  meQ,
  onSubscribe,
  onCancel,
}: {
  plansQ: UseQueryResult<PremiumPlansResponse, Error>;
  meQ: UseQueryResult<PremiumMe, Error>;
  onSubscribe: (plan: PremiumPlan) => void;
  onCancel: () => void;
}) {
  if (plansQ.isError) {
    if (isNotFoundError(plansQ.error)) return <NotAvailableState />;
    return <ErrorState message={humanError(plansQ.error)} onRetry={() => void plansQ.refetch()} />;
  }
  const plansData = plansQ.data;
  if (!plansData || !plansData.enabled) return <NotAvailableState />;

  const plans = plansData.plans ?? [];
  const freePlan = plans.find(isFreePlan);
  const paidPlans = plans.filter((p) => !isFreePlan(p));

  const me = meQ.data ?? null;
  const current: PremiumCurrent | null = plansData.current ?? null;
  const subscription: PremiumSubscription | null = me?.subscription ?? null;
  const active = isPremiumActive(me) || Boolean(current);
  const tier = me?.tier ?? (active ? 'PREMIUM' : FREE_TIER);
  const expiresAt = subscription?.expiresAt ?? current?.expiresAt ?? null;
  const autoRenew = subscription?.autoRenew ?? current?.autoRenew ?? false;
  const currentCode = current?.code ?? subscription?.code ?? null;
  const entitlements = me?.entitlements ?? plansData.entitlements ?? {};

  return (
    <div className="space-y-4">
      {/* Current membership */}
      <Card>
        <CardTitle>Current membership</CardTitle>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-lg font-bold">{tierLabel(tier)}</p>
            <p className="text-xs text-mute mt-0.5">
              {active
                ? expiresAt
                  ? `Expires ${formatDate(expiresAt)}`
                  : 'Active'
                : 'Free plan — no active subscription'}
            </p>
            {active && <p className="text-xs text-mute mt-0.5">{autoRenew ? 'Auto-renew: on' : 'Auto-renew: off'}</p>}
          </div>
          {active && (
            <Button variant="danger" size="sm" onClick={onCancel}>
              Cancel
            </Button>
          )}
        </div>
      </Card>

      <LimitsCard me={me} />

      {meQ.isError && !isNotFoundError(meQ.error) && (
        <p className="text-xs text-mute flex items-start gap-1.5">
          <Icon name="info" size={14} className="shrink-0 mt-0.5" />
          Live usage is unavailable right now — the limits above still apply.
        </p>
      )}

      {/* Plans */}
      <div>
        <CardTitle>Plans</CardTitle>
        {paidPlans.length === 0 ? (
          <Card>
            <p className="text-sm text-mute text-center py-4">No paid plans are configured yet.</p>
          </Card>
        ) : (
          <div className="space-y-3.5">
            {paidPlans.map((p) => (
              <PlanCard key={p.code} plan={p} isCurrent={p.code === currentCode} onSubscribe={onSubscribe} />
            ))}
          </div>
        )}
      </div>

      {/* Comparison */}
      <div>
        <CardTitle>Compare plans</CardTitle>
        <ComparisonTable plans={plans} freePlan={freePlan} entitlements={entitlements} />
      </div>

      {active && (
        <UpgradePrompt
          title="Extending early costs nothing"
          message="Buying another term now adds it to the end of your current one — you keep every day you already paid for."
          actionLabel="Add another term"
        />
      )}
    </div>
  );
}

/* ---------- purchase sheet ---------- */

type SubscribedState = {
  plan: PremiumPlan;
  expiresAt: string | null;
  replayed: boolean;
  entitlements?: PremiumEntitlements;
};

function PurchaseSheet({
  target,
  done,
  paymentReference,
  error,
  pending,
  balanceCents,
  onConfirm,
  onClose,
}: {
  target: PremiumPlan | null;
  done: SubscribedState | null;
  paymentReference: string;
  error: unknown;
  pending: boolean;
  balanceCents: number | undefined;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const currency = target?.currency ?? DEFAULT_CURRENCY;

  /* ---- success ---- */
  if (target && done) {
    const ent = done.entitlements;
    const rows: Array<{ k: string; v: string }> = [];
    if (ent) {
      if (typeof ent.maxChannels === 'number') {
        rows.push({ k: 'Channels you can register', v: ent.maxChannels < 0 ? 'Unlimited' : ent.maxChannels.toLocaleString() });
      }
      if (typeof ent.maxActiveCampaigns === 'number') {
        rows.push({
          k: 'Active campaigns at once',
          v: ent.maxActiveCampaigns < 0 ? 'Unlimited' : ent.maxActiveCampaigns.toLocaleString(),
        });
      }
      if (typeof ent.platformFeePercent === 'number') {
        rows.push({ k: 'Platform fee', v: `${ent.platformFeePercent}%` });
      }
    }
    return (
      <div className="space-y-4">
        <div className="flex flex-col items-center text-center py-1">
          <div className="w-14 h-14 rounded-full bg-ok/10 text-ok flex items-center justify-center mb-3">
            <Icon name="check" size={26} />
          </div>
          <h3 className="text-base font-bold">
            {done.replayed ? 'This payment was already applied' : `You're on ${done.plan.name}`}
          </h3>
          <p className="text-sm text-mute mt-1 max-w-64">
            {done.expiresAt ? `Active until ${formatDate(done.expiresAt)}.` : 'Your membership is active.'}
            {done.replayed ? ' You were not charged twice.' : ''}
          </p>
        </div>
        {rows.length > 0 && (
          <div className="rounded-xl bg-app px-3.5 py-3 space-y-1.5">
            {rows.map((r) => (
              <div key={r.k} className="flex items-center justify-between gap-3 text-xs">
                <span className="text-mute">{r.k}</span>
                <span className="num font-semibold">{r.v}</span>
              </div>
            ))}
          </div>
        )}
        <Button full onClick={onClose}>
          Done
        </Button>
      </div>
    );
  }

  if (!target) return null;

  /* ---- confirm ---- */
  const balance = balanceCents;
  const shortfall = typeof balance === 'number' && balance < target.priceCents;

  return (
    <div className="space-y-4">
      <div className="rounded-xl bg-app px-3.5 py-3 space-y-2.5">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-semibold truncate">{target.name}</p>
            <p className="text-xs text-mute mt-0.5">{target.description || periodLabel(target)}</p>
          </div>
          <div className="text-right shrink-0">
            <Money cents={target.priceCents} currency={currency} className="text-lg font-bold" />
            <p className="text-[11px] text-mute">/ {periodLabel(target)}</p>
          </div>
        </div>
        <div className="flex items-center justify-between gap-3 text-xs pt-2.5 border-t border-line">
          <span className="text-mute">Paid from</span>
          <span className="text-right">
            Wallet balance
            {typeof balance === 'number' && (
              <>
                {' · '}
                <Money cents={balance} currency={currency} className="font-medium" />
              </>
            )}
          </span>
        </div>
        {target.durationDays > 0 && (
          <div className="flex items-center justify-between gap-3 text-xs">
            <span className="text-mute">Covers</span>
            <span className="num font-medium">{target.durationDays} days</span>
          </div>
        )}
      </div>

      <p className="text-xs text-mute leading-relaxed">
        <Money cents={target.priceCents} currency={currency} className="font-semibold text-ink" /> is taken from your
        wallet balance the moment you confirm — nothing to pay by hand. Your new limits apply
        immediately.
      </p>

      {shortfall && (
        <div className="flex items-start gap-2 rounded-xl bg-warn/10 text-warn px-3.5 py-3 text-xs leading-relaxed">
          <Icon name="alert" size={15} className="shrink-0 mt-0.5" />
          <span>
            Your wallet has <Money cents={balance} currency={currency} className="font-semibold" />, which is not
            enough for this plan. Top up first and the payment will go straight through.
          </span>
        </div>
      )}

      {Boolean(error) && (
        <div className="rounded-xl bg-danger/10 text-danger px-3.5 py-3 text-sm space-y-2.5">
          <div className="flex items-start gap-2">
            <Icon name="alert" size={17} className="shrink-0 mt-0.5" />
            <span>{subscribeErrorMessage(error)}</span>
          </div>
          {isInsufficientBalance(error) && (
            <Link to="/wallet/deposit" className="block">
              <Button full size="sm" variant="secondary" icon={<Icon name="arrowDown" size={15} />}>
                Add funds to wallet
              </Button>
            </Link>
          )}
        </div>
      )}

      <div className="flex gap-2">
        <Button variant="secondary" full onClick={onClose}>
          Not now
        </Button>
        <Button full loading={pending} disabled={shortfall} onClick={onConfirm}>
          Pay {formatMoney(target.priceCents, currency)}
        </Button>
      </div>

      {shortfall && (
        <Link to="/wallet/deposit" className="block">
          <Button full variant="secondary" size="sm" icon={<Icon name="arrowDown" size={15} />}>
            Add funds to wallet
          </Button>
        </Link>
      )}

      <p className="text-[11px] text-mute text-center">
        Reference <span className="num">{paymentReference.slice(0, 18)}…</span> · retries can never double-charge
      </p>
    </div>
  );
}

/* ---------- page ---------- */

export function PremiumPage() {
  const qc = useQueryClient();
  const invalidateBalance = useInvalidateBalance();

  const plansQ = usePremiumPlans();
  const meQ = usePremiumMe();
  const walletQ = useBalance();

  const [target, setTarget] = useState<PremiumPlan | null>(null);
  const [paymentReference, setPaymentReference] = useState('');
  const [done, setDone] = useState<SubscribedState | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');

  const subscribe = useMutation({
    mutationFn: (vars: { plan: PremiumPlan; paymentReference: string }): Promise<PremiumSubscribeResponse> =>
      // No `alreadyPaid` flag: the wallet is debited server-side
      // (backend/src/services/premium.service.ts:293) and that debit IS the
      // payment. Sending anything else would be inventing a field.
      api.post<PremiumSubscribeResponse>('/api/premium/subscribe', {
        planCode: vars.plan.code,
        paymentReference: vars.paymentReference,
      }),
    onSuccess: (data, vars) => {
      setDone({
        plan: vars.plan,
        expiresAt: data?.expiresAt ?? null,
        replayed: Boolean(data?.replayed),
        entitlements: data?.entitlements,
      });
      showToast(
        'success',
        data?.replayed ? 'Already applied — you were not charged twice.' : 'Premium activated.',
      );
      void qc.invalidateQueries({ queryKey: premiumKeys.me });
      void qc.invalidateQueries({ queryKey: premiumKeys.plans });
      invalidateBalance();
    },
    // The message is rendered inside the sheet, next to the amount it refers to.
    onError: () => undefined,
  });

  const cancel = useMutation({
    mutationFn: (body: { reason?: string }): Promise<unknown> => api.post<unknown>('/api/premium/cancel', body),
    onSuccess: () => {
      setCancelOpen(false);
      setCancelReason('');
      showToast('success', 'Auto-renew is off. You keep Premium until the current term ends.');
      void qc.invalidateQueries({ queryKey: premiumKeys.me });
    },
    onError: (e) => showToast('error', humanError(e)),
  });

  const openSubscribe = (plan: PremiumPlan): void => {
    subscribe.reset();
    setDone(null);
    setPaymentReference(makePaymentReference(plan.code));
    setTarget(plan);
  };
  const closeSubscribe = (): void => {
    setTarget(null);
    setDone(null);
    subscribe.reset();
  };
  const confirmSubscribe = (): void => {
    if (!target) return;
    subscribe.mutate({ plan: target, paymentReference });
  };

  const expiresAt = meQ.data?.subscription?.expiresAt ?? plansQ.data?.current?.expiresAt ?? null;

  return (
    <>
      <PageHeader title="Premium" subtitle="Higher limits and extra perks" />
      <div className="space-y-4 mt-2">
        {plansQ.isLoading || meQ.isLoading ? (
          <PremiumSkeleton />
        ) : (
          <PremiumBody
            plansQ={plansQ}
            meQ={meQ}
            onSubscribe={openSubscribe}
            onCancel={() => setCancelOpen(true)}
          />
        )}
      </div>

      {/* Subscribe: confirm the amount, pay from the wallet, then a success state */}
      <Modal
        open={target !== null}
        onClose={closeSubscribe}
        title={done ? 'Payment complete' : target ? `Subscribe · ${target.name}` : 'Subscribe'}
      >
        <PurchaseSheet
          target={target}
          done={done}
          paymentReference={paymentReference}
          error={subscribe.error}
          pending={subscribe.isPending}
          balanceCents={walletQ.data?.availableCents}
          onConfirm={confirmSubscribe}
          onClose={closeSubscribe}
        />
      </Modal>

      {/* Cancel flow */}
      <Modal open={cancelOpen} onClose={() => setCancelOpen(false)} title="Cancel Premium?">
        <div className="space-y-4">
          <p className="text-sm text-mute leading-relaxed">
            {expiresAt
              ? `You will keep Premium until ${formatDate(expiresAt)}. You can subscribe again at any time.`
              : 'Your Premium perks stop at the end of the current period. You can subscribe again at any time.'}
          </p>
          <Input
            label="Reason (optional)"
            placeholder="Tell us why"
            value={cancelReason}
            onChange={(e) => setCancelReason(e.target.value)}
          />
          <div className="flex gap-2">
            <Button variant="secondary" full onClick={() => setCancelOpen(false)}>
              Keep Premium
            </Button>
            <Button
              variant="danger"
              full
              loading={cancel.isPending}
              onClick={() => cancel.mutate(cancelReason.trim() ? { reason: cancelReason.trim() } : {})}
            >
              Cancel
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
