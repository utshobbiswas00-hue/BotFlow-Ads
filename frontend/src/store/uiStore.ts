import { create } from 'zustand';
import { hapticError, hapticSuccess, hapticWarning } from '../lib/telegram';

export type ToastKind = 'success' | 'error' | 'info' | 'warning';

export interface Toast {
  id: string;
  kind: ToastKind;
  message: string;
}

interface UiState {
  toasts: Toast[];
  /** Push a toast (auto-dismisses). */
  toast: (kind: ToastKind, message: string) => void;
  dismissToast: (id: string) => void;
}

let seq = 0;
const nextId = (): string => `t${Date.now().toString(36)}${(seq++).toString(36)}`;

export const useUiStore = create<UiState>((set, get) => ({
  toasts: [],
  toast: (kind, message) => {
    const id = nextId();
    set({ toasts: [...get().toasts, { id, kind, message }] });
    if (kind === 'success') hapticSuccess();
    else if (kind === 'error') hapticError();
    else if (kind === 'warning') hapticWarning();
    setTimeout(() => get().dismissToast(id), 3500);
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));

/** Convenience shorthands usable outside components. */
export const showToast = (kind: ToastKind, message: string): void => useUiStore.getState().toast(kind, message);
