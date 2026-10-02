import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ExportPage } from '../admin/pages/Export';
import { exportDownloadUrl } from '../admin/lib/api';
import type { ExportEntity, ExportFormat } from '../admin/lib/types';

/**
 * The export screen (spec §78).
 *
 * The page only builds URLs and offers the browser's print dialog, so the test
 * checks exactly that: 8 entities × 2 formats, each link pointing at the URL
 * `exportDownloadUrl` produces, and the print button wired to `window.print`.
 */
vi.mock('../admin/lib/session', () => ({
  useAdminSession: () => ({ can: () => true }),
}));

const ENTITIES: ExportEntity[] = [
  'users',
  'channels',
  'campaigns',
  'transactions',
  'deposits',
  'withdrawals',
  'earnings',
  'revenue',
];

const FORMATS: ExportFormat[] = ['csv', 'xlsx'];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ExportPage', () => {
  it('renders 8 entities × 2 formats with the URLs exportDownloadUrl builds', () => {
    render(<ExportPage />);

    const hrefs = Array.from(document.querySelectorAll('a')).map((a) => a.getAttribute('href'));

    for (const entity of ENTITIES) {
      for (const format of FORMATS) {
        expect(hrefs).toContain(exportDownloadUrl(entity, format));
      }
    }

    // Exactly 16 download links — no extras, none missing.
    expect(hrefs).toHaveLength(ENTITIES.length * FORMATS.length);
  });

  it('wires the Print / Save as PDF action to window.print', () => {
    const printSpy = vi.spyOn(window, 'print').mockImplementation(() => undefined);

    render(<ExportPage />);
    const button = screen.getByRole('button', { name: /print \/ save as pdf/i });
    button.click();

    expect(printSpy).toHaveBeenCalledTimes(1);
  });

  it('states the row cap so an incomplete extract is not mistaken for a complete one', () => {
    render(<ExportPage />);
    expect(screen.getByText(/50,000/)).toBeInTheDocument();
    expect(screen.getByText(/incomplete extract/i)).toBeInTheDocument();
  });
});
