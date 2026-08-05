'use strict'

// K3WriteDecision (owner, 20260805): REQUIRE_NAMED_PROFILE_MAX3_AND_CONTENT_BOUND_APPROVAL.
// This file pins the row-cap half: the customer profile freezes maxApplyRows=3, the adapter
// re-pins it after the operator-overlay merge, and an over-limit upsert is refused BEFORE
// login — zero network, so K3 never even sees a login attempt from a refused batch.
//
// Deliberately a separate file from k3-wise-adapters.test.cjs: that suite imports the
// sqlserver executor (workspace dep), this one needs only the webapi adapter, so the gate
// stays runnable in a bare checkout.

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  createK3WiseWebApiAdapter,
} = require('../lib/adapters/k3-wise-webapi-adapter.cjs')
const {
  K3_WISE_MATERIAL_PROFILES,
} = require('../lib/adapters/k3-wise-document-templates.cjs')

const PROFILE_ID = 'material-k3wise-customer-profile-v1'

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
    json: async () => body,
  }
}

// A fetch mock that COUNTS — the zero-call assertions below are the point of this file.
function countingFetch() {
  const calls = []
  const impl = async (url) => {
    const parsed = new URL(url)
    calls.push(parsed.pathname)
    if (parsed.pathname.endsWith('/Login')) {
      return jsonResponse(200, { success: true, sessionId: 'row-limit-session' })
    }
    if (parsed.pathname.endsWith('/Material/Save')) {
      return jsonResponse(200, {
        StatusCode: 200,
        Message: 'Successful',
        Data: [{ FStatus: true, FItemID: 1001 }],
      })
    }
    return jsonResponse(404, { success: false, message: 'not found' })
  }
  return { impl, calls }
}

function adapterWith(materialOverlay, fetchPair) {
  return createK3WiseWebApiAdapter({
    system: {
      id: 'row-limit-k3',
      name: 'Row limit K3',
      kind: 'erp:k3-wise-webapi',
      role: 'target',
      credentials: { username: 'u', password: 'p', acctId: 'AIS' },
      config: {
        baseUrl: 'https://k3.example.test',
        autoSubmit: false,
        autoAudit: false,
        objects: { material: materialOverlay },
      },
    },
    fetchImpl: fetchPair.impl,
  })
}

function records(n) {
  return Array.from({ length: n }, (_, i) => ({ FNumber: `MAT-CAP-${i + 1}`, FName: `Cap material ${i + 1}` }))
}

test('the customer profile literal freezes maxApplyRows at exactly 3', () => {
  const profile = K3_WISE_MATERIAL_PROFILES[PROFILE_ID]
  assert.ok(profile, 'the named customer profile must exist')
  assert.equal(profile.maxApplyRows, 3, 'K3WriteDecision fixes the first-version cap at 3')
  assert.equal(profile.lifecycle, 'save-only', 'the cap rides the save-only profile, not a loose config knob')
})

test('over-limit upsert is refused BEFORE login — zero network calls', async () => {
  const fetchPair = countingFetch()
  const adapter = adapterWith({ profile: PROFILE_ID }, fetchPair)

  await assert.rejects(
    adapter.upsert({ object: 'material', records: records(4), keyFields: ['FNumber'] }),
    (error) => {
      assert.equal(error.details && error.details.code, 'K3_WISE_APPLY_ROW_LIMIT_EXCEEDED')
      assert.equal(error.details.recordCount, 4)
      assert.equal(error.details.maxApplyRows, 3)
      return true
    },
  )
  // The load-bearing half: refusal happened before ANY network activity. Not "before Save" —
  // before login. K3 has no trace this call ever happened.
  assert.deepEqual(fetchPair.calls, [], 'a refused batch must produce zero HTTP calls, login included')
})

test('POSITIVE CONTROL: a 3-row batch under the same profile proceeds and writes', async () => {
  const fetchPair = countingFetch()
  const adapter = adapterWith({ profile: PROFILE_ID }, fetchPair)

  const result = await adapter.upsert({ object: 'material', records: records(3), keyFields: ['FNumber'] })
  assert.equal(result.written, 3, 'exactly the cap must still be allowed (limit is >, not >=)')
  assert.equal(result.failed, 0)
  assert.ok(fetchPair.calls.length > 0, 'the allowed batch DID reach the network — proves the refusal test refused for the right reason')
  assert.equal(fetchPair.calls.filter((p) => p.endsWith('/Login')).length, 1, 'one login for the batch')
  assert.equal(fetchPair.calls.filter((p) => p.endsWith('/Material/Save')).length, 3, 'one Save per record')
  assert.equal(fetchPair.calls.filter((p) => p.endsWith('/Submit') || p.endsWith('/Audit')).length, 0, 'save-only stays save-only')
})

test('an operator overlay can neither raise nor remove the pinned cap', async () => {
  // The overlay tries maxApplyRows: 100. The adapter re-pins from the profile literal AFTER
  // the merge (same shape as the save-only lifecycle lock), so 4 rows must still be refused.
  const fetchPair = countingFetch()
  const adapter = adapterWith({ profile: PROFILE_ID, maxApplyRows: 100 }, fetchPair)

  await assert.rejects(
    adapter.upsert({ object: 'material', records: records(4), keyFields: ['FNumber'] }),
    (error) => error.details && error.details.code === 'K3_WISE_APPLY_ROW_LIMIT_EXCEEDED',
  )
  assert.deepEqual(fetchPair.calls, [], 'overlay-raised cap must not open the network either')
})

test('RATIFIED FLIP: a profile-less material object cannot write AT ALL — zero network', async () => {
  // The previous version of this test DOCUMENTED the boundary it did not endorse: no
  // profile -> no cap, written=4. The owner ratified closing it (20260805): K3 material
  // upsert requires the named customer profile, one guard shutting every unarmed entry
  // (legacy stored configs, replay, future routes). Updated deliberately, not deleted.
  const fetchPair = countingFetch()
  const adapter = adapterWith(
    {
      savePath: '/K3API/Material/Save',
      keyField: 'FNumber',
      schema: [
        { name: 'FNumber', label: 'Code', type: 'string', required: true },
        { name: 'FName', label: 'Name', type: 'string', required: true },
      ],
    },
    fetchPair,
  )
  await assert.rejects(
    adapter.upsert({ object: 'material', records: records(1), keyFields: ['FNumber'] }),
    (error) => error.details && error.details.code === 'K3_WISE_MATERIAL_PROFILE_REQUIRED',
    'even a single-row write must be refused without the profile',
  )
  assert.deepEqual(fetchPair.calls, [], 'refusal precedes login — K3 never sees the attempt')
})
