#!/usr/bin/env node

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FLAG_KEYS,
  buildAssessment,
  collectFlagMapFromEnvText,
  flagEnabled,
  imageTag,
  parseContainerInspect,
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

test('buildAssessment passes for a legal rung with all three illegal-combo flag pairs satisfied', () => {
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
