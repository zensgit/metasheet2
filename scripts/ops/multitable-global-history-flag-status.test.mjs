#!/usr/bin/env node

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FLAG_KEYS,
  GLOBAL_HISTORY_FLAG_BY_KEY,
  buildAssessment,
  buildJsonPayload,
  collectFlagMapFromEnvText,
  countListEntries,
  flagEnabled,
  imageTag,
  isValueRedactedType,
  parseContainerInspect,
  renderFlagValueForOperator,
  renderText,
} from './multitable-global-history-flag-status.mjs'

test('collectFlagMapFromEnvText returns only Global History flags', () => {
  const flags = collectFlagMapFromEnvText([
    'MULTITABLE_ENABLE_PIT_RESET=true',
    'DATABASE_URL=postgres://secret',
    'TOKEN=secret',
    'MULTITABLE_ENABLE_PIT_UNDELETE=false',
    'MULTITABLE_META_REVISION_RETENTION_ENABLED=1',
  ].join('\n'))

  assert.equal(flags.MULTITABLE_ENABLE_PIT_RESET, 'true')
  assert.equal(flags.MULTITABLE_ENABLE_PIT_UNDELETE, 'false')
  assert.equal(flags.MULTITABLE_META_REVISION_RETENTION_ENABLED, '1')
  assert.equal(Object.hasOwn(flags, 'DATABASE_URL'), false)
  assert.equal(Object.hasOwn(flags, 'TOKEN'), false)
})

test('flagEnabled accepts common true values only', () => {
  assert.equal(flagEnabled({ A: 'true' }, 'A'), true)
  assert.equal(flagEnabled({ A: '1' }, 'A'), true)
  assert.equal(flagEnabled({ A: 'false' }, 'A'), false)
  assert.equal(flagEnabled({ A: null }, 'A'), false)
})

test('buildAssessment stops on PIT_RESET plus meta revision retention (retention activates on exact \'1\')', () => {
  const assessment = buildAssessment({
    backend: { image: 'ghcr.io/zensgit/metasheet2-backend:abc', status: 'running' },
    web: { image: 'ghcr.io/zensgit/metasheet2-web:abc', status: 'running' },
    flags: collectFlagMapFromEnvText([
      'MULTITABLE_ENABLE_PIT_RESET=true',
      'MULTITABLE_META_REVISION_RETENTION_ENABLED=1',
    ].join('\n')),
    health: { ok: true, status: 200, body: { status: 'ok' } },
  })

  assert.equal(assessment.ok, false)
  assert.match(assessment.stops.join('\n'), /pit-reset-intent-with-retention-on/)
})

test('buildAssessment stops on SHEET_REVERT plus meta revision retention (retention activates on exact \'1\')', () => {
  const assessment = buildAssessment({
    backend: { image: 'ghcr.io/zensgit/metasheet2-backend:abc', status: 'running' },
    web: { image: 'ghcr.io/zensgit/metasheet2-web:abc', status: 'running' },
    flags: collectFlagMapFromEnvText([
      'MULTITABLE_ENABLE_SHEET_REVERT=true',
      'MULTITABLE_META_REVISION_RETENTION_ENABLED=1',
    ].join('\n')),
    health: { ok: true, status: 200, body: { status: 'ok' } },
  })

  assert.equal(assessment.ok, false)
  assert.match(assessment.stops.join('\n'), /sheet-revert-intent-with-retention-on/)
})

// R12-C regression guard: retention's real activation string is the EXACT '1' (meta-revision-retention.ts:60),
// NOT 'true'. The pre-manifest helper used a loose TRUE_VALUES heuristic here and would have incorrectly
// stopped on retention='true' even though the real backend treats that as OFF (silent no-op). This proves the
// manifest-driven exact-match check no longer produces that false positive.
test('buildAssessment does NOT stop on PIT_RESET plus retention=\'true\' (retention requires exact \'1\', not \'true\')', () => {
  const assessment = buildAssessment({
    backend: { image: 'ghcr.io/zensgit/metasheet2-backend:abc', status: 'running' },
    web: { image: 'ghcr.io/zensgit/metasheet2-web:abc', status: 'running' },
    flags: collectFlagMapFromEnvText([
      'MULTITABLE_ENABLE_PIT_RESET=true',
      'MULTITABLE_META_REVISION_RETENTION_ENABLED=true',
    ].join('\n')),
    health: { ok: true, status: 200, body: { status: 'ok' } },
  })

  assert.equal(assessment.ok, true)
  assert.doesNotMatch(assessment.stops.join('\n'), /pit-reset-intent-with-retention-on/)
  // Still surfaced as an advisory WARN so an operator sees the footgun instead of silence.
  assert.match(assessment.warnings.join('\n'), /looks truthy but does NOT match its activation value/)
})

