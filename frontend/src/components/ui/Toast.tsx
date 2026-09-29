import { useUiStore, type ToastKind } from '../../store/uiStore';
import { cn } from '../../lib/cn';
import { Icon, type IconName } from './icons';

const STYLES: Record<ToastKind, { icon: IconName; cls: string }> = {
  success: { icon: 'check', cls: 'bg-ok text-white' },
  error: { icon: 'alert', cls: 'bg-danger text-white' },
  warning: { icon: 'alert', cls: 'bg-warn text-white' },
  info: { icon: 'info', cls: 'bg-ink text-white' },
};

/** Global toast container — mount once, inside AppShell. */
export function ToastContainer() {
  const toasts = useUiStore((s) => s.toasts);
  const dismiss = useUiStore((s) => s.dismissToast);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed left-1/2 -translate-x-1/2 top-3 z-[60] w-[min(92%,380px)] space-y-2 pointer-events-none">
      {toasts.map((t) => {
        const s = STYLES[t.kind];
        return (
          <button
            key={t.id}
            onClick={() => dismiss(t.id)}
            className={cn(
              'pointer-events-auto w-full flex items-start gap-2.5 rounded-xl px-3.5 py-3 shadow-lg text-left animate-slideup',
              s.cls,
            )}
          >
            <span className="shrink-0 mt-0.5">
              <Icon name={s.icon} size={17} />
            </span>
            <span className="text-sm font-medium leading-snug">{t.message}</span>
          </button>
        );
      })}
    </div>
  );
}
