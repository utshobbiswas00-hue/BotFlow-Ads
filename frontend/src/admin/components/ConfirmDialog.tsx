/**
 * The single dialog behind every destructive or money-moving admin action.
 *
 * Why one component: the API makes a note MANDATORY to reject a deposit, a
 * reason mandatory to reject a withdrawal, and `txRef` mandatory to mark one
 * paid. Collecting those in ad-hoc prompts is how a reject ends up with an
 * empty reason and a 422 the operator cannot explain. Here a field's `required`
 * flag mirrors the API's own rule, so the dialog refuses to submit something the
 * server would refuse anyway — and says which field is missing.
 */
import { useEffect, useState, type ChangeEvent } from 'react';
import { Modal } from '../../components/ui/Modal';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Select } from '../../components/ui/Select';
import { Textarea } from '../../components/ui/Textarea';

export interface DialogField {
  name: string;
  label: string;
  placeholder?: string;
  hint?: string;
  /** Mirrors a server-side requirement — blocks submit, like the API would. */
  required?: boolean;
  maxLength?: number;
  type?: 'text' | 'textarea' | 'number' | 'select' | 'permissions';
  /**
   * For `type: 'permissions'`: the checkbox groups to render. The value travels as
   * a comma-separated list of keys, so the dialog's `Record<string, string>`
   * contract (and every other field type) is untouched.
   */
  groups?: { label: string; keys: readonly string[] }[];
  /** Keys that are declared but wired to no screen — rendered as such, not hidden. */
  unwired?: readonly string[];
  /**
   * Allowed values, for `type: 'select'`. Use it whenever the server validates
   * the value against an enum (`z.nativeEnum`) — a free-text box there is just a
   * guaranteed 422.
   */
  options?: { value: string; label: string }[];
  /** Prefilled value (e.g. the existing address when replacing it). */
  initialValue?: string;
  /** Render as a monospace input (addresses, hashes, ids). */
  mono?: boolean;
}

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description?: string;
  fields?: DialogField[];
  confirmLabel?: string;
  cancelLabel?: string;
  /** Red confirm button (reject, suspend, delete, deactivate). */
  danger?: boolean;
  pending?: boolean;
  onCancel: () => void;
  onConfirm: (values: Record<string, string>) => void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  fields = [],
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  pending = false,
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  // Reset whenever the dialog opens, so one action's note can never leak into
  // the next one. Keyed on the field signature because `fields` is a fresh
  // array on every render.
  const signature = fields.map((f) => `${f.name}:${f.initialValue ?? ''}`).join('|');
  useEffect(() => {
    if (!open) return;
    const next: Record<string, string> = {};
    for (const f of fields) next[f.name] = f.initialValue ?? '';
    setValues(next);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, signature]);

  const submit = (): void => {
    for (const f of fields) {
      const raw = values[f.name] ?? '';
      if (f.required && !raw.trim()) {
        setError(`${f.label} is required`);
        return;
      }
      if (f.type === 'number' && raw.trim() && !/^-?\d+$/.test(raw.trim())) {
        setError(`${f.label} must be a whole number`);
        return;
      }
    }
    setError(null);
    onConfirm(values);
  };

  return (
    <Modal open={open} onClose={pending ? () => undefined : onCancel} title={title}>
      <div className="space-y-4">
        {description ? <p className="text-sm text-mute">{description}</p> : null}

        {fields.map((f) => {
          const value = values[f.name] ?? '';
          const shared = {
            label: f.label,
            placeholder: f.placeholder,
            hint: f.hint,
            maxLength: f.maxLength,
            value,
            className: f.mono ? 'num' : undefined,
            onChange: (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
              setValues((v) => ({ ...v, [f.name]: e.target.value })),
          };

          if (f.type === 'select') {
            return <Select key={f.name} {...shared} options={f.options ?? []} />;
          }
          if (f.type === 'textarea') {
            return <Textarea key={f.name} {...shared} rows={3} />;
          }
          if (f.type === 'permissions') {
            const chosen = new Set(
              value
                .split(',')
                .map((k) => k.trim())
                .filter(Boolean),
            );
            const toggle = (key: string): void => {
              const next = new Set(chosen);
              if (next.has(key)) next.delete(key);
              else next.add(key);
              setValues((v) => ({ ...v, [f.name]: [...next].join(',') }));
            };
            const total = (f.groups ?? []).reduce((n, g) => n + g.keys.length, 0);
            return (
              <div key={f.name} className="space-y-2">
                <div className="text-sm font-medium">{f.label}</div>
                {f.hint ? <p className="text-xs text-mute">{f.hint}</p> : null}
                <div className="space-y-3 rounded-lg border border-line p-3">
                  {(f.groups ?? []).map((g) => (
                    <div key={g.label}>
                      <div className="text-xs font-medium text-mute">{g.label}</div>
                      <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1.5">
                        {g.keys.map((k) => (
                          <label key={k} className="inline-flex items-center gap-1.5 text-xs">
                            <input
                              type="checkbox"
                              className="accent-brand"
                              checked={chosen.has(k)}
                              onChange={() => toggle(k)}
                            />
                            <span className="num">{k}</span>
                            {f.unwired?.includes(k) ? (
                              <span className="text-mute">(no screen comes from this key)</span>
                            ) : null}
                          </label>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="flex items-center gap-2 text-xs text-mute">
                  <span className="num">
                    {chosen.size} of {total} selected
                  </span>
                  <button
                    type="button"
                    className="underline"
                    onClick={() => setValues((v) => ({ ...v, [f.name]: '' }))}
                  >
                    Clear all
                  </button>
                </div>
              </div>
            );
          }
          return (
            <Input key={f.name} {...shared} inputMode={f.type === 'number' ? 'numeric' : undefined} />
          );
        })}

        {error ? <p className="text-xs text-danger">{error}</p> : null}

        <div className="flex gap-2 pt-1">
          <Button variant="secondary" full onClick={onCancel} disabled={pending}>
            {cancelLabel}
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} full loading={pending} onClick={submit}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