test('buildAssessment warns on image tag mismatch and strict turns it into a stop', () => {
  const snapshot = {
    backend: { image: 'ghcr.io/zensgit/metasheet2-backend:abc', status: 'running' },
    web: { image: 'ghcr.io/zensgit/metasheet2-web:def', status: 'running' },
    flags: collectFlagMapFromEnvText('MULTITABLE_ENABLE_PIT_RESET=false'),
    health: { ok: true, status: 200, body: { status: 'ok' } },
  }

  const loose = buildAssessment(snapshot)
  assert.equal(loose.ok, true)
  assert.equal(loose.warnings.length, 1)

  const strict = buildAssessment(snapshot, { strict: true })
  assert.equal(strict.ok, false)
  assert.match(strict.stops.join('\n'), /strict:/)
})

test('parseContainerInspect and imageTag parse docker inspect output', () => {
  const inspect = parseContainerInspect('ghcr.io/zensgit/metasheet2-backend:925932\t running')
  assert.equal(inspect.image, 'ghcr.io/zensgit/metasheet2-backend:925932')
  assert.equal(inspect.status, 'running')
  assert.equal(imageTag(inspect.image), '925932')
})

test('renderText does not print non-allowlisted env values', () => {
  const flags = collectFlagMapFromEnvText([
    'MULTITABLE_ENABLE_SHEET_CONFIG_REVERT=true',
    'SECRET_TOKEN=do-not-print',
  ].join('\n'))
  const snapshot = {
    backend: { image: 'backend:abc', status: 'running' },
    web: { image: 'web:abc', status: 'running' },
    flags,
    health: null,
  }
  const output = renderText(snapshot, buildAssessment(snapshot))
  assert.match(output, /MULTITABLE_ENABLE_SHEET_CONFIG_REVERT=true/)
  assert.doesNotMatch(output, /do-not-print/)
  assert.doesNotMatch(output, /SECRET_TOKEN/)
})

// ── R12-C: all Global History flags now shown, and illegal combinations always block ──────────────

test('FLAG_KEYS now covers every Global History flag, not just the original 5', () => {
  assert.ok(FLAG_KEYS.includes('MULTITABLE_ENABLE_FIELD_RETYPE_REVERT_LOSSY'))
  assert.ok(FLAG_KEYS.includes('MULTITABLE_SIDE_DOOR_DELETE_TRASH_ENABLED'))
  assert.ok(FLAG_KEYS.includes('MULTITABLE_TOMBSTONE_CAPTURE_ENABLED'))
  assert.ok(FLAG_KEYS.includes('MULTITABLE_TOMBSTONE_CAPTURE_MAX_ROWS'))
  assert.ok(FLAG_KEYS.includes('MULTITABLE_ENABLE_RECORD_UNDELETE_INBOUND'))
  assert.ok(FLAG_KEYS.includes('MULTITABLE_ENABLE_CONFIG_UNCREATE'))
  assert.ok(FLAG_KEYS.includes('MULTITABLE_ENABLE_CONFIG_UNDELETE'))
  assert.ok(FLAG_KEYS.includes('MULTITABLE_ENABLE_PERMISSION_REVERT'))
  assert.ok(FLAG_KEYS.length >= 18, `expected >=18 flags, got ${FLAG_KEYS.length}`)
})

