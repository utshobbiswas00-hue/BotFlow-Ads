/**
 * Settings section sub-page (spec §53–60).
 *
 * One screen of the ten: it reads the `:section` route param, finds the matching
 * section in `SETTINGS_SECTIONS`, and renders ONLY the settings whose key the
 * section owns — using the same row editor (`SettingsRow`), the same query key
 * (`qk.adminSettings`), the same `getSettings` / `saveSetting` calls, and the
 * same `showToast` / `errMsg` handling as the one-screen Settings page.
 *
 * Wiring (owned by the caller, not this module): a single route
 * `/admin/settings/:section` → `<SettingsSectionPage />`, plus the section map
 * exported from `./sections` to build the nav.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { humanize } from '../../../lib/format';
import { qk } from '../../../lib/queryClient';
import { errMsg } from '../../../lib/api';
import { Button } from '../../../components/ui/Button';
import { Icon } from '../../../components/ui/icons';
import { showToast } from '../../../store/uiStore';
import { getSettings, saveSetting } from '../../lib/api';
import { useAdminSession } from '../../lib/session';
import { AdminPageHeader, Section } from '../../components/Kpi';
import { EmptyBlock, QueryState } from '../../components/StateBlock';
import type { AdminSettingsMap } from '../../lib/types';
import { findSettingsSection, SETTINGS_SECTIONS, type SettingsSection } from './sections';
import { parseDraft, SettingsRow, toDraft } from './SettingsRow';

export function SettingsSectionPage() {
  const { section: slug } = useParams<{ section: string }>();
  const queryClient = useQueryClient();
  const { can } = useAdminSession();
  const canManage = can('settings.manage');

  const query = useQuery({ queryKey: qk.adminSettings, queryFn: getSettings });
  const [draft, setDraft] = useState<Record<string, string>>({});

  // Seed the draft once, when the first page of values arrives — copied from
  // Settings.tsx. Re-seeding on every refetch would throw away in-progress edits.
  useEffect(() => {
    if (!query.data) return;
    setDraft((prev) => {
      if (Object.keys(prev).length > 0) return prev;
      const next: Record<string, string> = {};
      for (const [k, v] of Object.entries(query.data!)) next[k] = toDraft(v);
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
  const section = findSettingsSection(slug);

  // The keys this section actually owns, resolved against the live map through
  // the same first-match predicate the partition test exercises.
  const keys = useMemo(() => {
    if (!section) return [];
    return Object.keys(settings)
      .filter((k) => section.match(k))
      .sort();
  }, [settings, section]);

  // Unknown / missing :section — a small panel listing the valid slugs, not a throw.
  if (!section) return <UnknownSection requested={slug} />;

  return (
    <>
      <AdminPageHeader
        title={section.label}
        description={section.description}
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

      <div className="space-y-6">
        <SectionInfo section={section} ownedKeys={keys} />

        <Section title="Values" description="Each setting saves on its own.">
          <QueryState
            isPending={query.isPending}
            isError={query.isError}
            error={query.error}
            onRetry={() => void query.refetch()}
            skeletonRows={5}
          >
            <div className="bg-surface border border-line rounded-2xl divide-y divide-line/60">
              {keys.map((key) => (
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
              {keys.length === 0 ? (
                <p className="p-4 text-sm text-mute">
                  No settings in this section right now.
                </p>
              ) : null}
            </div>
          </QueryState>
        </Section>
      </div>
    </>
  );
}

/** Per-section info panel: the description plus the keys the section owns. */
function SectionInfo({ section, ownedKeys }: { section: SettingsSection; ownedKeys: string[] }) {
  // Prefer the declared ownership; fall back to the live match for "Other",
  // whose membership is defined by exclusion and has no static key list.
  const declared = section.keys.length > 0 ? section.keys : ownedKeys;

  return (
    <Section title="What this section controls">
      <div className="bg-surface border border-line rounded-2xl p-4">
        <p className="text-sm text-mute">{section.description}</p>
        <div className="mt-4">
          <p className="text-[11px] uppercase tracking-wide text-mute font-semibold mb-2">
            Keys in this section ({declared.length})
          </p>
          {declared.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {declared.map((k) => (
                <code
                  key={k}
                  className="num text-[11px] px-2 py-0.5 rounded-lg bg-app border border-line"
                >
                  {k}
                </code>
              ))}
            </div>
          ) : (
            <p className="text-xs text-mute">
              No leftover keys — every backend setting is owned by a named section.
            </p>
          )}
        </div>
      </div>
    </Section>
  );
}

/** Small panel for an unknown or missing `:section`, listing the valid slugs. */
function UnknownSection({ requested }: { requested?: string }) {
  return (
    <>
      <AdminPageHeader
        title="Settings"
        description="Business rules applied at runtime, split into focused sections."
      />
      <EmptyBlock
        icon="doc"
        title="No such settings section"
        message={
          requested
            ? `“${requested}” is not a settings section. Pick one of the sections below.`
            : 'No settings section was requested. Pick one of the sections below.'
        }
        action={
          <div className="flex flex-wrap items-center justify-center gap-2">
            {SETTINGS_SECTIONS.map((s) => (
              <Link
                key={s.slug}
                to={`/admin/settings/${s.slug}`}
                className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border border-line bg-surface text-sm font-medium hover:bg-app"
              >
                {s.icon ? <Icon name={s.icon} size={15} className="text-mute" /> : null}
                {s.label}
              </Link>
            ))}
          </div>
        }
      />
    </>
  );
}

export { findSettingsSection, knownSettingKeys, SETTINGS_SECTIONS } from './sections';
export type { SettingsSection } from './sections';

export default SettingsSectionPage;
