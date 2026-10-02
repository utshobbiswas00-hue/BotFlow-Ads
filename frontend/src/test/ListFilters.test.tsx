import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ListFilters, type ListFiltersValue } from '../admin/components/ListFilters';

/**
 * The range guard in `ListFilters` (§79).
 *
 * The component is controlled: the page owns the URL, this owns the draft. So
 * the contract under test is narrow but load-bearing —
 *   - a backwards window is shown to the operator and NEVER forwarded;
 *   - an equal window is a real, valid window (the API's `from > to` check is
 *     strict, so `from === to` must pass);
 *   - an open-ended window (only one side set) is valid and is forwarded.
 *
 * The server independently 400s `from > to`; these tests pin the client's
 * fast-feedback guard only. No network is involved.
 */

function renderFilters(initial: Partial<ListFiltersValue> = {}) {
  const onChange = vi.fn();
  const onReset = vi.fn();

  function Harness() {
    const [value, setValue] = useState<ListFiltersValue>({
      from: '',
      to: '',
      sort: '',
      ...initial,
    });
    return (
      <ListFilters
        sortable="users"
        value={value}
        onChange={(next) => {
          onChange(next);
          setValue(next);
        }}
        onReset={() => {
          onReset();
          setValue({ from: '', to: '', sort: '' });
        }}
      />
    );
  }

  render(<Harness />);
  return { onChange, onReset };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ListFilters — date range validation', () => {
  it('rejects from > to and never forwards the invalid pair', () => {
    const { onChange } = renderFilters();

    // from is set first: only one side is set, so this is a valid open window.
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-10' } });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith({ from: '2026-10-10', to: '', sort: '' });

    // Now close it the wrong way round: from > to.
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-10-05' } });

    // The invalid pair is NOT committed...
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalledWith({ from: '2026-10-10', to: '2026-10-05', sort: '' });
    // ...and the operator is told why, inline.
    expect(screen.getByText(/must be on or before/i)).toBeInTheDocument();
  });

  it('rejects to < from when the later-bounded field is edited second', () => {
    const { onChange } = renderFilters();

    // to is set first (valid open window), then from overshoots it.
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-10-05' } });
    expect(onChange).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-10' } });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/must be on or before/i)).toBeInTheDocument();
  });

  it('accepts equal bounds — the API refuses only from > to', () => {
    const { onChange } = renderFilters();

    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-05' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-10-05' } });

    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith({ from: '2026-10-05', to: '2026-10-05', sort: '' });
    expect(screen.queryByText(/must be on or before/i)).not.toBeInTheDocument();
  });

  it('accepts a one-sided window and forwards it', () => {
    const { onChange } = renderFilters();

    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-01' } });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith({ from: '2026-10-01', to: '', sort: '' });
    expect(screen.queryByText(/must be on or before/i)).not.toBeInTheDocument();

    // The other one-sided case (only `to`).
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-10-31' } });
    expect(onChange).toHaveBeenLastCalledWith({ from: '2026-10-01', to: '2026-10-31', sort: '' });
  });
});

describe('ListFilters — sort + reset', () => {
  it('forwards a chosen sort key', () => {
    const { onChange } = renderFilters();

    fireEvent.change(screen.getByLabelText('Sort'), { target: { value: 'created_at' } });

    expect(onChange).toHaveBeenLastCalledWith({ from: '', to: '', sort: 'created_at' });
  });

  it('resets through onReset', () => {
    const { onReset } = renderFilters({ from: '2026-10-01', sort: 'updated_at' });

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));

    expect(onReset).toHaveBeenCalledTimes(1);
  });
});
