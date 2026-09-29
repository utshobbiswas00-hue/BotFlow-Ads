import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { PageHeader } from '../../components/layout/PageHeader';

export interface LegalLayoutProps {
  title: string;
  /** Human-readable "last updated" string, e.g. "September 2026". */
  updated: string;
  children: ReactNode;
}

/**
 * Shared shell for every legal/policy page: a back-header, a "Last updated"
 * line, and readable prose tuned for a 390px column.
 */
export function LegalLayout({ title, updated, children }: LegalLayoutProps) {
  return (
    <>
      <PageHeader title={title} back />
      <div className="mt-3">
        <p className="text-xs text-mute mb-4">Last updated: {updated}</p>
        <div className="space-y-5 text-[15px] leading-relaxed text-ink/90">{children}</div>
      </div>
    </>
  );
}

/** Numbered section heading for a policy document. */
export function LegalSection({ n, title }: { n: number; title: string }) {
  return (
    <h2 className="text-base font-bold text-ink mt-1">
      <span className="text-mute font-semibold mr-1.5">{n}.</span>
      {title}
    </h2>
  );
}

/** A paragraph within a legal section. */
export function P({ children }: { children: ReactNode }) {
  return <p className="text-sm leading-relaxed text-ink/85">{children}</p>;
}

/** A bulleted list of short items. */
export function Bullets({ items }: { items: ReactNode[] }) {
  return (
    <ul className="space-y-1.5 text-sm leading-relaxed text-ink/85 list-disc pl-5 marker:text-mute">
      {items.map((it, i) => (
        <li key={i}>{it}</li>
      ))}
    </ul>
  );
}

/** Inline link to another legal page, styled as an app link. */
export function LegalLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="text-link font-medium underline underline-offset-2">
      {children}
    </Link>
  );
}
