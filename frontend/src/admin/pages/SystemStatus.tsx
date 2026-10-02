/**
 * System status board (spec §27, §28, §83).
 *
 * One tile per subsystem from `GET /api/admin/system`. The server catches every
 * probe individually, so a dead dependency arrives as a single UNKNOWN/OFFLINE
 * entry rather than failing the whole board — this screen therefore does not
 * need to guess which subsystem broke.
 *
 * Status is ALWAYS shown as text (ONLINE / DEGRADED / OFFLINE / UNKNOWN) as well
 * as colour, so the state survives colour-blindness, a monochrome screenshot and
 * the Telegram WebView's theme overrides.
 *
 * Freshness is not a mystery: the board auto-refetches every 30s and says so,
 * and it shows when the data was last updated in addition to each subsystem's
 * own `checkedAt`.
 */
import { useQuery } from '@tanstack/react-query';
import { qk } from '../../lib/queryClient';
import { formatDateTime, humanize } from '../../lib/format';
import { Button } from '../../components/ui/Button';
import { Icon } from '../../components/ui/icons';
import { getSystemStatus } from '../lib/api';
import { AdminPageHeader } from '../components/Kpi';
import { QueryState } from '../components/StateBlock';
import type { SubsystemHealth, SubsystemStatus } from '../lib/types';

/** Visible to the user, and the actual `refetchInterval` below. */
const REFETCH_INTERVAL_MS = 30_000;

const STATUS_TEXT: Record<SubsystemStatus, string> = {
  ONLINE: 'text-ok',
  DEGRADED: 'text-warn',
  OFFLINE: 'text-danger',
  UNKNOWN: 'text-mute',
};

const STATUS_BORDER: Record<SubsystemStatus, string> = {
  ONLINE: 'border-ok/40',
  DEGRADED: 'border-warn/40',
  OFFLINE: 'border-danger/40',
  UNKNOWN: 'border-line',
};

const STATUS_CHIP: Record<SubsystemStatus, string> = {
  ONLINE: 'bg-ok/10 text-ok border-ok/40',
  DEGRADED: 'bg-warn/10 text-warn border-warn/40',
  OFFLINE: 'bg-danger/10 text-danger border-danger/40',
  UNKNOWN: 'bg-mute/10 text-mute border-line',
};

const NAME_LABEL: Record<string, string> = {
  api: 'API',
  database: 'Database',
  redis: 'Redis',
  queues: 'Job queues',
  telegramBot: 'Telegram bot',
  webhook: 'Advertiser webhooks',
};

function subsystemLabel(name: string): string {
  return NAME_LABEL[name] ?? humanize(name);
}

/** Never let an unexpected value render blank: anything unknown shows as UNKNOWN. */
function normalizeStatus(status: SubsystemStatus | undefined): SubsystemStatus {
  return status && status in STATUS_BORDER ? status : 'UNKNOWN';
}

function SubsystemTile({ subsystem }: { subsystem: SubsystemHealth }) {
  const status = normalizeStatus(subsystem.status);
  return (
    <article
      className={`bg-surface border rounded-2xl p-4 ${STATUS_BORDER[status]}`}
      data-testid="subsystem-tile"
      data-status={status}
    >
      <span className="text-sm font-semibold">{subsystemLabel(subsystem.name)}</span>
      {/* The status is a single, explicit word — colour is an accent, never the only signal. */}
      <p
        className={`inline-flex items-center px-2 py-0.5 rounded-md text-sm font-bold tracking-wide border mt-2 ${STATUS_CHIP[status]} ${STATUS_TEXT[status]}`}
        data-testid="subsystem-status"
      >
        {status}
      </p>
      <p className="text-xs text-mute mt-2">{subsystem.detail}</p>
      <p className="text-[11px] text-mute mt-2">Checked {formatDateTime(subsystem.checkedAt)}</p>
    </article>
  );
}

export function SystemStatusPage() {
  const query = useQuery({
    queryKey: qk.adminSystemStatus,
    queryFn: getSystemStatus,
    refetchInterval: REFETCH_INTERVAL_MS,
  });

  const subsystems = query.data ?? [];
  const lastUpdated = query.dataUpdatedAt > 0 ? formatDateTime(new Date(query.dataUpdatedAt).toISOString()) : null;

  return (
    <>
      <AdminPageHeader
        title="System status"
        description="The health of every subsystem the platform depends on. Each probe is independent, so one dead dependency shows as a single tile instead of failing the whole board."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-mute">
              {lastUpdated ? `Updated ${lastUpdated}` : 'Loading…'}
            </span>
            <Button
              variant="secondary"
              size="sm"
              icon={<Icon name="refresh" size={15} />}
              loading={query.isFetching}
              onClick={() => void query.refetch()}
            >
              Refresh
            </Button>
          </div>
        }
      />

      <div className="space-y-4">
        {/* The interval is stated in the UI so freshness is never a mystery. */}
        <p className="text-xs text-mute">
          Auto-refreshes every 30 seconds. Status is shown as a word as well as a colour — colour is
          never the only signal.
        </p>

        {/* By-design UNKNOWN: the reasoning mirrors the backend route comment. */}
        <div className="flex items-start gap-3 bg-surface border border-line rounded-2xl p-4">
          <span className="w-8 h-8 rounded-xl bg-app border border-line flex items-center justify-center shrink-0 text-mute">
            <Icon name="info" size={16} />
          </span>
          <p className="text-xs text-mute max-w-3xl">
            The Telegram bot tile reports UNKNOWN by design when no cached probe exists. The board reads
            grammY&rsquo;s cached bot identity (from a successful getMe) instead of making a live Telegram
            call: calling Telegram on every poll could rate-limit the bot, and a cache miss is reported
            as UNKNOWN rather than resolved with a fresh request. Once the process has cached the
            identity this becomes a pure in-memory read, so polling the board cannot rate-limit the bot.
          </p>
        </div>

        <QueryState
          isPending={query.isPending}
          isError={query.isError}
          error={query.error}
          isEmpty={!query.isPending && !query.isError && subsystems.length === 0}
          emptyTitle="No subsystems reported"
          emptyMessage="The status endpoint returned no subsystems. Try refreshing."
          onRetry={() => void query.refetch()}
          skeletonRows={4}
        >
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {subsystems.map((subsystem) => (
              <SubsystemTile key={subsystem.name} subsystem={subsystem} />
            ))}
          </div>
        </QueryState>
      </div>
    </>
  );
}
