import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { parseDraft, SettingsRow, toDraft } from '../admin/pages/settings/SettingsRow';

// Globals are off in this suite, so Testing Library's auto-cleanup is not
// registered — each render must be torn down explicitly.
afterEach(cleanup);

/**
 * The settings row editor's type-preserving save logic, plus the array-row
 * editability that replaced the old read-only rendering.
 *
 * The load-bearing case is a numeric list: `[50, 25, 10, 5]` is a list of
 * NUMBERS, and the row must submit numbers. A naive `text.split(',')` would
 * submit strings and the backend's `<=` comparison against a budget percentage
 * would silently stop matching. `toDraft`/`parseDraft` are the pair that carries
 * the type across the text round-trip.
 */

function renderRow(overrides: Partial<Parameters<typeof SettingsRow>[0]> = {}) {
  const props = {
    settingKey: 'budget_alert_thresholds',
    original: [50, 25, 10, 5],
    value: toDraft([50, 25, 10, 5]),
    disabled: false,
    saving: false,
    onChange: vi.fn(),
    onSave: vi.fn(),
    ...overrides,
  };
  return render(<SettingsRow {...props} />);
}

describe('settings row — array editability', () => {
  it('renders a list setting as an editable input, not read-only text', () => {
    renderRow();
    const input = screen.getByDisplayValue('[50,25,10,5]');
    expect(input).toBeInTheDocument();
    expect(input).not.toBeDisabled();
    // The old read-only explanation must be gone.
    expect(screen.queryByText(/can only be changed directly in/i)).toBeNull();
    expect(screen.getByText(/List of numbers/i)).toBeInTheDocument();
  });

  it('keeps Save disabled until the draft changes, then enables it', () => {
    const { rerender } = renderRow();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

    rerender(
      <SettingsRow
        settingKey="budget_alert_thresholds"
        original={[50, 25, 10, 5]}
        value="[5,10]"
        disabled={false}
        saving={false}
        onChange={vi.fn()}
        onSave={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });
});

describe('toDraft', () => {
  it('renders an array as compact JSON', () => {
    expect(toDraft([50, 25, 10, 5])).toBe('[50,25,10,5]');
    expect(toDraft(['crypto'])).toBe('["crypto"]');
  });

  it('renders primitives exactly as before', () => {
    expect(toDraft(true)).toBe('true');
    expect(toDraft(false)).toBe('false');
    expect(toDraft(20)).toBe('20');
    expect(toDraft('maintenance')).toBe('maintenance');
    expect(toDraft(null)).toBe('');
  });
});

describe('parseDraft — array items keep their stored type', () => {
  it('keeps a numeric list numeric', () => {
    const result = parseDraft([50, 25, 10, 5], '[5, 10, 25]');
    expect(result).toEqual({ ok: true, value: [5, 10, 25] });
    if (result.ok) {
      for (const item of result.value as unknown[]) expect(typeof item).toBe('number');
    }
  });

  it('keeps a string list as strings', () => {
    expect(parseDraft(['crypto'], '["crypto","telegram_stars"]')).toEqual({
      ok: true,
      value: ['crypto', 'telegram_stars'],
    });
  });

  it('rejects unparseable JSON with a JSON-array message', () => {
    const result = parseDraft([50], '[50');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/JSON array/i);
  });

  it('rejects a non-array value', () => {
    const result = parseDraft([50], '50');
    expect(result.ok).toBe(false);
  });

  it('rejects a wrong item type and names the expected type', () => {
    const result = parseDraft([50], '["50"]');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('number');
  });
});

describe('parseDraft — primitive controls unchanged', () => {
  it('parses booleans', () => {
    expect(parseDraft(false, 'true')).toEqual({ ok: true, value: true });
  });

  it('parses numbers and rejects non-numeric text', () => {
    expect(parseDraft(1, '2.5')).toEqual({ ok: true, value: 2.5 });
    const bad = parseDraft(1, 'not a number');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatch(/valid number/i);
  });

  it('parses an object as JSON and rejects invalid JSON', () => {
    expect(parseDraft({ a: 1 }, '{"a":2}')).toEqual({ ok: true, value: { a: 2 } });
    expect(parseDraft({ a: 1 }, '{').ok).toBe(false);
  });

  it('still refuses to clear a null-defaulted setting', () => {
    const result = parseDraft(null, '');
    expect(result.ok).toBe(false);
  });

  it('passes a plain string through', () => {
    expect(parseDraft('a', 'b')).toEqual({ ok: true, value: 'b' });
  });
});
