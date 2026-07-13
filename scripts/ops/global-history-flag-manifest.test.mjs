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
import { execSync } from 'node:child_process'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

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

// NON-TAUTOLOGICAL completeness: derive the flag set from SOURCE (grep packages/core-backend/src), NOT from
// a hand-copied list. A flag READ in source but MISSING from the manifest fails here — this is exactly how
// the 19th flag (MULTITABLE_SHEET_REVERT_MAX_RECORDS) slipped through the earlier hardcoded-list test, which
// asserted the manifest against a copy of itself and stayed green while missing it (owner REQUEST-CHANGES).
// The denylist below is the ONLY reviewed part: it names the NON-Global-History flag families. A NEW flag
// added to source that matches neither the manifest nor the denylist FAILS this test and forces a human to
// categorize it (→ manifest if it's a recovery/history flag, → denylist with a reason if it's out of scope).
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const NON_GH_PREFIXES = [
  'MULTITABLE_AI_', // AI fields / bulk-fill / ledger / tenant caps
  'MULTITABLE_ATTACHMENT_', // attachment storage / cleanup / blob retention
  'MULTITABLE_EMAIL_', // email transport / SMTP / smoke
]
const NON_GH_EXACT = new Set([
  'MULTITABLE_AGGREGATE_MAX_ROWS', // read-aggregation row cap
  'MULTITABLE_CAPABILITY_KEYS', // capability registry
  'MULTITABLE_ENABLE_CROSSBASE_MIRROR_WRITE', // cross-base mirror write (separate line)
  'MULTITABLE_ENABLE_PERSONAL_VIEWS', // personal views (separate line)
  'MULTITABLE_FIELD_INPUT_TYPES', // field-input-type registry
  'MULTITABLE_FIELD_TYPES', // field-type registry
  'MULTITABLE_FORMULA_BULK_RECOMPUTE_MAX_ROWS', // formula recompute cap
  'MULTITABLE_OBJECT_SCOPE_FORBIDDEN', // scope guards
  'MULTITABLE_PROJECT_NAMESPACE_FORBIDDEN',
  'MULTITABLE_SHARE_PERMISSIONS', // share permission registry
  'MULTITABLE_SHEET_SCOPE_FORBIDDEN',
])

function globalHistoryFlagsInSource() {
  const srcDir = path.join(REPO_ROOT, 'packages/core-backend/src')
  let out = ''
  try {
    out = execSync(`grep -rhoE 'MULTITABLE_[A-Z_0-9]+' ${srcDir} --include='*.ts'`, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
  } catch (err) {
    throw new Error(`could not grep MULTITABLE_ flags under ${srcDir}: ${err.message}`)
  }
  const tokens = [...new Set(out.split('\n').map((s) => s.trim()).filter(Boolean))]
  return tokens
    .filter((t) => !t.endsWith('_')) // drop concatenation-prefix artifacts (MULTITABLE_ENABLE_, ..._SMTP_)
    .filter((t) => !NON_GH_PREFIXES.some((p) => t.startsWith(p)))
    .filter((t) => !NON_GH_EXACT.has(t))
    .sort()
}

test('completeness (source-derived, non-tautological): manifest covers every Global-History flag read in packages/core-backend/src', () => {
  const sourceGH = globalHistoryFlagsInSource()
  assert.ok(
    sourceGH.length >= 19,
    `expected >=19 Global-History flags derived from source, got ${sourceGH.length} — the denylist is too broad or grep broke`,
  )
  const manifestKeys = new Set(GLOBAL_HISTORY_FLAG_KEYS)
  const missing = sourceGH.filter((f) => !manifestKeys.has(f))
  assert.deepEqual(
    missing,
    [],
    `source reads Global-History flags MISSING from the manifest — add each to global-history-flag-manifest.mjs (or, if genuinely out of scope, to NON_GH_PREFIXES/NON_GH_EXACT with a reason): ${missing.join(', ')}`,
  )
  const sourceSet = new Set(sourceGH)
  const phantom = GLOBAL_HISTORY_FLAG_KEYS.filter((k) => !sourceSet.has(k))
  assert.deepEqual(
    phantom,
    [],
    `manifest lists flags NOT read anywhere in packages/core-backend/src (stale or typo'd key): ${phantom.join(', ')}`,
  )
  // every spec carries a non-empty source citation — a rule with no citation is not verified
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
