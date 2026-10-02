/**
 * Row-level action buttons with a shared confirm/collect dialog.
 *
 * Every mutating action in the panel goes through here, which guarantees they
 * all behave the same way:
 *  - the dialog states plainly what is about to happen, and to what
 *  - required notes/refs are enforced before the request (mirroring the API)
 *  - the button is disabled while the request is in flight (no double submit)
 *  - the outcome is reported as a toast and the caller's queries are invalidated
 *  - a disabled action says WHY, instead of silently doing nothing
 */
import { useState } from 'react';
import { cn } from '../../lib/cn';
import { errMsg } from '../../lib/api';
import { showToast } from '../../store/uiStore';
import { ConfirmDialog, type DialogField } from './ConfirmDialog';

export interface RowAction {
  key: string;
  label: string;
  danger?: boolean;
  /** When set, the button is disabled and this is its tooltip. */
  disabledReason?: string | null;
  confirmTitle?: string;
  confirmDescription?: string;
  confirmLabel?: string;
  /** Extra inputs the API expects (note, txRef, userId, …). */
  fields?: DialogField[];
  /** Perform the action; throw to surface an error toast. */
  run: (values: Record<string, string>) => Promise<unknown>;
  successMessage?: string;
}

export function RowActions({
  actions,
  onDone,
  className,
}: {
  actions: RowAction[];
  /** Called after a successful action — use to invalidate the list query. */
  onDone?: () => void;
  className?: string;
}) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const open = actions.find((a) => a.key === openKey) ?? null;

  const confirm = async (values: Record<string, string>): Promise<void> => {
    if (!open) return;
    setPending(true);
    try {
      await open.run(values);
      showToast('success', open.successMessage ?? `${open.label} done`);
      setOpenKey(null);
      onDone?.();
    } catch (e) {
      showToast('error', errMsg(e));
    } finally {
      setPending(false);
    }
  };

  if (actions.length === 0) return <span className="text-xs text-mute">—</span>;

  return (
    <>
      <div className={cn('flex flex-wrap items-center justify-end gap-1.5', className)}>
        {actions.map((a) => (
          <button
            key={a.key}
            type="button"
            disabled={Boolean(a.disabledReason)}
            title={a.disabledReason ?? a.confirmTitle ?? a.label}
            onClick={(e) => {
              e.stopPropagation();
              setOpenKey(a.key);
            }}
            className={cn(
              'h-8 px-2.5 rounded-lg border text-xs font-medium whitespace-nowrap transition-colors',
              'disabled:opacity-40 disabled:pointer-events-none',
              a.danger
                ? 'border-danger/40 text-danger hover:bg-danger/10'
                : 'border-line text-ink hover:bg-app',
            )}
          >
            {a.label}
          </button>
        ))}
      </div>

      <ConfirmDialog
        open={open !== null}
        title={open?.confirmTitle ?? open?.label ?? ''}
        description={open?.confirmDescription}
        fields={open?.fields}
        confirmLabel={open?.confirmLabel ?? open?.label}
        danger={open?.danger}
        pending={pending}
        onCancel={() => setOpenKey(null)}
        onConfirm={(values) => void confirm(values)}
      />
    </>
  );
}
