/**
 * Pure unit lock for `isSupportedSheetConfigRevert` — the T9-W Tier 1 narrowing predicate (#3291) that gates BOTH the
 * route's preview `opKind='safe'` override and the execute 422-skip. DB-free, so it runs in the default `test` job on
 * every PR (the real-DB wiring is the create/delete/unknown-key golden in
 * tests/integration/multitable-sheet-config-revert-realdb.test.ts).
 *
 * Salvaged from the superseded #3295 (whose runtime fix #3291 already shipped): this adds the DB-free predicate
 * coverage (incl. the prototype-chain footgun + malformed non-array changed_keys) and an exact-set TRIPWIRE that #3291
 * left out — main has `SUPPORTED_SHEET_CONFIG_REVERT_KEYS` as an explicit literal but nothing pins it, so a future
 * widening would pass CI silently. Tests only: no runtime / real-DB-golden change.
 */
import { describe, expect, test } from 'vitest'

import { isSupportedSheetConfigRevert, SUPPORTED_SHEET_CONFIG_REVERT_KEYS } from '../src/multitable/config-restore'

const rev = (over: Partial<{ entity_type: string; action: string; changed_keys: unknown }>) => ({
  entity_type: 'sheet_config',
  action: 'update',
  changed_keys: ['conditionalReadRules'],
  ...over,
}) as Parameters<typeof isSupportedSheetConfigRevert>[0]

describe('isSupportedSheetConfigRevert — T9-W Tier 1 narrowing (#3291)', () => {
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

  // TRIPWIRE: the Tier-1 revert surface is design-locked to exactly these two read-rule keys. #3291 made
  // SUPPORTED_SHEET_CONFIG_REVERT_KEYS an explicit literal (good) but pinned it with no test — so widening it would
  // pass CI silently. This assertion fails ON PURPOSE if the set changes: widening Tier 1 is a T9-W design-lock change
  // needing its own goldens + sign-off (Tier 2 lossy retype is a SEPARATE slice), not a quiet edit. Update the lock first.
  test('TRIPWIRE: supported revert surface is exactly the design-locked read-rule keys', () => {
    expect([...SUPPORTED_SHEET_CONFIG_REVERT_KEYS].sort()).toEqual(['conditionalReadRules', 'rowLevelReadPermissionsEnabled'])
  })
})
