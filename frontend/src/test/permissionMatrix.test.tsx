import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ConfirmDialog } from '../admin/components/ConfirmDialog';
import { PERMISSION_GROUPS, UNWIRED_PERMISSIONS } from '../admin/lib/permissions';

afterEach(cleanup);

/**
 * The permission matrix.
 *
 * `PATCH /admin/admin-users/:id` has always accepted a `permissions` array, but the panel
 * only ever sent `role` and `isActive` — so every non-SUPER_ADMIN account was created with
 * an empty list, which `requirePermission` reads as "denied". The account could not open a
 * single screen and the only fix was a manual database write. The dialog now carries the
 * matrix; this is what makes the keys reachable from the UI at all.
 */
const total = PERMISSION_GROUPS.reduce((n, g) => n + g.keys.length, 0);
/** Every key, flattened — the first group can hold a single key. */
const ALL_KEYS = PERMISSION_GROUPS.flatMap((g) => g.keys) as string[];

function renderMatrix(initialValue = '') {
  const onConfirm = vi.fn();
  render(
    <ConfirmDialog
      open
      title="Change role"
      fields={[
        {
          name: 'permissions',
          label: 'Permissions',
          type: 'permissions',
          groups: PERMISSION_GROUPS,
          unwired: UNWIRED_PERMISSIONS,
          hint: 'Checked keys are granted.',
          initialValue,
        },
      ]}
      onCancel={() => undefined}
      onConfirm={onConfirm}
    />,
  );
  return { onConfirm };
}

describe('the matrix renders the real catalogue', () => {
  it('offers every key in the catalogue as a checkbox', () => {
    renderMatrix();

    const boxes = screen.getAllByRole('checkbox');
    expect(boxes).toHaveLength(total);
    expect(total).toBeGreaterThan(0);
  });

  it('renders the catalogue grouped, under its own labels', () => {
    renderMatrix();
    for (const group of PERMISSION_GROUPS) {
      expect(screen.getByText(group.label)).toBeTruthy();
    }
  });

  it('marks the keys that drive no screen, instead of hiding them', () => {
    // Hiding them would make the catalogue a lie: a key that grants nothing must be
    // visible as such, or an operator ticks it and wonders why nothing changed.
    renderMatrix();
    if (UNWIRED_PERMISSIONS.length > 0) {
      expect(screen.getAllByText(/no screen comes from this key/).length).toBeGreaterThan(0);
    }
  });
});

describe('what the dialog submits', () => {
  it('starts empty when there is nothing to prefill', () => {
    const { onConfirm } = renderMatrix();

    for (const box of screen.getAllByRole('checkbox')) {
      expect((box as HTMLInputElement).checked).toBe(false);
    }
    fireEvent.click(screen.getByText('Confirm'));
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ permissions: '' }));
  });

  it('prefills the keys the account already has', () => {
    const key = ALL_KEYS[0]!;
    const { onConfirm } = renderMatrix(key);

    const checked = screen
      .getAllByRole('checkbox')
      .filter((b) => (b as HTMLInputElement).checked);
    expect(checked).toHaveLength(1);

    fireEvent.click(screen.getByText('Confirm'));
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ permissions: key }));
  });

  it('submits the checked keys as a comma-separated list', () => {
    const [a, b] = ALL_KEYS;
    const { onConfirm } = renderMatrix();

    fireEvent.click(screen.getByText(a!));
    fireEvent.click(screen.getByText(b!));
    fireEvent.click(screen.getByText('Confirm'));

    const submitted = (onConfirm.mock.calls[0]![0] as { permissions: string }).permissions;
    expect(submitted.split(',').sort()).toEqual([a, b].sort());
  });

  it('removes a key when it is unticked again', () => {
    const key = ALL_KEYS[0]!;
    const { onConfirm } = renderMatrix(key);

    fireEvent.click(screen.getByText(key));
    fireEvent.click(screen.getByText('Confirm'));

    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ permissions: '' }));
  });

  it('can be cleared in one click', () => {
    const keys = ALL_KEYS.slice(0, 3);
    const { onConfirm } = renderMatrix(keys.join(','));

    fireEvent.click(screen.getByText('Clear all'));
    fireEvent.click(screen.getByText('Confirm'));

    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ permissions: '' }));
  });

  it('reports how many keys are selected', () => {
    const keys = ALL_KEYS.slice(0, 3);
    renderMatrix(keys.join(','));

    expect(screen.getByText(`${keys.length} of ${total} selected`)).toBeTruthy();
  });
});
