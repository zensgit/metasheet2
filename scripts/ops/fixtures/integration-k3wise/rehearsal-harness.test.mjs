#!/usr/bin/env node
// Rehearsal-harness load-bearing test (owner review 2026-08-05, staging-window-rehearsal
// points E/F). Proves the two mock-server fixes the rehearsal workflow depends on actually work
// at runtime, rather than assuming them from reading the source:
//
//   F — requireSession:true rejects a call missing the session (every endpoint but Login), and
//       accepts the SAME session shape the real K3WiseWebApiAdapter carries after Login (either
//       the X-K3-Session header or the equivalent Cookie).
//
//   E — the runner's `K3CALL <METHOD> <pathname>` logger actually records calls. This is the
//       owner-observed bug this task traces back to: the staging-window-rehearsal workflow's
//       "Save-only invariant seen from the WIRE" step grep-asserts mock-k3.log has ZERO
//       Submit/Audit lines — but before this fix nothing was ever written to that stream, so the
//       absence check passed vacuously on an empty file regardless of what happened on the wire.
//       A positive control (log DOES show GetList/Save) only has teeth if the log is real.
//
// Node-native test runner, run directly — fixtures-side suite pattern (see the sibling
// mock-k3-webapi-server.test.mjs / fixture-contract.test.mjs / mock-sqlserver-executor.test.mjs).
// Deliberately NOT wired into package.json's verify:integration-k3wise:poc chain.
//
// Run: node scripts/ops/fixtures/integration-k3wise/rehearsal-harness.test.mjs

import assert from 'node:assert/strict'
import test from 'node:test'

import { createMockK3WebApiServer } from './mock-k3-webapi-server.mjs'

const SESSION_HEADER = 'X-K3-Session'
const SESSION_ID = 'mock-session-1'

const SEED_LIST_ROWS = [
  { FItemID: 61001, FNumber: 'MAT-RH-001', FName: 'Rehearsal material A', FModel: 'SPEC-RH-A', FUnitID: 'PCS' },
  { FItemID: 61002, FNumber: 'MAT-RH-002', FName: 'Rehearsal material B', FModel: 'SPEC-RH-B', FUnitID: 'PCS' },
]

async function postJson(baseUrl, pathname, payload, headers = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  })
  let body = null
  try { body = await response.json() } catch { /* not every response is JSON */ }
  return { status: response.status, body }
}

test('rehearsal harness: unauthenticated GetList is refused (F, negative half)', async () => {
  const mock = createMockK3WebApiServer({ requireSession: true, seedListRows: SEED_LIST_ROWS })
  const baseUrl = await mock.start()
  try {
    const unauth = await postJson(baseUrl, '/K3API/Material/GetList', { Data: { Top: 10, PageIndex: 1 } })
    assert.equal(unauth.status, 401, 'an unauthenticated read must be refused (401)')
    assert.equal(unauth.body?.success, false)
  } finally {
    await mock.stop()
  }
})

test('rehearsal harness: authenticated GetList succeeds with the seeded 2 rows (F, positive half)', async () => {
  const logLines = []
  const mock = createMockK3WebApiServer({
    requireSession: true,
    seedListRows: SEED_LIST_ROWS,
    logger: (call) => { logLines.push(`K3CALL ${call.method} ${call.pathname}`) },
  })
  const baseUrl = await mock.start()
  try {
    const login = await postJson(baseUrl, '/K3API/Login', { username: 'demo', password: 'demo', acctId: 'RH' })
    assert.equal(login.status, 200)
    assert.equal(login.body?.sessionId, SESSION_ID)

    const list = await postJson(baseUrl, '/K3API/Material/GetList', { Data: { Top: 10, PageIndex: 1 } }, {
      [SESSION_HEADER]: SESSION_ID,
    })
    assert.equal(list.status, 200)
    assert.equal(list.body?.Data?.DATA?.length, 2, 'authenticated GetList must return the 2 seeded rows')

    // E, part 1 — the load-bearing proof the owner's review demanded: the logger DID record the
    // GetList call in the EXACT `K3CALL POST /K3API/Material/GetList` shape the workflow's
    // positive control greps for.
    assert.ok(
      logLines.includes('K3CALL POST /K3API/Material/GetList'),
      `logger must record the GetList call; got: ${JSON.stringify(logLines)}`,
    )
  } finally {
    await mock.stop()
  }
})

test('rehearsal harness: requireSession accepts an equivalent session cookie, not only the header', async () => {
  const mock = createMockK3WebApiServer({ requireSession: true })
  const baseUrl = await mock.start()
  try {
    const login = await fetch(`${baseUrl}/K3API/Login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'demo', password: 'demo', acctId: 'RH' }),
    })
    const setCookie = login.headers.get('set-cookie')
    assert.ok(setCookie, 'login must set a session cookie')

    // The real adapter forwards the ENTIRE raw Set-Cookie value back as its request Cookie
    // header (k3-wise-webapi-adapter.cjs:1605-1606) — not a re-parsed name=value pair. Reproduce
    // that exact shape here rather than a cleaner hand-built cookie.
    const health = await fetch(`${baseUrl}/K3API/Health`, {
      method: 'GET',
      headers: { Cookie: setCookie },
    })
    assert.equal(health.status, 200, 'a request carrying the equivalent session cookie must be accepted')
  } finally {
    await mock.stop()
  }
})

test('rehearsal harness: requireSession defaults to false (existing suites unaffected)', async () => {
  const mock = createMockK3WebApiServer({ seedListRows: SEED_LIST_ROWS })
  const baseUrl = await mock.start()
  try {
    const list = await postJson(baseUrl, '/K3API/Material/GetList', { Data: { Top: 10, PageIndex: 1 } })
    assert.equal(list.status, 200, 'default requireSession:false must not gate unauthenticated calls')
  } finally {
    await mock.stop()
  }
})

test('rehearsal harness: logger sees Save AND Submit — the visibility the workflow\'s absence-check depends on (E, part 2)', async () => {
  const logLines = []
  const mock = createMockK3WebApiServer({
    requireSession: true,
    seedListRows: SEED_LIST_ROWS,
    logger: (call) => { logLines.push(`K3CALL ${call.method} ${call.pathname}`) },
  })
  const baseUrl = await mock.start()
  try {
    await postJson(baseUrl, '/K3API/Login', { username: 'demo', password: 'demo', acctId: 'RH' })

    const save = await postJson(baseUrl, '/K3API/Material/Save', { Data: { FNumber: 'MAT-RH-001', FName: 'x' } }, {
      [SESSION_HEADER]: SESSION_ID,
    })
    assert.equal(save.status, 200)
    assert.equal(save.body?.success, true)
    assert.ok(
      logLines.includes('K3CALL POST /K3API/Material/Save'),
      `logger must record the Save call; got: ${JSON.stringify(logLines)}`,
    )

    // The workflow's actual assertion is an ABSENCE check on Submit/Audit. That check only has
    // teeth if a Submit call, had one happened, would actually show up in the log. Prove it does.
    const submit = await postJson(baseUrl, '/K3API/Material/Submit', { Number: 'MAT-RH-001' }, {
      [SESSION_HEADER]: SESSION_ID,
    })
    assert.equal(submit.status, 200)
    assert.ok(
      logLines.includes('K3CALL POST /K3API/Material/Submit'),
      `logger must record the Submit call (the workflow's absence-check depends on this being visible); got: ${JSON.stringify(logLines)}`,
    )
  } finally {
    await mock.stop()
  }
})
