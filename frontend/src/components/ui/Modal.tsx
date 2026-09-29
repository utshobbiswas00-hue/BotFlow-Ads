import { useEffect, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { Icon } from './icons';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  /** Render as a bottom sheet (default on mobile) vs centered dialog. */
  sheet?: boolean;
}

export function Modal({ open, onClose, title, children, sheet = true }: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center sm:items-center bg-black/50"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className={cn(
          'w-full max-w-app bg-surface border-line animate-slideup',
          'border-t sm:border rounded-t-3xl sm:rounded-3xl shadow-xl',
          'max-h-[85dvh] overflow-y-auto',
          'px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 sm:pt-5',
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="w-10 h-1 rounded-full bg-line mx-auto mb-3 sm:hidden" />
        {title ? (
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-bold">{title}</h2>
            <button
              onClick={onClose}
              className="p-2 -m-2 text-mute rounded-full active:bg-app"
              aria-label="Close"
            >
              <Icon name="x" size={20} />
            </button>
          </div>
        ) : (
          <button
            onClick={onClose}
            className="sm:hidden absolute top-3 right-3 p-2 -m-2 text-mute rounded-full active:bg-app"
            aria-label="Close"
          >
            <Icon name="x" size={20} />
          </button>
        )}
        {children}
      </div>
    </div>
  );
}