test('buildAssessment stops (without --strict) on lossy-without-base', () => {
  const assessment = buildAssessment({
    backend: { image: 'backend:abc', status: 'running' },
    web: { image: 'web:abc', status: 'running' },
    flags: collectFlagMapFromEnvText([
      'MULTITABLE_ENABLE_FIELD_RETYPE_REVERT_LOSSY=true',
      'MULTITABLE_ENABLE_FIELD_RETYPE_REVERT=false',
    ].join('\n')),
    health: null,
  })
  assert.equal(assessment.ok, false)
  assert.match(assessment.stops.join('\n'), /lossy-without-base/)
})

test('buildAssessment stops (without --strict) on side-door-without-capture', () => {
  const assessment = buildAssessment({
    backend: { image: 'backend:abc', status: 'running' },
    web: { image: 'web:abc', status: 'running' },
    flags: collectFlagMapFromEnvText([
      'MULTITABLE_SIDE_DOOR_DELETE_TRASH_ENABLED=true',
      'MULTITABLE_TOMBSTONE_CAPTURE_ENABLED=false',
    ].join('\n')),
    health: null,
  })
  assert.equal(assessment.ok, false)
  assert.match(assessment.stops.join('\n'), /side-door-without-capture/)
})

test('buildAssessment stops (without --strict) on undelete-without-revert-gate (#4261 follow-up)', () => {
  const assessment = buildAssessment({
    backend: { image: 'backend:abc', status: 'running' },
    web: { image: 'web:abc', status: 'running' },
    flags: collectFlagMapFromEnvText([
      'MULTITABLE_ENABLE_PIT_UNDELETE=true',
      'MULTITABLE_ENABLE_SHEET_REVERT=false',
    ].join('\n')),
    health: null,
  })
  assert.equal(assessment.ok, false)
  assert.match(assessment.stops.join('\n'), /undelete-without-revert-gate/)
})

test('buildAssessment passes for a legal rung with the other four illegal-combo flag pairs satisfied', () => {
  const assessment = buildAssessment({
    backend: { image: 'ghcr.io/zensgit/metasheet2-backend:abc', status: 'running' },
    web: { image: 'ghcr.io/zensgit/metasheet2-web:abc', status: 'running' },
    flags: collectFlagMapFromEnvText([
      'MULTITABLE_ENABLE_FIELD_RETYPE_REVERT=true',
      'MULTITABLE_ENABLE_FIELD_RETYPE_REVERT_LOSSY=true',
      'MULTITABLE_TOMBSTONE_CAPTURE_ENABLED=true',
      'MULTITABLE_SIDE_DOOR_DELETE_TRASH_ENABLED=true',
      'MULTITABLE_ENABLE_PIT_RESET=false',
      'MULTITABLE_META_REVISION_RETENTION_ENABLED=0',
      'MULTITABLE_ENABLE_SHEET_REVERT=true', // #4261: undelete rides on the revert master gate — both on = legal
      'MULTITABLE_ENABLE_PIT_UNDELETE=true',
    ].join('\n')),
    health: { ok: true, status: 200, body: {} },
  })
  assert.equal(assessment.ok, true)
  assert.deepEqual(assessment.violations, [])
})

test('assessment.violations is present in the JSON-serializable shape (additive, does not remove existing fields)', () => {
  const snapshot = {
    backend: { image: 'backend:abc', status: 'running' },
    web: { image: 'web:abc', status: 'running' },
    flags: collectFlagMapFromEnvText('MULTITABLE_ENABLE_PIT_RESET=false'),
    health: null,
  }
  const assessment = buildAssessment(snapshot)
  const json = JSON.parse(JSON.stringify({ snapshot, assessment }))
  assert.ok(Array.isArray(json.assessment.violations))
  // pre-existing shape untouched
  assert.ok(Array.isArray(json.assessment.stops))
  assert.ok(Array.isArray(json.assessment.warnings))
  assert.equal(typeof json.assessment.ok, 'boolean')
  assert.equal(typeof json.assessment.backendTag, 'string')
  assert.equal(typeof json.assessment.webTag, 'string')
})

