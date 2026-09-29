import type { ReactNode } from 'react';
import { Icon, type IconName } from './icons';

export interface EmptyStateProps {
  icon?: IconName;
  title: string;
  message?: string;
  action?: ReactNode;
}

export function EmptyState({ icon = 'doc', title, message, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-12 px-6">
      <div className="w-16 h-16 rounded-2xl bg-surface border border-line flex items-center justify-center text-mute mb-4">
        <Icon name={icon} size={28} />
      </div>
      <h3 className="font-semibold text-base mb-1">{title}</h3>
      {message && <p className="text-sm text-mute max-w-60 mb-4">{message}</p>}
      {action}
    </div>
  );
}

export interface ErrorStateProps {
  message?: string;
  onRetry?: () => void;
}

export function ErrorState({ message = 'Something went wrong', onRetry }: ErrorStateProps) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-12 px-6">
      <div className="w-16 h-16 rounded-2xl bg-danger/10 text-danger flex items-center justify-center mb-4">
        <Icon name="alert" size={28} />
      </div>
      <h3 className="font-semibold text-base mb-1">Can&apos;t load this</h3>
      <p className="text-sm text-mute max-w-64 mb-4">{message}</p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="inline-flex items-center gap-1.5 h-9 px-4 rounded-lg bg-accent text-accentink text-sm font-medium"
        >
          <Icon name="refresh" size={15} />
          Try again
        </button>
      )}
    </div>
  );
}

/** "Load more" footer for paginated lists. */
export function LoadMore({
  hasMore,
  loading,
  onClick,
}: {
  hasMore: boolean;
  loading: boolean;
  onClick: () => void;
}) {
  if (!hasMore && !loading) return null;
  return (
    <button
      onClick={onClick}
      disabled={loading}
      className="w-full h-11 rounded-xl border border-line bg-surface text-sm font-medium text-link disabled:opacity-60 mt-3"
    >
      {loading ? 'Loading…' : 'Load more'}
    </button>
  );
}
