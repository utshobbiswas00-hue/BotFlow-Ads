/**
 * Export screen (spec §78).
 *
 * One row per exportable table, with a CSV and an Excel (.xlsx) download each.
 * The links are built with `exportDownloadUrl` (already in `../lib/api`) and are
 * PLAIN LINK NAVIGATIONS, not fetches:
 *
 *  - The admin session is an HttpOnly cookie, so a normal navigation carries it
 *    automatically; there is no token for this page to hold or to leak into JS.
 *  - The browser then streams the file straight to disk, which is what makes a
 *    50,000-row extract viable — it never has to fit in a JS buffer.
 *  - Each endpoint applies the SAME `requirePermission` key as the matching list
 *    screen, so an admin who cannot open a list cannot export it either. Nothing
 *    here is a security boundary: the server re-checks every download.
 *
 * PDF is deliberately absent as a file format. A server-side PDF would need a
 * rendering dependency this project does not carry, so the page offers the
 * browser's own "Print / Save as PDF" instead, with a print stylesheet that
 * hides the panel chrome so the printed output is the table.
 */
import { exportDownloadUrl } from '../lib/api';
import type { AdminPermission } from '../lib/permissions';
import { useAdminSession } from '../lib/session';
import { AdminPageHeader, Section } from '../components/Kpi';
import { DataTable, Mono, TwoLine, type Column } from '../components/DataTable';
import { Button } from '../../components/ui/Button';
import { Icon } from '../../components/ui/icons';
import type { ExportEntity, ExportFormat } from '../lib/types';

/**
 * Hard ceiling on data rows in one export. Mirrors `EXPORT_MAX_ROWS` in
 * `backend/src/utils/csv.ts`; the server is authoritative and both formats stop
 * at the same number.
 */
const EXPORT_MAX_ROWS = 50_000;

interface ExportTableDef {
  entity: ExportEntity;
  label: string;
  description: string;
  /** The permission key the export endpoint enforces — the same as the list. */
  permission: AdminPermission;
  /** Filter keys this entity's export accepts, for reference. */
  filters: string;
}

const EXPORT_TABLES: ExportTableDef[] = [
  {
    entity: 'users',
    label: 'Users',
    description: 'Every account with its role flags and wallet totals.',
    permission: 'users.view',
    filters: 'search',
  },
  {
    entity: 'channels',
    label: 'Channels',
    description: 'Publisher channels, pricing and lifetime earnings.',
    permission: 'channels.view',
    filters: 'status',
  },
  {
    entity: 'campaigns',
    label: 'Campaigns',
    description: 'Advertiser campaigns with budgets and schedule.',
    permission: 'campaigns.view',
    filters: 'status',
  },
  {
    entity: 'transactions',
    label: 'Ledger (transactions)',
    description: 'Every money movement, newest first.',
    permission: 'deposits.view',
    filters: 'type, status, userId, from, to',
  },
  {
    entity: 'deposits',
    label: 'Deposits',
    description: 'Deposit requests and their verification status.',
    permission: 'deposits.view',
    filters: 'status',
  },
  {
    entity: 'withdrawals',
    label: 'Withdrawals',
    description: 'Payout requests, net amounts and review flags.',
    permission: 'withdrawals.view',
    filters: 'status',
  },
  {
    entity: 'earnings',
    label: 'Publisher earnings',
    description: 'Per-delivery earnings with gross, fee and net.',
    permission: 'deposits.view',
    filters: 'status, userId, channelId, from, to',
  },
  {
    entity: 'revenue',
    label: 'Revenue by day',
    description: 'Aggregated daily revenue series (at most 366 rows).',
    permission: 'dashboard.view',
    filters: 'days',
  },
];

const FORMAT_LABEL: Record<ExportFormat, string> = {
  csv: 'CSV',
  xlsx: 'Excel (.xlsx)',
};

function DownloadLink({
  entity,
  format,
  allowed,
  permission,
}: {
  entity: ExportEntity;
  format: ExportFormat;
  allowed: boolean;
  permission: AdminPermission;
}) {
  if (!allowed) {
    return (
      <span className="text-xs text-mute" title={`Requires ${permission}`}>
        no access
      </span>
    );
  }
  return (
    <a
      href={exportDownloadUrl(entity, format)}
      className="inline-flex items-center gap-1 text-xs font-medium text-link hover:underline"
      // Plain navigation, not a fetch — see the page comment. No `download`
      // attribute is needed: the server sends Content-Disposition: attachment.
      rel="nofollow"
    >
      {FORMAT_LABEL[format]}
      <Icon name="external" size={12} />
    </a>
  );
}