// ── P2 (2026-08-25): a `list`-typed flag's VALUE is never broadcast by the status tool ─────────────
//
// MULTITABLE_TRUST_CHECKPOINT_SHEET_ALLOWLIST is the manifest's first `list` spec. Its value is the
// set of sheet ids designated as trust-checkpoint canaries by the O-2 ladder's L2-C rung — identity
// the ladder deliberately keeps owner-held ("仅针对具名合成 sheet"). Before this fix the per-flag
// status line rendered `${key}=${rawValue}` and `--json` serialized `snapshot.flags` untouched, so
// both outputs printed the designated sheet ids verbatim.
//
// The redaction is keyed off `spec.type` (the manifest's own taxonomy), NEVER off the flag name —
// the #1882 failure class is "secret redaction that matches key names only". The tests below
// therefore drive the generic type predicate over the whole manifest as well as the concrete flag.

const SECRET_SHEET_IDS = [
  'shtCanaryZZZ-do-not-print-1',
  'shtCanaryZZZ-do-not-print-2',
]
const LIST_FLAG_KEY = 'MULTITABLE_TRUST_CHECKPOINT_SHEET_ALLOWLIST'

function snapshotWithAllowlist(rawValue) {
  const lines = ['MULTITABLE_ENABLE_TRUST_CHECKPOINT_ACTIVATION=true', 'MULTITABLE_ENABLE_WRITER_FENCE=true']
  if (rawValue !== undefined) lines.push(`${LIST_FLAG_KEY}=${rawValue}`)
  return {
    backend: { image: 'backend:abc', status: 'running' },
    web: { image: 'web:abc', status: 'running' },
    flags: collectFlagMapFromEnvText(lines.join('\n')),
    health: null,
  }
}

test('the manifest registers the allowlist as a value-redacted (list) type — the predicate this fix keys off', () => {
  const spec = GLOBAL_HISTORY_FLAG_BY_KEY[LIST_FLAG_KEY]
  assert.ok(spec, `${LIST_FLAG_KEY} must be registered in the manifest`)
  assert.equal(spec.type, 'list')
  assert.equal(isValueRedactedType(spec), true)
  // Keyed off the TYPE, not the name: a plain boolean spec is never redacted.
  assert.equal(isValueRedactedType(GLOBAL_HISTORY_FLAG_BY_KEY.MULTITABLE_ENABLE_PIT_RESET), false)
  assert.equal(isValueRedactedType(undefined), false)
})

test('list flag: designated sheet ids never appear verbatim in the TEXT output, and the count is right', () => {
  const snapshot = snapshotWithAllowlist(SECRET_SHEET_IDS.join(','))
  const output = renderText(snapshot, buildAssessment(snapshot))

  for (const id of SECRET_SHEET_IDS) {
    assert.doesNotMatch(output, new RegExp(id), `text output must never print the designated sheet id ${id}`)
  }
  assert.match(output, new RegExp(`${LIST_FLAG_KEY}=set\\(count=2\\)`))
  // Positive control for the assertion itself: the ids ARE in the snapshot being rendered, so a
  // doesNotMatch that passes on an empty/absent value would prove nothing.
  assert.equal(snapshot.flags[LIST_FLAG_KEY], SECRET_SHEET_IDS.join(','))
})

test('list flag: designated sheet ids never appear verbatim in the --json payload either', () => {
  const snapshot = snapshotWithAllowlist(SECRET_SHEET_IDS.join(','))
  const assessment = buildAssessment(snapshot)
  // Exactly what main() serializes under --json.
  const serialized = JSON.stringify(buildJsonPayload(snapshot, assessment), null, 2)

  for (const id of SECRET_SHEET_IDS) {
    assert.doesNotMatch(serialized, new RegExp(id), `--json must never print the designated sheet id ${id}`)
  }
  const payload = JSON.parse(serialized)
  assert.equal(payload.snapshot.flags[LIST_FLAG_KEY], 'set(count=2)')
  // The raw snapshot handed to buildAssessment is untouched — redaction happens at the
  // serialization boundary only, so the manifest's exact-activation rules still see real values.
  assert.equal(snapshot.flags[LIST_FLAG_KEY], SECRET_SHEET_IDS.join(','))
})

