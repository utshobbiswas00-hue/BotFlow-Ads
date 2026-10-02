/**
 * The single setting-row editor, lifted verbatim from `pages/Settings.tsx`.
 *
 * This is deliberately the SAME component the one-screen Settings page uses:
 * the boolean toggle, the number/text input, the multiline textarea, the
 * per-key Save, the `dirty` comparison, and the `toDraft` / `parseDraft` pair
 * are the type-preserving save logic — the part that must not diverge. The
 * sub-page module renders exactly this row, only filtered to one section.
 *
 * The two behaviours that are easy to get subtly wrong and are therefore kept
 * byte-for-byte:
 *   - a LIST-valued setting is edited as JSON, and `parseDraft` re-types every
 *     item from the stored value so `[50, 25, 10, 5]` submits NUMBERS rather than
 *     the strings a naive `text.split(',')` would produce (which would silently
 *     break the numeric threshold comparison at runtime);
 *   - a null-defaulted setting cannot be cleared back to null.
 */
import { Button } from '../../../components/ui/Button';
import { Input } from '../../../components/ui/Input';
import { Textarea } from '../../../components/ui/Textarea';
import { humanize } from '../../../lib/format';

/** Long-form text settings that deserve a textarea rather than a one-line box. */
const MULTILINE = new Set(['maintenance_message', 'email_reply_to']);

export function SettingsRow({
  settingKey,
  original,
  value,
  disabled,
  saving,
  onChange,
  onSave,
}: {
  settingKey: string;
  original: unknown;
  value: string;
  disabled: boolean;
  saving: boolean;
  onChange: (next: string) => void;
  onSave: () => void;
}) {
  const isArray = Array.isArray(original);
  const isBoolean = typeof original === 'boolean';
  const isNumber = typeof original === 'number';
  const dirty = value !== toDraft(original);

  return (
    <div className="p-3.5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{humanize(settingKey)}</p>
          <p className="num text-[11px] text-mute">{settingKey}</p>
        </div>

        <div className="flex items-start gap-2 shrink-0">
          {isArray ? (
            <Input
              className="w-[18rem] num"
              value={value}
              disabled={disabled}
              placeholder={JSON.stringify(original)}
              onChange={(e) => onChange(e.target.value)}
            />
          ) : isBoolean ? (
            <button
              type="button"
              disabled={disabled}
              onClick={() => onChange(value === 'true' ? 'false' : 'true')}
              className={
                value === 'true'
                  ? 'h-9 px-3 rounded-lg bg-ink text-app text-xs font-semibold disabled:opacity-40'
                  : 'h-9 px-3 rounded-lg border border-line bg-surface text-xs font-semibold text-mute disabled:opacity-40'
              }
            >
              {value === 'true' ? 'On' : 'Off'}
            </button>
          ) : MULTILINE.has(settingKey) ? (
            <Textarea
              className="w-[18rem]"
              rows={2}
              value={value}
              disabled={disabled}
              onChange={(e) => onChange(e.target.value)}
            />
          ) : (
            <Input
              className="w-[18rem]"
              inputMode={isNumber ? 'numeric' : undefined}
              value={value}
              disabled={disabled}
              onChange={(e) => onChange(e.target.value)}
            />
          )}

          <Button
            size="sm"
            variant="secondary"
            disabled={disabled || !dirty}
            loading={saving}
            onClick={onSave}
          >
            Save
          </Button>
        </div>
      </div>

      {isArray ? (
        <p className="text-[11px] text-mute mt-2">
          List of {arrayItemLabel(original)}. Enter a JSON array — e.g.{' '}
          <code className="num">{JSON.stringify(original)}</code>. Items keep the type they are
          written with, so numbers must stay unquoted.
        </p>
      ) : dirty ? (
        <p className="text-[11px] text-mute mt-2">Unsaved change.</p>
      ) : null}
    </div>
  );
}

/** Render a stored value as editable text. */
export function toDraft(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

/** The primitive types present in a stored list, e.g. `['number']`. */
function arrayItemTypes(value: readonly unknown[]): string[] {
  return [...new Set(value.map((item) => typeof item))];
}

/** Human label for the item type(s) a stored list holds, for the inline hint. */
function arrayItemLabel(value: readonly unknown[]): string {
  const types = arrayItemTypes(value).filter(
    (t) => t === 'string' || t === 'number' || t === 'boolean',
  );
  if (types.length === 0) return 'values';
  if (types.length === 1) return `${types[0]}s`;
  return types.join(' or ') + ' values';
}

/** Convert the edited text back to the type the server stored. */
export function parseDraft(
  original: unknown,
  text: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  if (typeof original === 'boolean') return { ok: true, value: text === 'true' };
  if (typeof original === 'number') {
    const n = Number(text);
    if (!Number.isFinite(n)) return { ok: false, error: 'Enter a valid number' };
    return { ok: true, value: n };
  }
  if (Array.isArray(original)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, error: 'Enter a valid JSON array, e.g. ["crypto"]' };
    }
    if (!Array.isArray(parsed)) {
      return { ok: false, error: 'This setting is a list — enter a JSON array' };
    }

    // Re-type from the STORED value, not from the text: a list that held numbers
    // must keep numbers, otherwise `[50, 25]` would be saved as strings and the
    // numeric comparison that reads it would silently stop matching.
    const expected = arrayItemTypes(original);
    if (expected.length === 0) {
      const bad = parsed.find(
        (item) =>
          typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean',
      );
      if (bad !== undefined) {
        return { ok: false, error: 'List items must be strings, numbers or booleans' };
      }
    } else {
      const bad = parsed.find((item) => !expected.includes(typeof item));
      if (bad !== undefined) {
        return {
          ok: false,
          error: `List items must be ${expected.join(' or ')} — got ${typeof bad}`,
        };
      }
    }
    return { ok: true, value: parsed };
  }
  if (original !== null && typeof original === 'object') {
    try {
      return { ok: true, value: JSON.parse(text) as unknown };
    } catch {
      return { ok: false, error: 'Enter valid JSON for this setting' };
    }
  }
  if (original === null && text.trim() === '') {
    return {
      ok: false,
      error: 'This value is NULL by default and the API cannot set it back to NULL',
    };
  }
  return { ok: true, value: text };
}