export function ExportPage() {
  const { can } = useAdminSession();

  const columns: Column<ExportTableDef>[] = [
    {
      key: 'table',
      header: 'Table',
      render: (t) => <TwoLine primary={t.label} secondary={t.description} />,
    },
    {
      key: 'permission',
      header: 'Permission',
      hideBelow: 'md',
      render: (t) => <Mono>{t.permission}</Mono>,
    },
    {
      key: 'filters',
      header: 'Filters',
      hideBelow: 'lg',
      render: (t) => <span className="text-xs text-mute">{t.filters}</span>,
    },
    {
      key: 'csv',
      header: 'CSV',
      align: 'right',
      nowrap: true,
      render: (t) => (
        <DownloadLink entity={t.entity} format="csv" allowed={can(t.permission)} permission={t.permission} />
      ),
    },
    {
      key: 'xlsx',
      header: 'Excel',
      align: 'right',
      nowrap: true,
      render: (t) => (
        <DownloadLink
          entity={t.entity}
          format="xlsx"
          allowed={can(t.permission)}
          permission={t.permission}
        />
      ),
    },
  ];

  return (
    <>
      <div className="export-print-area">
        <AdminPageHeader
          title="Exports"
          description="Download any admin table as CSV or Excel. Columns match the list screens exactly; the server applies the same permission as the list."
        />

        <div className="space-y-5">
          <Section
            title="How these downloads work"
            description="These are plain link navigations, not background requests."
          >
            <ul className="text-sm text-mute space-y-1.5 list-disc pl-5">
              <li>
                The admin session is an <span className="num">HttpOnly</span> cookie, so the browser
                attaches it on a normal navigation. The page never holds the credential.
              </li>
              <li>
                Each download is gated by the <strong>same permission as its list screen</strong>{' '}
                (shown per row). A link is only offered when your session holds that key, and the
                server rejects it regardless of what the UI shows.
              </li>
              <li>
                CSV files open with a UTF-8 BOM so Excel renders non-ASCII names correctly; cells
                that begin with a formula character are neutralised as text.
              </li>
              <li>
                Excel files are real <span className="num">.xlsx</span> workbooks (a ZIP of XML
                parts) generated by the API without any spreadsheet library.
              </li>
            </ul>
          </Section>

          <Section title="Tables">
            <DataTable rows={EXPORT_TABLES} columns={columns} rowKey={(t) => t.entity} />
          </Section>

          <Section
            title="Row limits"
            description="What happens when a table is larger than one export."
            className="export-no-print"
          >
            <ul className="text-sm text-mute space-y-1.5 list-disc pl-5">
              <li>
                Each export returns at most{' '}
                <span className="num font-semibold text-ink">{EXPORT_MAX_ROWS.toLocaleString()}</span>{' '}
                data rows.
              </li>
              <li>
                CSV: when there are more rows than the cap, the file ends with an{' '}
                <Mono># EXPORT TRUNCATED</Mono> notice line. Nothing is dropped silently.
              </li>
              <li>
                Excel: the same cap applies and, when it is hit, a final row states the truncation
                and the row count.
              </li>
              <li>
                At the cap you have an <strong>incomplete extract</strong>. Narrow the list screen
                by its filters and export again to get the remaining rows.
              </li>
            </ul>
          </Section>

          <Section
            title="PDF"
            description="Use the browser's own print-to-PDF."
            actions={
              <span className="export-no-print">
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<Icon name="doc" size={15} />}
                  onClick={() => window.print()}
                >
                  Print / Save as PDF
                </Button>
              </span>
            }
          >
            <p className="text-sm text-mute">
              <span className="export-no-print">
                There is no PDF file format here on purpose:{' '}
              </span>
              a server-side PDF would need a rendering dependency this project deliberately does not
              carry. Instead, use your browser&apos;s <strong>Print</strong> dialog and choose{' '}
              <strong>Save as PDF</strong>. The print stylesheet hides the sidebar and toolbar so the
              printed output is the table above.
            </p>
          </Section>
        </div>
      </div>
    </>
  );
}