test('list flag: the count-only form still answers "designated or not" — 0 vs N, across every fail-closed spelling', () => {
  // These five spellings are the SAME table the in-process parser's unit suite pins
  // (resolveTrustCheckpointSheetAllowlist in
  // packages/core-backend/src/multitable/trust-checkpoint-activation-authz.ts: split ',', trim,
  // drop empties). If the operator's count stopped agreeing with them it would stop describing
  // what the route actually honours.
  assert.equal(countListEntries(undefined), 0) // unset
  assert.equal(countListEntries(''), 0) // empty
  assert.equal(countListEntries('   '), 0) // whitespace-only
  assert.equal(countListEntries(','), 0) // separator only
  assert.equal(countListEntries(' , , '), 0) // separators + whitespace
  assert.equal(countListEntries('shtA'), 1)
  assert.equal(countListEntries(' shtA , shtB '), 2)
  assert.equal(countListEntries('shtA,,shtB'), 2) // empty entry dropped, not counted

  // NOT-DESIGNATED renders identically for every fail-closed spelling — they are behaviourally
  // identical (each refuses activation for EVERY sheet), so the status line must not invite reading
  // "(absent)" as "the restriction is not in force".
  for (const raw of [undefined, '', '   ', ',', ' , , ']) {
    const snapshot = snapshotWithAllowlist(raw)
    const output = renderText(snapshot, buildAssessment(snapshot))
    assert.match(output, new RegExp(`${LIST_FLAG_KEY}=set\\(count=0\\)`), `raw=${JSON.stringify(raw)}`)
  }

  // DESIGNATED is visibly different — the operator can tell the two states apart from the count alone.
  const designated = snapshotWithAllowlist('shtCanaryOnly')
  assert.match(
    renderText(designated, buildAssessment(designated)),
    new RegExp(`${LIST_FLAG_KEY}=set\\(count=1\\)`),
  )
})

test('redaction is generic over the manifest: EVERY list spec is redacted, and non-list values stay verbatim', () => {
  const listSpecs = Object.values(GLOBAL_HISTORY_FLAG_BY_KEY).filter((spec) => spec.type === 'list')
  assert.ok(listSpecs.length >= 1, 'expected at least one list-typed spec to exercise the redaction')
  for (const spec of listSpecs) {
    assert.equal(renderFlagValueForOperator(spec, 'aaa,bbb'), 'set(count=2)')
    assert.equal(renderFlagValueForOperator(spec, undefined), 'set(count=0)')
  }
  // Boolean / numeric / enum values ARE the operator's signal and carry no identifiers — verbatim.
  assert.equal(renderFlagValueForOperator(GLOBAL_HISTORY_FLAG_BY_KEY.MULTITABLE_ENABLE_PIT_RESET, 'true'), 'true')
  assert.equal(
    renderFlagValueForOperator(GLOBAL_HISTORY_FLAG_BY_KEY.MULTITABLE_TOMBSTONE_CAPTURE_MAX_ROWS, '5000'),
    '5000',
  )
  assert.equal(renderFlagValueForOperator(GLOBAL_HISTORY_FLAG_BY_KEY.MULTITABLE_ENABLE_PIT_RESET, undefined), '(absent)')
})

test('buildJsonPayload leaves every non-list flag byte-identical, including the null of an unobserved flag', () => {
  const snapshot = snapshotWithAllowlist('shtCanaryOnly')
  const payload = buildJsonPayload(snapshot, buildAssessment(snapshot))
  assert.equal(payload.snapshot.flags.MULTITABLE_ENABLE_TRUST_CHECKPOINT_ACTIVATION, 'true')
  // Unobserved non-list flags keep the `null` machine consumers of this payload key off — the text
  // renderer's '(absent)' marker must not leak into the JSON contract.
  assert.equal(payload.snapshot.flags.MULTITABLE_ENABLE_PIT_RESET, null)
  // Everything outside `snapshot.flags` is passed through untouched.
  assert.equal(payload.snapshot.backend.image, 'backend:abc')
  assert.equal(payload.assessment.ok, true)
  assert.deepEqual(Object.keys(payload).sort(), ['assessment', 'snapshot'])
  assert.deepEqual(Object.keys(payload.snapshot.flags).sort(), [...FLAG_KEYS].sort())
})
