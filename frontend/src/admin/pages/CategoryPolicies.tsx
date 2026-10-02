/**
 * Category policies — which channel categories may run paid ads.
 *
 * Read side is the user-facing `GET /api/categories/policies`, which returns one
 * entry per `ChannelCategory` enum value whether or not a rule row exists
 * (`ALLOWED` + `updatedAt: null` means "no rule"). The write side is
 * `POST /api/admin/ops/categories/policies`, gated by `settings.manage`.
 *
 * The distinction that matters operationally: `REVIEW_REQUIRED` does not block a
 * campaign — it forces the campaign to `PENDING_REVIEW`. `BLOCKED` refuses it
 * outright. The UI says so, because picking the wrong one here is the difference
 * between a queue and a rejection.
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDateTime, humanize } from '../../lib/format';
import { qk } from '../../lib/queryClient';
import { errMsg } from '../../lib/api';
import { Button } from '../../components/ui/Button';
import { Icon } from '../../components/ui/icons';
import { Input } from '../../components/ui/Input';
import { Select } from '../../components/ui/Select';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { showToast } from '../../store/uiStore';
import { getCategoryPolicies, setCategoryPolicy } from '../lib/api';
import { useAdminSession } from '../lib/session';
import { AdminPageHeader, Section } from '../components/Kpi';
import { QueryState } from '../components/StateBlock';
import type { CategoryPolicyValue, CategoryPolicyView } from '../lib/types';

const POLICIES: { value: CategoryPolicyValue; label: string }[] = [
  { value: 'ALLOWED', label: 'Allowed — runs without review' },
  { value: 'REVIEW_REQUIRED', label: 'Review required — forced to PENDING_REVIEW' },
  { value: 'BLOCKED', label: 'Blocked — refuses the campaign' },
];

const POLICY_TONE: Record<CategoryPolicyValue, string> = {
  ALLOWED: 'text-ok',
  REVIEW_REQUIRED: 'text-warn',
  BLOCKED: 'text-danger',
};

export function AdminCategoryPoliciesPage() {
  const queryClient = useQueryClient();
  const { can } = useAdminSession();
  const canManage = can('settings.manage');

  const query = useQuery({ queryKey: qk.adminCategoryPolicies, queryFn: getCategoryPolicies });

  const [draft, setDraft] = useState<
    Record<string, { policy: CategoryPolicyValue; note: string }>
  >({});

  useEffect(() => {
    if (!query.data) return;
    setDraft((prev) => {
      if (Object.keys(prev).length > 0) return prev;
      const next: Record<string, { policy: CategoryPolicyValue; note: string }> = {};
      for (const row of query.data ?? []) {
        next[row.category] = { policy: row.policy, note: row.note ?? '' };
      }
      return next;
    });
  }, [query.data]);

  const save = useMutation({
    mutationFn: (body: { category: string; policy: CategoryPolicyValue; note?: string }) =>
      setCategoryPolicy(body),
    onSuccess: (_r, vars) => {
      showToast('success', `${humanize(vars.category)} set to ${humanize(vars.policy)}`);
      void queryClient.invalidateQueries({ queryKey: qk.adminCategoryPolicies });
    },
    onError: (e) => showToast('error', errMsg(e)),
  });

  const rows: CategoryPolicyView[] = query.data ?? [];
  const nonDefault = rows.filter((r) => r.policy !== 'ALLOWED').length;

  return (
    <>
      <AdminPageHeader
        title="Category policies"
        description={`${nonDefault} of ${rows.length} categories differ from the default. Review-required does not block a campaign — it holds it for a human decision.`}
        actions={
          <Button
            variant="secondary"
            size="sm"
            icon={<Icon name="refresh" size={15} />}
            onClick={() => {
              setDraft({});
              void query.refetch();
            }}
          >
            Reload
          </Button>
        }
      />

      <QueryState
        isPending={query.isPending}
        isError={query.isError}
        error={query.error}
        onRetry={() => void query.refetch()}
        skeletonRows={5}
      >
        <Section
          title="Per-category policy"
          description="Unsaved rows are marked. Setting a category back to Allowed writes the rule explicitly rather than deleting it."
        >
          <div className="bg-surface border border-line rounded-2xl divide-y divide-line/60">
            {rows.map((row) => {
              const current = draft[row.category] ?? { policy: row.policy, note: row.note ?? '' };
              const dirty =
                current.policy !== row.policy || current.note.trim() !== (row.note ?? '').trim();

              return (
                <div key={row.category} className="p-3.5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{humanize(row.category)}</p>
                      <p className="num text-[11px] text-mute">{row.category}</p>
                      <p className="text-[11px] mt-1">
                        <StatusBadge status={row.policy} />{' '}
                        <span className="text-mute">
                          {row.updatedAt
                            ? `set ${formatDateTime(row.updatedAt)}`
                            : 'no rule row — defaulting to Allowed'}
                        </span>
                      </p>
                      {row.note && !dirty ? (
                        <p className="text-[11px] text-mute mt-1">Note: {row.note}</p>
                      ) : null}
                    </div>

                    <div className="flex flex-wrap items-start gap-2 shrink-0">
                      <Select
                        className="w-[17rem]"
                        value={current.policy}
                        disabled={!canManage}
                        onChange={(e) =>
                          setDraft((d) => ({
                            ...d,
                            [row.category]: {
                              policy: e.target.value as CategoryPolicyValue,
                              note: current.note,
                            },
                          }))
                        }
                        options={POLICIES}
                      />
                      <Input
                        className="w-[14rem]"
                        placeholder="Note (optional)"
                        maxLength={300}
                        value={current.note}
                        disabled={!canManage}
                        onChange={(e) =>
                          setDraft((d) => ({
                            ...d,
                            [row.category]: { policy: current.policy, note: e.target.value },
                          }))
                        }
                      />
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={!canManage || !dirty}
                        loading={save.isPending && save.variables?.category === row.category}
                        onClick={() =>
                          save.mutate({
                            category: row.category,
                            policy: current.policy,
                            note: current.note.trim() || undefined,
                          })
                        }
                      >
                        Save
                      </Button>
                    </div>
                  </div>

                  <p className={`text-[11px] mt-1.5 ${POLICY_TONE[current.policy]}`}>
                    {current.policy === 'ALLOWED'
                      ? 'Campaigns in this category are accepted and queued normally.'
                      : current.policy === 'REVIEW_REQUIRED'
                        ? 'Campaigns in this category are accepted but held at PENDING_REVIEW until an admin approves them.'
                        : 'Campaigns in this category are refused at creation.'}
                  </p>
                </div>
              );
            })}
          </div>
        </Section>

        <p className="text-xs text-mute mt-4">
          The category list is the `ChannelCategory` enum, served by the API — a category added to
          the schema appears here on the next load, with no code change.
        </p>
      </QueryState>
    </>
  );
}
