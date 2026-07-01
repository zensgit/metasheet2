#!/usr/bin/env node

import assert from 'node:assert/strict'
import test from 'node:test'

import {
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

test('buildAssessment stops on PIT_RESET plus meta revision retention', () => {
  const assessment = buildAssessment({
    backend: { image: 'ghcr.io/zensgit/metasheet2-backend:abc', status: 'running' },
    web: { image: 'ghcr.io/zensgit/metasheet2-web:abc', status: 'running' },
    flags: collectFlagMapFromEnvText([
      'MULTITABLE_ENABLE_PIT_RESET=true',
      'MULTITABLE_META_REVISION_RETENTION_ENABLED=true',
    ].join('\n')),
    health: { ok: true, status: 200, body: { status: 'ok' } },
  })

  assert.equal(assessment.ok, false)
  assert.match(assessment.stops.join('\n'), /PIT_RESET/)
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
