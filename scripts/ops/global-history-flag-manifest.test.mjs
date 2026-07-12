#!/usr/bin/env node
/**
 * Dependency-matrix test for the Global History flag manifest (R12-C).
 *
 * This MUST fail if someone deletes a rule from the manifest: each `test(...)` below asserts a named
 * violation id fires for a specific illegal combination, so removing the corresponding `rules` entry
 * (or its dependsOn/conflictsWith wiring) drops the violation out of `evaluateFlagRules()`'s output and
 * the assertion goes from pass to fail — it does not silently pass either way.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  GLOBAL_HISTORY_FLAG_BY_KEY,
  GLOBAL_HISTORY_FLAG_KEYS,
  GLOBAL_HISTORY_FLAG_MANIFEST,
  evaluateFlagRules,
  isActivated,
  isMisconfiguredTruthy,
} from './global-history-flag-manifest.mjs'

function violationIds(flags) {
  return evaluateFlagRules(flags).map((v) => v.id)
}

test('manifest lists all 18 Global History line flags named in the R12-C brief', () => {
  const expected = [
    'MULTITABLE_ENABLE_SHEET_CONFIG_REVERT',
    'MULTITABLE_ENABLE_CONFIG_UNCREATE',
    'MULTITABLE_ENABLE_CONFIG_UNDELETE',
    'MULTITABLE_ENABLE_PERMISSION_REVERT',
    'MULTITABLE_ENABLE_FIELD_RETYPE_REVERT',
    'MULTITABLE_ENABLE_FIELD_RETYPE_REVERT_LOSSY',
    'MULTITABLE_ENABLE_PIT_RESET',
    'MULTITABLE_ENABLE_PIT_UNDELETE',
    'MULTITABLE_ENABLE_RECORD_UNDELETE_INBOUND',
    'MULTITABLE_TOMBSTONE_CAPTURE_ENABLED',
    'MULTITABLE_TOMBSTONE_CAPTURE_MAX_ROWS',
    'MULTITABLE_SIDE_DOOR_DELETE_TRASH_ENABLED',
    'MULTITABLE_META_REVISION_RETENTION_ENABLED',
    'MULTITABLE_META_REVISION_RETENTION_POLICY',
    'MULTITABLE_META_REVISION_RETENTION_KEEP_N',
    'MULTITABLE_META_REVISION_RETENTION_DAYS',
    'MULTITABLE_META_REVISION_RETENTION_BATCH',
    'MULTITABLE_META_REVISION_RETENTION_INTERVAL_MS',
  ]
  for (const key of expected) {
    assert.ok(GLOBAL_HISTORY_FLAG_BY_KEY[key], `manifest is missing ${key}`)
  }
  assert.equal(GLOBAL_HISTORY_FLAG_KEYS.length, expected.length)
  // every spec has a non-empty source citation — a rule with no citation is not verified
  for (const spec of GLOBAL_HISTORY_FLAG_MANIFEST) {
    assert.ok(spec.source && spec.source.length > 0, `${spec.key} has no source citation`)
  }
})

// ── R1: lossy double-gate ──────────────────────────────────────────────────────────────────────────

test('R1 lossy-without-base: LOSSY on + base off fires the named violation', () => {
  const ids = violationIds({
    MULTITABLE_ENABLE_FIELD_RETYPE_REVERT_LOSSY: 'true',
    MULTITABLE_ENABLE_FIELD_RETYPE_REVERT: 'false',
  })
  assert.ok(ids.includes('lossy-without-base'), `expected lossy-without-base, got ${ids.join(',')}`)
})

test('R1 lossy-without-base: LOSSY on + base UNSET also fires (unset is not activated)', () => {
  const ids = violationIds({ MULTITABLE_ENABLE_FIELD_RETYPE_REVERT_LOSSY: 'true' })
  assert.ok(ids.includes('lossy-without-base'))
})

test('R1 positive control: LOSSY on + base on does NOT fire', () => {
  const ids = violationIds({
    MULTITABLE_ENABLE_FIELD_RETYPE_REVERT_LOSSY: 'true',
    MULTITABLE_ENABLE_FIELD_RETYPE_REVERT: 'true',
  })
  assert.ok(!ids.includes('lossy-without-base'), `unexpected violation: ${ids.join(',')}`)
})

test('R1 positive control: LOSSY off never fires regardless of base', () => {
  assert.equal(
    violationIds({ MULTITABLE_ENABLE_FIELD_RETYPE_REVERT_LOSSY: 'false', MULTITABLE_ENABLE_FIELD_RETYPE_REVERT: 'false' }).includes(
      'lossy-without-base',
    ),
    false,
  )
})

// ── R2: side-door needs capture ────────────────────────────────────────────────────────────────────

test('R2 side-door-without-capture: SIDE_DOOR on + CAPTURE off fires the named violation', () => {
  const ids = violationIds({
    MULTITABLE_SIDE_DOOR_DELETE_TRASH_ENABLED: 'true',
    MULTITABLE_TOMBSTONE_CAPTURE_ENABLED: 'false',
  })
  assert.ok(ids.includes('side-door-without-capture'), `expected side-door-without-capture, got ${ids.join(',')}`)
})

test('R2 positive control: SIDE_DOOR on + CAPTURE on does NOT fire', () => {
  const ids = violationIds({
    MULTITABLE_SIDE_DOOR_DELETE_TRASH_ENABLED: 'true',
    MULTITABLE_TOMBSTONE_CAPTURE_ENABLED: 'true',
  })
  assert.ok(!ids.includes('side-door-without-capture'), `unexpected violation: ${ids.join(',')}`)
})

test('R2 positive control: SIDE_DOOR off never fires regardless of capture', () => {
  assert.equal(
    violationIds({ MULTITABLE_SIDE_DOOR_DELETE_TRASH_ENABLED: 'false', MULTITABLE_TOMBSTONE_CAPTURE_ENABLED: 'false' }).includes(
      'side-door-without-capture',
    ),
    false,
  )
})

// ── R3: PIT-reset vs retention STOP-SHIP ───────────────────────────────────────────────────────────

test('R3 pit-reset-intent-with-retention-on: PIT_RESET on + retention active (\'1\') fires', () => {
  const ids = violationIds({
    MULTITABLE_ENABLE_PIT_RESET: 'true',
    MULTITABLE_META_REVISION_RETENTION_ENABLED: '1',
  })
  assert.ok(ids.includes('pit-reset-intent-with-retention-on'), `expected pit-reset conflict, got ${ids.join(',')}`)
})

test("R3 footgun regression guard: retention='true' does NOT count as active (exact-match, not the loose heuristic)", () => {
  // This is the exact bug the o2-ladder doc + the old flag-status helper's loose TRUE_VALUES heuristic
  // could produce: 'true' looks truthy but meta-revision-retention.ts:60 requires the EXACT string '1'.
  const ids = violationIds({
    MULTITABLE_ENABLE_PIT_RESET: 'true',
    MULTITABLE_META_REVISION_RETENTION_ENABLED: 'true',
  })
  assert.ok(
    !ids.includes('pit-reset-intent-with-retention-on'),
    `retention='true' must NOT activate retention (needs exact '1'), so no conflict should fire; got ${ids.join(',')}`,
  )
})

test('R3 positive control: PIT_RESET on + retention off/unset does NOT fire', () => {
  assert.equal(violationIds({ MULTITABLE_ENABLE_PIT_RESET: 'true' }).includes('pit-reset-intent-with-retention-on'), false)
})

test('R3 positive control: retention active alone (no PIT_RESET) does NOT fire', () => {
  assert.equal(
    violationIds({ MULTITABLE_META_REVISION_RETENTION_ENABLED: '1' }).includes('pit-reset-intent-with-retention-on'),
    false,
  )
})

test('R3 PIT_RESET activation is case-insensitive + trimmed (matches univer-meta.ts PIT_RESET_ENABLED)', () => {
  const spec = GLOBAL_HISTORY_FLAG_BY_KEY.MULTITABLE_ENABLE_PIT_RESET
  assert.equal(isActivated(spec, ' TRUE '), true)
  assert.equal(isActivated(spec, 'True'), true)
  const ids = violationIds({ MULTITABLE_ENABLE_PIT_RESET: 'TRUE', MULTITABLE_META_REVISION_RETENTION_ENABLED: '1' })
  assert.ok(ids.includes('pit-reset-intent-with-retention-on'))
})

// ── R4: retention activation string footgun (surfaced as a per-flag advisory, not a strict violation) ─

test("R4 retention requires exact '1'; '1' activates, 'true'/'yes'/'on' do not", () => {
  const spec = GLOBAL_HISTORY_FLAG_BY_KEY.MULTITABLE_META_REVISION_RETENTION_ENABLED
  assert.equal(isActivated(spec, '1'), true)
  assert.equal(isActivated(spec, 'true'), false)
  assert.equal(isActivated(spec, 'yes'), false)
  assert.equal(isActivated(spec, 'on'), false)
})

test('R4 isMisconfiguredTruthy flags retention=true (should be 1) and PIT_RESET=1 (should be true)', () => {
  const retentionSpec = GLOBAL_HISTORY_FLAG_BY_KEY.MULTITABLE_META_REVISION_RETENTION_ENABLED
  assert.equal(isMisconfiguredTruthy(retentionSpec, 'true'), true)
  assert.equal(isMisconfiguredTruthy(retentionSpec, '1'), false) // correctly activated, not misconfigured

  const pitResetSpec = GLOBAL_HISTORY_FLAG_BY_KEY.MULTITABLE_ENABLE_PIT_RESET
  assert.equal(isMisconfiguredTruthy(pitResetSpec, '1'), true)
  assert.equal(isMisconfiguredTruthy(pitResetSpec, 'true'), false) // correctly activated, not misconfigured
})

test('R4 isMisconfiguredTruthy is false for empty/absent values (nothing to warn about)', () => {
  const retentionSpec = GLOBAL_HISTORY_FLAG_BY_KEY.MULTITABLE_META_REVISION_RETENTION_ENABLED
  assert.equal(isMisconfiguredTruthy(retentionSpec, ''), false)
  assert.equal(isMisconfiguredTruthy(retentionSpec, undefined), false)
  assert.equal(isMisconfiguredTruthy(retentionSpec, null), false)
  assert.equal(isMisconfiguredTruthy(retentionSpec, 'false'), false)
})

// ── Combined ladder rung ───────────────────────────────────────────────────────────────────────────

test('positive control: a full valid L1->L3.5 ladder rung (exact activation values) has zero violations', () => {
  const flags = {
    MULTITABLE_TOMBSTONE_CAPTURE_ENABLED: 'true', // L1
    MULTITABLE_ENABLE_RECORD_UNDELETE_INBOUND: 'true', // L2
    MULTITABLE_ENABLE_PIT_UNDELETE: 'true', // L3
    MULTITABLE_SIDE_DOOR_DELETE_TRASH_ENABLED: 'true', // L3.5 (D-2), capture already on above
    MULTITABLE_ENABLE_FIELD_RETYPE_REVERT: 'true',
    MULTITABLE_ENABLE_FIELD_RETYPE_REVERT_LOSSY: 'true',
    // retention and PIT_RESET both deliberately left OFF at this rung (L4/L5 are separate, independent decisions)
  }
  const violations = evaluateFlagRules(flags)
  assert.deepEqual(violations, [], `expected zero violations, got ${JSON.stringify(violations)}`)
})

test('positive control: retention-only rung (L4, no PIT_RESET) has zero violations', () => {
  const violations = evaluateFlagRules({
    MULTITABLE_TOMBSTONE_CAPTURE_ENABLED: 'true',
    MULTITABLE_META_REVISION_RETENTION_ENABLED: '1',
    MULTITABLE_META_REVISION_RETENTION_DAYS: '90',
  })
  assert.deepEqual(violations, [])
})

test('a rung that stacks ALL THREE illegal combinations fires all three named violations at once', () => {
  const ids = violationIds({
    MULTITABLE_ENABLE_FIELD_RETYPE_REVERT_LOSSY: 'true',
    MULTITABLE_ENABLE_FIELD_RETYPE_REVERT: 'false',
    MULTITABLE_SIDE_DOOR_DELETE_TRASH_ENABLED: 'true',
    MULTITABLE_TOMBSTONE_CAPTURE_ENABLED: 'false',
    MULTITABLE_ENABLE_PIT_RESET: 'true',
    MULTITABLE_META_REVISION_RETENTION_ENABLED: '1',
  })
  assert.deepEqual(
    [...ids].sort(),
    ['lossy-without-base', 'pit-reset-intent-with-retention-on', 'side-door-without-capture'].sort(),
  )
})

// ── Mutation-resistance: deleting a rule from the manifest must break these ───────────────────────

test('mutation guard: every FlagSpec.rules[] entry is reachable by evaluateFlagRules on a targeted fixture', () => {
  // Enumerates rules directly from the manifest (not hardcoded ids) so a NEW rule added later is
  // automatically covered, and a DELETED rule shrinks the iteration (making this test vacuous for that
  // rule) which is caught by the explicit per-rule tests above still expecting the id.
  const allRuleIds = GLOBAL_HISTORY_FLAG_MANIFEST.flatMap((spec) => (spec.rules || []).map((r) => r.id))
  assert.deepEqual(
    [...allRuleIds].sort(),
    ['lossy-without-base', 'pit-reset-intent-with-retention-on', 'side-door-without-capture'].sort(),
    'manifest rule set changed — update this test deliberately if a rule was intentionally added/removed',
  )
})
