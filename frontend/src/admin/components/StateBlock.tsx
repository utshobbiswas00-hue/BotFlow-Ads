/**
 * Loading / empty / error states for admin screens.
 *
 * Thin wrappers over the Mini App's own `EmptyState`, `ErrorState` and
 * `Skeleton` — reusing them keeps the panel visually identical to the rest of
 * the product instead of growing a second design language. The only new piece
 * is `QueryState`, which picks the right one for a react-query result so every
 * screen handles its three states the same way.
 */
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { Icon, type IconName } from '../../components/ui/icons';
import { Skeleton } from '../../components/ui/Skeleton';
import { EmptyState, ErrorState } from '../../components/ui/EmptyState';
import { humanError } from '../../lib/errors';
import { ApiError } from '../../lib/api';

export function LoadingBlock({ rows = 4, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn('space-y-2', className)} aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-12 w-full rounded-xl" />
      ))}
    </div>
  );
}

export function EmptyBlock({
  icon = 'doc',
  title,
  message,
  action,
  className,
}: {
  icon?: IconName;
  title: string;
  message?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('py-8', className)}>
      <EmptyState icon={icon} title={title} message={message} action={action} />
    </div>
  );
}

/**
 * Explains a failure in the panel's own terms. A 401 and a 403 are different
 * problems with different fixes, and saying which one it is saves a support
 * round-trip.
 */
export function ErrorBlock({
  error,
  onRetry,
  className,
}: {
  error: unknown;
  onRetry?: () => void;
  className?: string;
}) {
  const status = error instanceof ApiError ? error.status : undefined;
  const unauthorized = status === 401;
  const forbidden = status === 403;

  const headline = unauthorized
    ? 'Not signed in'
    : forbidden
      ? 'Not permitted'
      : 'Could not load this';

  const detail = unauthorized
    ? 'Open the Mini App from the BotFlow bot so Telegram can sign the session, then reload this panel.'
    : forbidden
      ? `${humanError(error)} An admin can only act on what its permission list allows.`
      : humanError(error);

  return (
    <div className={cn('py-8', className)}>
      <div className="flex flex-col items-center text-center">
        <span className="w-12 h-12 rounded-2xl bg-danger/10 text-danger flex items-center justify-center mb-3">
          <Icon name={forbidden || unauthorized ? 'shield' : 'alert'} size={22} />
        </span>
        <p className="font-semibold text-sm">{headline}</p>
        <p className="text-xs text-mute max-w-md mt-1">{detail}</p>
        {onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            className="mt-4 inline-flex items-center gap-1.5 h-9 px-4 rounded-lg bg-ink text-app text-sm font-medium"
          >
            <Icon name="refresh" size={15} />
            Try again
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** Renders the right block for a react-query result, or the children on success. */
export function QueryState({
  isPending,
  isError,
  error,
  isEmpty,
  emptyTitle = 'Nothing here yet',
  emptyMessage,
  emptyIcon,
  onRetry,
  skeletonRows,
  children,
}: {
  isPending: boolean;
  isError: boolean;
  error?: unknown;
  isEmpty?: boolean;
  emptyTitle?: string;
  emptyMessage?: string;
  emptyIcon?: IconName;
  onRetry?: () => void;
  skeletonRows?: number;
  children: ReactNode;
}) {
  if (isPending) return <LoadingBlock rows={skeletonRows} />;
  if (isError) return <ErrorBlock error={error} onRetry={onRetry} />;
  if (isEmpty) return <EmptyBlock icon={emptyIcon} title={emptyTitle} message={emptyMessage} />;
  return <>{children}</>;
}
