/**
 * Premium plans — price and every entitlement, editable without a deploy.
 *
 * `upsertPlan` was written to be driven from the panel but no route ever called
 * it, so a plan's price and benefits were unreachable without a database edit.
 * `POST /admin/premium` upserts on `code`, which is why editing an existing plan
 * simply re-submits the same code. `GET /admin/premium` asks for
 * `listPlans(false)` — every plan including disabled ones — because an admin
 * needs to see what is switched off in order to switch it back on.
 *
 * `benefits` is a partial entitlement set: only the keys declared by the
 * `Entitlements` interface are honoured, and a value whose type does not match the
 * baseline is ignored rather than corrupting the resolved set. This editor
 * therefore only emits numeric or boolean values, and refuses to invent a type
 * for a key it does not know. An empty field omits the key, which means "inherit
 * the baseline" — the honest way to express "no override".
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { humanize } from '../../lib/format';
import { qk } from '../../lib/queryClient';
import { errMsg } from '../../lib/api';
import { Button } from '../../components/ui/Button';
import { Icon } from '../../components/ui/icons';
import { Input } from '../../components/ui/Input';
import { Money } from '../../components/ui/Money';
import { Select } from '../../components/ui/Select';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { showToast } from '../../store/uiStore';
import { listPlans, setPlanActive, upsertPlan, type PlanInput } from '../lib/api';
import { ENTITLEMENT_KEYS } from '../lib/types';
import { useAdminSession } from '../lib/session';
import { AdminPageHeader, Section } from '../components/Kpi';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { QueryState } from '../components/StateBlock';
import type { SubscriptionPlan } from '../lib/types';

const TIERS = ['FREE', 'PREMIUM', 'BUSINESS'];
const PERIODS = ['MONTHLY', 'QUARTERLY', 'YEARLY'];
const BOOLEAN_KEYS = new Set([
  'advancedAnalytics',
  'prioritySupport',
  'featuredMarketplace',
  'autoApproveCampaigns',
]);

export function AdminPlansPage() {
  const queryClient = useQueryClient();
  const { can } = useAdminSession();
  const canManage = can('settings.manage');

  const query = useQuery({ queryKey: qk.adminPlans, queryFn: listPlans });
  const [editing, setEditing] = useState<SubscriptionPlan | 'new' | null>(null);
  const [toggling, setToggling] = useState<SubscriptionPlan | null>(null);

  const toggle = useMutation({
    mutationFn: ({ code, isActive }: { code: string; isActive: boolean }) =>
      setPlanActive(code, isActive),
    onSuccess: (_r, { code, isActive }) => {
      showToast('success', `${code} ${isActive ? 'enabled' : 'disabled'}`);
      setToggling(null);
      void queryClient.invalidateQueries({ queryKey: qk.adminPlans });
    },
    onError: (e) => showToast('error', errMsg(e)),
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: qk.adminPlans });
  };

  return (
    <>
      <AdminPageHeader
        title="Premium plans"
        description="Prices and entitlement overrides. Entitlements are resolved at read time, so a change here takes effect on the next request — no deploy."
        actions={
          canManage ? (
            <Button size="sm" icon={<Icon name="plus" size={15} />} onClick={() => setEditing('new')}>
              New plan
            </Button>
          ) : null
        }
      />

      <QueryState
        isPending={query.isPending}
        isError={query.isError}
        error={query.error}
        onRetry={() => void query.refetch()}
        skeletonRows={3}
      >
        <div className="space-y-4">
          {(query.data ?? []).length === 0 ? (
            <div className="bg-surface border border-line rounded-2xl p-4 text-sm text-mute">
              No plans exist yet. The boot-time seeder normally creates them; you can create one here.
            </div>
          ) : (
            (query.data ?? []).map((plan) => (
              <div key={plan.id} className="bg-surface border border-line rounded-2xl p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-bold">{plan.name}</h3>
                      <span className="num text-xs text-mute">{plan.code}</span>
                      <StatusBadge status={plan.tier} />
                      <StatusBadge status={plan.isActive ? 'ACTIVE' : 'INACTIVE'} />
                      {plan.isFeatured ? <StatusBadge status="FEATURED" /> : null}
                      {plan.badgeText ? (
                        <span className="text-[11px] px-2 py-0.5 rounded-md bg-app border border-line">
                          {plan.badgeText}
                        </span>
                      ) : null}
                    </div>
                    {plan.description ? (
                      <p className="text-sm text-mute mt-1">{plan.description}</p>
                    ) : null}
                    <p className="text-xs text-mute mt-1">
                      {plan.period} · {plan.durationDays} days · sort {plan.sortOrder}
                    </p>
                  </div>
                  <div className="text-right">
                    <div className="num text-lg font-bold">
                      <Money cents={plan.priceCents} currency={plan.currency} />
                    </div>
                    <div className="text-[11px] text-mute">per {plan.period.toLowerCase()}</div>
                  </div>
                </div>

                {plan.benefits && Object.keys(plan.benefits).length > 0 ? (
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {Object.entries(plan.benefits).map(([k, v]) => (
                      <span key={k} className="text-[11px] px-2 py-1 rounded-lg bg-app border border-line num">
                        {k}: {typeof v === 'boolean' ? (v ? 'on' : 'off') : String(v)}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="text-[11px] text-mute mt-3">
                    No entitlement overrides — this plan inherits the baseline values.
                  </p>
                )}

                {canManage ? (
                  <div className="flex flex-wrap gap-2 mt-4">
                    <Button
                      size="sm"
                      variant="secondary"
                      icon={<Icon name="edit" size={14} />}
                      onClick={() => setEditing(plan)}
                    >
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant={plan.isActive ? 'secondary' : 'primary'}
                      icon={<Icon name={plan.isActive ? 'x' : 'check'} size={14} />}
                      onClick={() => setToggling(plan)}
                    >
                      {plan.isActive ? 'Disable' : 'Enable'}
                    </Button>
                  </div>
                ) : null}
              </div>
            ))
          )}
        </div>
      </QueryState>

      {editing ? (
        <PlanEditor
          plan={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            invalidate();
          }}
        />
      ) : null}

      <ConfirmDialog
        open={toggling !== null}
        title={toggling?.isActive ? `Disable ${toggling?.name}?` : `Enable ${toggling?.name}?`}
        description={
          toggling?.isActive
            ? 'A disabled plan can no longer be bought. Existing subscribers are not affected by this switch alone.'
            : 'The plan becomes purchasable again wherever plans are listed.'
        }
        confirmLabel={toggling?.isActive ? 'Disable' : 'Enable'}
        danger={Boolean(toggling?.isActive)}
        pending={toggle.isPending}
        onCancel={() => setToggling(null)}
        onConfirm={() => {
          if (toggling) toggle.mutate({ code: toggling.code, isActive: !toggling.isActive });
        }}
      />
    </>
  );
}

function PlanEditor({
  plan,
  onClose,
  onSaved,
}: {
  plan: SubscriptionPlan | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [code, setCode] = useState(plan?.code ?? '');
  const [name, setName] = useState(plan?.name ?? '');
  const [description, setDescription] = useState(plan?.description ?? '');
  const [tier, setTier] = useState(plan?.tier ?? 'PREMIUM');
  const [period, setPeriod] = useState(plan?.period ?? 'MONTHLY');
  const [price, setPrice] = useState(plan ? (plan.priceCents / 100).toFixed(2) : '');
  const [durationDays, setDurationDays] = useState(String(plan?.durationDays ?? 30));
  const [sortOrder, setSortOrder] = useState(String(plan?.sortOrder ?? 0));
  const [badgeText, setBadgeText] = useState(plan?.badgeText ?? '');
  const [isFeatured, setIsFeatured] = useState(plan?.isFeatured ?? false);
  const [benefits, setBenefits] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    for (const key of ENTITLEMENT_KEYS) {
      const v = plan?.benefits?.[key];
      out[key] = v === undefined ? '' : String(v);
    }
    return out;
  });

  const save = useMutation({
    mutationFn: (input: PlanInput) => upsertPlan(input),
    onSuccess: () => {
      showToast('success', 'Plan saved');
      onSaved();
    },
    onError: (e) => showToast('error', errMsg(e)),
  });

  const submit = (): void => {
    if (!/^[A-Z0-9_]{2,64}$/.test(code)) {
      showToast('error', 'Code must be 2–64 characters of A-Z, 0-9 and _ only');
      return;
    }
    if (name.trim().length < 2) {
      showToast('error', 'Name must be at least 2 characters');
      return;
    }
    const priceCents = Math.round(Number(price) * 100);
    if (!Number.isFinite(priceCents) || priceCents < 0) {
      showToast('error', 'Enter a valid price');
      return;
    }

    // Only emit keys the operator filled in: an omitted key means "inherit the
    // baseline", which is exactly what an empty field communicates.
    const resolved: Record<string, number | boolean> = {};
    for (const key of ENTITLEMENT_KEYS) {
      const raw = (benefits[key] ?? '').trim();
      if (!raw) continue;
      if (BOOLEAN_KEYS.has(key)) {
        if (raw !== 'true' && raw !== 'false') {
          showToast('error', `${key} must be true or false`);
          return;
        }
        resolved[key] = raw === 'true';
      } else {
        const n = Number(raw);
        if (!Number.isInteger(n)) {
          showToast('error', `${key} must be a whole number`);
          return;
        }
        resolved[key] = n;
      }
    }

    save.mutate({
      code,
      name: name.trim(),
      description: description.trim() || undefined,
      tier: tier as PlanInput['tier'],
      period: period as PlanInput['period'],
      priceCents,
      durationDays: Number(durationDays) || undefined,
      sortOrder: Number(sortOrder) || undefined,
      benefits: resolved,
      isFeatured,
      badgeText: badgeText.trim() || undefined,
    });
  };

  return (
    <div className="fixed inset-0 z-50 bg-app overflow-y-auto">
      <div className="max-w-3xl mx-auto p-4 lg:p-6">
        <div className="flex items-center justify-between mb-5">
          <h1 className="text-lg font-bold">{plan ? `Edit ${plan.name}` : 'New plan'}</h1>
          <Button variant="ghost" size="sm" icon={<Icon name="x" size={15} />} onClick={onClose}>
            Close
          </Button>
        </div>

        <div className="bg-surface border border-line rounded-2xl p-4 space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              label="Code (upsert key)"
              className="num"
              value={code}
              maxLength={64}
              hint="A-Z, 0-9 and _ only. An existing code updates that plan."
              onChange={(e) => setCode(e.target.value.toUpperCase())}
            />
            <Input
              label="Name"
              value={name}
              maxLength={120}
              onChange={(e) => setName(e.target.value)}
            />
            <Select
              label="Tier"
              value={tier}
              onChange={(e) => setTier(e.target.value)}
              options={TIERS.map((t) => ({ value: t, label: humanize(t) }))}
            />
            <Select
              label="Period"
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
              options={PERIODS.map((t) => ({ value: t, label: humanize(t) }))}
            />
            <Input
              label="Price (USD)"
              inputMode="decimal"
              placeholder="9.99"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
            />
            <Input
              label="Duration (days)"
              inputMode="numeric"
              value={durationDays}
              onChange={(e) => setDurationDays(e.target.value)}
            />
            <Input
              label="Sort order"
              inputMode="numeric"
              value={sortOrder}
              onChange={(e) => setSortOrder(e.target.value)}
            />
            <Input
              label="Badge text"
              maxLength={40}
              placeholder="Best value"
              value={badgeText}
              onChange={(e) => setBadgeText(e.target.value)}
            />
          </div>

          <Input
            label="Description"
            maxLength={300}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            hint="Clearing this field removes it on save."
          />

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={isFeatured}
              onChange={(e) => setIsFeatured(e.target.checked)}
              className="w-4 h-4"
            />
            Featured
          </label>
        </div>

        <Section
          className="mt-6"
          title="Entitlement overrides"
          description="Leave a field empty to inherit the baseline. Only these keys are honoured — an unknown key would be ignored by the resolver, so none are offered."
        >
          <div className="bg-surface border border-line rounded-2xl divide-y divide-line/60">
            {ENTITLEMENT_KEYS.map((key) => (
              <div key={key} className="flex flex-wrap items-center justify-between gap-3 p-3.5">
                <div className="min-w-0">
                  <p className="text-sm font-medium num">{key}</p>
                  <p className="text-[11px] text-mute">
                    {BOOLEAN_KEYS.has(key) ? 'true / false' : 'whole number'}
                    {key.toLowerCase().includes('cents') ? ' — in cents' : ''}
                  </p>
                </div>
                <Input
                  className="w-48"
                  value={benefits[key] ?? ''}
                  placeholder={BOOLEAN_KEYS.has(key) ? 'true' : 'empty = inherit'}
                  onChange={(e) => setBenefits((b) => ({ ...b, [key]: e.target.value }))}
                />
              </div>
            ))}
          </div>
        </Section>

        <div className="flex gap-2 mt-6">
          <Button variant="secondary" full onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button full loading={save.isPending} onClick={submit}>
            {plan ? 'Save plan' : 'Create plan'}
          </Button>
        </div>
      </div>
    </div>
  );
}
