/**
 * Pure unit lock for `isSupportedSheetConfigRevert` — the T9-W Tier 1 narrowing predicate that gates BOTH the route's
 * preview `opKind='safe'` override and the execute 422-skip. DB-free, so it runs in the default `test` job on every PR
 * (the real-DB wiring is golden (h) in tests/integration/multitable-sheet-config-revert-realdb.test.ts).
 *
 * Bar: ONLY an `update` to mapped read-rule columns is supported. create/delete (Tier 3 un-create, held by #3254) and
 * unknown/empty changed_keys stay unsupported, so they can never be surfaced as confirmable or executed as a revert.
 */
import { describe, expect, test } from 'vitest'

import { isSupportedSheetConfigRevert, SHEET_CONFIG_REVERT_KEYS } from '../src/multitable/config-restore'

const rev = (over: Partial<{ entity_type: string; action: string; changed_keys: unknown }>) => ({
  entity_type: 'sheet_config',
  action: 'update',
  changed_keys: ['conditionalReadRules'],
  ...over,
}) as Parameters<typeof isSupportedSheetConfigRevert>[0]

describe('isSupportedSheetConfigRevert — T9-W Tier 1 narrowing', () => {
  test('supported: update to mapped read-rule columns', () => {
    expect(isSupportedSheetConfigRevert(rev({ changed_keys: ['conditionalReadRules'] }))).toBe(true)
    expect(isSupportedSheetConfigRevert(rev({ changed_keys: ['rowLevelReadPermissionsEnabled'] }))).toBe(true)
    expect(isSupportedSheetConfigRevert(rev({ changed_keys: ['conditionalReadRules', 'rowLevelReadPermissionsEnabled'] }))).toBe(true)
  })

  test('unsupported action: create/delete (Tier 3 un-create, held)', () => {
    expect(isSupportedSheetConfigRevert(rev({ action: 'create' }))).toBe(false)
    expect(isSupportedSheetConfigRevert(rev({ action: 'delete' }))).toBe(false)
  })

  test('unsupported keys: unknown, mixed, or empty', () => {
    expect(isSupportedSheetConfigRevert(rev({ changed_keys: ['someUnknownKey'] }))).toBe(false)
    expect(isSupportedSheetConfigRevert(rev({ changed_keys: ['conditionalReadRules', 'someUnknownKey'] }))).toBe(false)
    expect(isSupportedSheetConfigRevert(rev({ changed_keys: [] }))).toBe(false)
  })

  test('forged prototype-chain keys do NOT match (Set membership, not `key in obj`)', () => {
    expect(isSupportedSheetConfigRevert(rev({ changed_keys: ['toString'] }))).toBe(false)
    expect(isSupportedSheetConfigRevert(rev({ changed_keys: ['constructor'] }))).toBe(false)
    expect(isSupportedSheetConfigRevert(rev({ changed_keys: ['hasOwnProperty'] }))).toBe(false)
  })

  test('wrong entity_type is never a supported sheet_config revert', () => {
    expect(isSupportedSheetConfigRevert(rev({ entity_type: 'field', changed_keys: ['name'] }))).toBe(false)
    expect(isSupportedSheetConfigRevert(rev({ entity_type: 'view', changed_keys: ['filterInfo'] }))).toBe(false)
    expect(isSupportedSheetConfigRevert(rev({ entity_type: 'permission' }))).toBe(false)
  })

  test('malformed changed_keys (non-array, forged row) is rejected, not thrown', () => {
    expect(isSupportedSheetConfigRevert(rev({ changed_keys: undefined }))).toBe(false)
    expect(isSupportedSheetConfigRevert(rev({ changed_keys: null }))).toBe(false)
    expect(isSupportedSheetConfigRevert(rev({ changed_keys: 'conditionalReadRules' }))).toBe(false)
  })

  // TRIPWIRE: the Tier-1 revert surface is design-locked to exactly these two read-rule keys, and is an EXPLICIT
  // literal (not derived from SHEET_CONFIG_COLUMN) so growing that map can't silently widen it. If you add a key to
  // SHEET_CONFIG_REVERT_KEYS this assertion fails ON PURPOSE — widening Tier 1 is a T9-W design-lock change that needs
  // its own goldens + sign-off (e.g. Tier 2 lossy retype is a SEPARATE slice), not a quiet edit. Update the lock first.
  test('TRIPWIRE: supported revert surface is exactly the design-locked read-rule keys', () => {
    expect([...SHEET_CONFIG_REVERT_KEYS].sort()).toEqual(['conditionalReadRules', 'rowLevelReadPermissionsEnabled'])
  })
})
