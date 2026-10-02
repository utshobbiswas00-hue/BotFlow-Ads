/**
 * Settings — runtime business configuration, saved one key at a time.
 *
 * Two things the panel is explicit about, because guessing here changes money:
 *
 * 1. `GET /admin/settings` returns the MERGED map (code defaults with the DB rows
 *    applied on top) and only the values. It does not say which keys have a
 *    database override, so this screen cannot show "overridden" vs "default".
 *    That is a limitation of the endpoint, not a styling choice.
 *
 * 2. List-valued settings (`allowed_withdrawal_methods`,
 *    `allowed_deposit_methods`, `budget_alert_thresholds`) are edited as JSON in
 *    the same row editor as every primitive. The row re-types each item from the
 *    stored value so a numeric list stays numeric, and the backend route rejects a
 *    wrong item type with a 400 that names the key.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { humanize } from '../../lib/format';
import { qk } from '../../lib/queryClient';
import { errMsg } from '../../lib/api';
import { Button } from '../../components/ui/Button';
import { Icon } from '../../components/ui/icons';
import { Input } from '../../components/ui/Input';
import { showToast } from '../../store/uiStore';
import { getSettings, saveSetting } from '../lib/api';
import { useAdminSession } from '../lib/session';
import { AdminPageHeader, Section } from '../components/Kpi';
import { QueryState } from '../components/StateBlock';
import { SETTINGS_SECTIONS } from './settings/sections';
import { parseDraft, SettingsRow, toDraft } from './settings/SettingsRow';
import type { AdminSettingsMap } from '../lib/types';

/** Grouping for readability; anything unmatched lands in "Other". */
const GROUPS: { label: string; match: (key: string) => boolean }[] = [
  {
    label: 'Money & fees',
    match: (k) =>
      /fee|budget|price|withdraw|deposit|earning|payout|referral|stars|crypto_price|manual_review|rate/.test(
        k,
      ),
  },
  {
    label: 'Campaigns & delivery',
    match: (k) =>
      /campaign|channel|duplicate|cooldown|approval|house_|paid_ad|reach|slot|view_source|threshold|min_|max_|window/.test(
        k,
      ),
  },
  { label: 'Premium & entitlements', match: (k) => /premium|entitlement/.test(k) },
  { label: 'Platform', match: (k) => /maintenance|support|security|email|invoice/.test(k) },
  { label: 'Integrations', match: (k) => /webhook|api|scan|alert/.test(k) },
];

export function AdminSettingsPage() {
  const queryClient = useQueryClient();
  const { can } = useAdminSession();
  const canManage = can('settings.manage');

  const query = useQuery({ queryKey: qk.adminSettings, queryFn: getSettings });
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState('');

  // Seed the draft once, when the first page of values arrives. Re-seeding on
  // every refetch would throw away in-progress edits.
  useEffect(() => {
    if (!query.data) return;
    setDraft((prev) => {
      if (Object.keys(prev).length > 0) return prev;
      const next: Record<string, string> = {};
      for (const [k, v] of Object.entries(query.data)) next[k] = toDraft(v);
      return next;
    });
  }, [query.data]);

  const save = useMutation({
    mutationFn: ({ key, value }: { key: string; value: unknown }) => saveSetting(key, value),
    onSuccess: (_res, { key }) => {
      showToast('success', `${humanize(key)} saved`);
      void queryClient.invalidateQueries({ queryKey: qk.adminSettings });
    },
    onError: (e) => showToast('error', errMsg(e)),
  });

  const settings: AdminSettingsMap = query.data ?? {};

  const filtered = useMemo(() => {
    const term = filter.trim().toLowerCase();
    return Object.keys(settings)
      .filter((k) => !term || k.includes(term) || humanize(k).toLowerCase().includes(term))
      .sort();
  }, [settings, filter]);

  const grouped = useMemo(() => {
    const placed = new Set<string>();
    const groups = GROUPS.map((g) => ({
      label: g.label,
      keys: filtered.filter((k) => {
        if (placed.has(k) || !g.match(k)) return false;
        placed.add(k);
        return true;
      }),
    })).filter((g) => g.keys.length > 0);
    const rest = filtered.filter((k) => !placed.has(k));
    if (rest.length > 0) groups.push({ label: 'Other', keys: rest });
    return groups;
  }, [filtered]);

  return (
    <>
      <AdminPageHeader
        title="Settings"
        description="Business rules applied at runtime. Values are the merged map — code defaults with any database override already applied — so a number you did not change here may still not be the code default."
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

      {/*
        Spec §53–60 splits settings into named sub-pages. This screen stays the
        "everything, grouped and searchable" view; these links are the way into the
        focused pages, so a section is reachable from here rather than only by
        typing a URL.
      */}
      <nav aria-label="Settings sections" className="flex flex-wrap gap-1.5 mb-5">
        {SETTINGS_SECTIONS.map((s) => (
          <Link
            key={s.slug}
            to={`/admin/settings/${s.slug}`}
            title={s.description}
            className="h-8 px-3 rounded-lg border border-line bg-surface text-xs font-medium inline-flex items-center gap-1.5 hover:bg-app"
          >
            {s.label}
            {s.keys.length > 0 ? (
              <span className="num text-[10px] text-mute">{s.keys.length}</span>
            ) : null}
          </Link>
        ))}
      </nav>

      <div className="mb-5 max-w-md">
        <Input
          label="Filter settings"
          icon="search"
          placeholder="Key or name, e.g. fee"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>

      <QueryState
        isPending={query.isPending}
        isError={query.isError}
        error={query.error}
        onRetry={() => void query.refetch()}
        skeletonRows={5}
      >
        <div className="space-y-8">
          {grouped.map((group) => (
            <Section key={group.label} title={group.label}>
              <div className="bg-surface border border-line rounded-2xl divide-y divide-line/60">
                {group.keys.map((key) => (
                  <SettingsRow
                    key={key}
                    settingKey={key}
                    original={settings[key]}
                    value={draft[key] ?? toDraft(settings[key])}
                    disabled={!canManage}
                    saving={save.isPending && save.variables?.key === key}
                    onChange={(v) => setDraft((d) => ({ ...d, [key]: v }))}
                    onSave={() => {
                      const current = draft[key] ?? toDraft(settings[key]);
                      const parsed = parseDraft(settings[key], current);
                      if (!parsed.ok) {
                        showToast('error', parsed.error);
                        return;
                      }
                      save.mutate({ key, value: parsed.value });
                    }}
                  />
                ))}
              </div>
            </Section>
          ))}
          {grouped.length === 0 ? (
            <p className="text-sm text-mute">No setting matches “{filter}”.</p>
          ) : null}
        </div>
      </QueryState>
    </>
  );
}

