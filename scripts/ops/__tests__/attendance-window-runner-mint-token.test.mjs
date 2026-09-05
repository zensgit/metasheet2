#!/usr/bin/env node
// attendance-window-runner-mint-token.test.mjs
//
// Proof for the --tenant-id addition to ../attendance-window-runner-mint-token.mjs
// (W4 lead-in: a feature flag will make the tenant-scoped stock-prep/integration routes
// 403 tokens that carry no tenantId claim, so the ops mint helper must be able to embed
// one). Covers:
//   (a) --mint without --tenant-id: payload has no tenantId key (unchanged behavior).
//   (b) --mint --tenant-id <id>: payload.tenantId === <id> (trimmed).
//   (c) --tenant-id "   " (blank after trim): FAIL, exit 2, no token printed.
//   (d) --help: mentions --tenant-id and the 403/flag consequence, exits 0.
//
// Uses a test-only JWT_SECRET (never a real one) to sign, then decodes the base64url
// payload segment ourselves — no dependency on the backend's verifyToken().

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, '..', 'attendance-window-runner-mint-token.mjs')
const TEST_SECRET = 'test-only-secret-not-a-real-jwt-secret-0000'

function runMint(args, env = {}) {
  return spawnSync('node', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, JWT_SECRET: TEST_SECRET, ...env },
  })
}

function decodePayload(token) {
  const parts = token.trim().split('.')
  assert.equal(parts.length, 3, `expected a 3-part JWT, got: ${token}`)
  const json = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
  return JSON.parse(json)
}

test('--mint without --tenant-id: payload carries no tenantId key', () => {
  const result = runMint(['--mint', '--user-id', 'admin', '--roles', 'admin', '--expires-in', '3600'])
  assert.equal(result.status, 0, `expected exit 0, got ${result.status}; stderr: ${result.stderr}`)
  const payload = decodePayload(result.stdout)
  assert.equal('tenantId' in payload, false, 'payload must not contain a tenantId key when --tenant-id is omitted')
  assert.equal(payload.id, 'admin')
  assert.deepEqual(payload.roles, ['admin'])
})

test('--mint --tenant-id <id>: payload.tenantId is set to the trimmed value', () => {
  const result = runMint([
    '--mint',
    '--user-id',
    'admin',
    '--roles',
    'admin',
    '--expires-in',
    '3600',
    '--tenant-id',
    '  default  ',
  ])
  assert.equal(result.status, 0, `expected exit 0, got ${result.status}; stderr: ${result.stderr}`)
  const payload = decodePayload(result.stdout)
  assert.equal(payload.tenantId, 'default')
})

test('--mint --tenant-id "" (blank after trim): fails with exit 2 and prints no token', () => {
  const result = runMint(['--mint', '--user-id', 'admin', '--tenant-id', '   '])
  assert.equal(result.status, 2)
  assert.equal(result.stdout.trim(), '', 'no token should be printed on validation failure')
  assert.match(result.stderr, /--tenant-id.*must not be empty/)
})

test('omitting --tenant-id entirely leaves every other --mint output byte-identical', () => {
  const args = ['--mint', '--user-id', 'admin', '--roles', 'admin,ops', '--perms', 'a,b', '--expires-in', '120']
  const withoutFlagLogic = runMint(args)
  // Re-run with the same args (no --tenant-id) to confirm determinism of the non-tenant fields;
  // iat/exp are time-based so we compare header + roles/perms/id shape rather than raw bytes.
  const again = runMint(args)
  assert.equal(withoutFlagLogic.status, 0)
  assert.equal(again.status, 0)
  const p1 = decodePayload(withoutFlagLogic.stdout)
  const p2 = decodePayload(again.stdout)
  assert.equal('tenantId' in p1, false)
  assert.equal('tenantId' in p2, false)
  assert.deepEqual(Object.keys(p1), ['id', 'roles', 'perms', 'iat', 'exp'])
  assert.deepEqual(Object.keys(p2), ['id', 'roles', 'perms', 'iat', 'exp'])
})

test('--help documents --tenant-id and the tenant-claim-required 403 consequence, exits 0', () => {
  const result = runMint(['--help'])
  assert.equal(result.status, 0)
  assert.match(result.stdout, /--tenant-id/)
  assert.match(result.stdout, /MULTITABLE_STOCK_PREP_TENANT_CLAIM_REQUIRED/)
  assert.match(result.stdout, /403/)
})

test('--help does not print any payload value (only documents the flag) on stderr', () => {
  const result = runMint(['--help'])
  assert.equal(result.stderr.trim(), '', 'help must not write anything to stderr')
})
