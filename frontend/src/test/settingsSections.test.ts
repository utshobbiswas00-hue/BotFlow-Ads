import { describe, expect, it } from 'vitest';
import {
  findSettingsSection,
  knownSettingKeys,
  SETTINGS_SECTIONS,
} from '../admin/pages/settings/sections';
import { SETTING_DEFAULTS } from '../../../backend/src/config/constants';

// Computed once here rather than exported as a module-level constant from
// sections.ts: the union must not be evaluated before the section list exists.
const SETTING_KEY_LIST = knownSettingKeys();

/**
 * The settings sub-page module's main safety net.
 *
 * `GET /api/admin/settings` returns `SETTING_DEFAULTS` merged with the DB rows,
 * so the keys of `SETTING_DEFAULTS` are the exact universe the panel renders.
 * The sections must be a DISJOINT PARTITION of that universe with first-match
 * wins — otherwise a key would either be unreachable (no section) or rendered
 * twice (two sections), and an operator would be editing a setting they cannot
 * see or see two editors for one key.
 *
 * The key list is read from the same source the panel uses (sections.ts, which
 * imports the backend constants) rather than a second hand-copied list, so this
 * test fails if the panel's section map and the backend catalogue drift apart.
 */

const EXPECTED_SLUGS_IN_ORDER = [
  'general',
  'advertising',
  'publisher',
  'advertiser',
  'payments',
  'withdrawals',
  'referrals',
  'notifications',
  'telegram',
  'maintenance',
  'other',
];

describe('settings sections', () => {
  it('reads the same real key list the panel uses, straight from the backend defaults', () => {
    expect([...SETTING_KEY_LIST]).toEqual(Object.keys(SETTING_DEFAULTS).sort());
    // Guard against the catalogue silently emptying out.
    expect(SETTING_KEY_LIST.length).toBeGreaterThan(50);
  });

  it('defines the ten named sections plus a trailing Other, in order', () => {
    expect(SETTINGS_SECTIONS.map((s) => s.slug)).toEqual(EXPECTED_SLUGS_IN_ORDER);
    expect(new Set(SETTINGS_SECTIONS.map((s) => s.slug)).size).toBe(SETTINGS_SECTIONS.length);
    expect(SETTINGS_SECTIONS[SETTINGS_SECTIONS.length - 1]?.slug).toBe('other');
  });

  it('partitions the real key set: every key matches exactly one section', () => {
    const unmatched: string[] = [];
    const multiplyMatched: string[] = [];

    for (const key of SETTING_KEY_LIST) {
      const matches = SETTINGS_SECTIONS.filter((s) => s.match(key));
      if (matches.length === 0) unmatched.push(key);
      if (matches.length > 1) multiplyMatched.push(`${key} (${matches.map((m) => m.slug).join(', ')})`);
    }

    expect(unmatched).toEqual([]);
    expect(multiplyMatched).toEqual([]);
  });

  it('resolves every key through first-match-wins to that same single section', () => {
    for (const key of SETTING_KEY_LIST) {
      const resolved = findSettingsSection(SETTINGS_SECTIONS.find((s) => s.match(key))?.slug);
      expect(resolved, key).toBeDefined();
      expect(resolved!.match(key), key).toBe(true);
    }
  });

  it("has no key left out and no section owning a key outside the real set", () => {
    const real = new Set(SETTING_KEY_LIST);
    const owned: string[] = [];
    for (const section of SETTINGS_SECTIONS) {
      for (const key of section.keys) owned.push(key);
    }

    // Every declared key is real (catches typos and invented keys)...
    const invented = owned.filter((k) => !real.has(k));
    expect(invented).toEqual([]);

    // ...and every real key is declared by exactly one section (no blind spot).
    const declared = new Set(owned);
    expect(declared.size).toBe(owned.length);
    expect([...declared].sort()).toEqual([...SETTING_KEY_LIST]);
  });

  it('leaves Other empty for the current catalogue (a true catch-all)', () => {
    const other = SETTINGS_SECTIONS.find((s) => s.slug === 'other')!;
    expect(other.keys).toEqual([]);
    // Other still matches nothing today because every key is claimed earlier.
    expect(SETTING_KEY_LIST.filter((k) => other.match(k))).toEqual([]);
  });

  it('treats an unknown slug as missing rather than throwing', () => {
    expect(findSettingsSection('nope')).toBeUndefined();
    expect(findSettingsSection(undefined)).toBeUndefined();
    expect(findSettingsSection('withdrawals')?.slug).toBe('withdrawals');
  });
});
