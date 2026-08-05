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


test('OWNER REVIEW P1: an overlay cannot re-point savePath at the Submit endpoint', async () => {
  // Before the pin, config {profile, savePath: '/K3API/Material/Submit'} produced an
  // effective object whose "Save" call POSTed to Submit while lifecycle still said
  // save-only — save-only subverted by endpoint substitution. The Save ENDPOINT is now
  // pinned from the profile literal post-merge, like the lifecycle marker.
  const fetchPair = countingFetch()
  const adapter = adapterWith({ profile: PROFILE_ID, savePath: '/K3API/Material/Submit' }, fetchPair)
  const result = await adapter.upsert({ object: 'material', records: records(1), keyFields: ['FNumber'] })
  assert.equal(result.written, 1)
  assert.equal(fetchPair.calls.filter((p) => p.endsWith('/Material/Save')).length, 1,
    'the write must land on the PROFILE\'S Save endpoint')
  assert.equal(fetchPair.calls.filter((p) => p.endsWith('/Submit')).length, 0,
    'the overlay-substituted endpoint must never be reached')
})

test('ADVERSARIAL P1-1: an overlay cannot author the READ request either (the wider channel)', async () => {
  // The reviewer's exploit, verbatim as a regression: overlay readPath at the Submit endpoint
  // plus a Submit-shaped readBodyTemplate, then read. Before the class-wide pin this POSTed to
  // /K3API/Material/Submit during a DRY-RUN — before any approval token existed.
  const fetchPair = countingFetch()
  const adapter = adapterWith({
    profile: PROFILE_ID,
    readPath: '/K3API/Material/Submit',
    readMethod: 'POST',
    readBodyTemplate: { Numbers: ['M-1'] },
  }, fetchPair)

  await adapter.read({ object: 'material', filters: { FNumber: 'MAT-CAP-1' } }).catch(() => {})
  assert.equal(fetchPair.calls.filter((p) => p.endsWith('/Submit')).length, 0,
    'the overlay-authored read endpoint must never be reached')
  assert.equal(fetchPair.calls.filter((p) => p.endsWith('/Material/GetDetail')).length, 1,
    'the read must land on the PROFILE\'S own readPath')
})

test('ADVERSARIAL P2-4: the Save body is exactly the projection — no smuggled field survives', async () => {
  // Coverage regression the reviewer caught: the byte-exact Save-body deepEqual was dropped in
  // a flip, so an extra field smuggled into every Save body passed chain-wide. Restored here
  // against the real adapter, at the layer that actually composes the body.
  const fetchPair = countingFetch()
  const adapter = adapterWith({ profile: PROFILE_ID }, fetchPair)
  const captured = []
  const wrapped = {
    impl: async (url, init) => {
      const parsed = new URL(url)
      if (parsed.pathname.endsWith('/Material/Save')) {
        captured.push(init && init.body ? JSON.parse(init.body) : null)
      }
      return fetchPair.impl(url, init)
    },
    calls: fetchPair.calls,
  }
  const adapter2 = adapterWith({ profile: PROFILE_ID }, wrapped)
  await adapter2.upsert({
    object: 'material',
    records: [{ FNumber: 'MAT-EXACT-1', FName: 'Exact body', FSmuggled: 'must-not-appear' }],
    keyFields: ['FNumber'],
  })
  assert.equal(captured.length, 1, 'exactly one Save body captured')
  assert.deepEqual(captured[0], { Data: { FNumber: 'MAT-EXACT-1', FName: 'Exact body' } },
    'the body must be BYTE-EXACT the schema projection — a smuggled field is a failure')
  void adapter
})

test('ADVERSARIAL P1-1b: an overlay cannot author the read BODY either (endpoint pin alone is not enough)', async () => {
  // Discriminating control for the forbidden-overlay-key deletion: even with readPath pinned
  // back to GetDetail, a surviving overlay readBodyTemplate would still let the operator author
  // the body sent to it. The profile's own body shape must be what goes on the wire.
  const bodies = []
  const base = countingFetch()
  const probe = {
    impl: async (url, init) => {
      const parsed = new URL(url)
      if (parsed.pathname.endsWith('/Material/GetDetail')) {
        bodies.push(init && init.body ? JSON.parse(init.body) : null)
        return {
          ok: true, status: 200, headers: { get: () => null },
          text: async () => JSON.stringify({ StatusCode: 200, Message: 'Successful', Data: [{ FStatus: true, FItemID: 7, Data: { FNumber: 'MAT-CAP-1' } }] }),
          json: async () => ({ StatusCode: 200, Message: 'Successful', Data: [{ FStatus: true, FItemID: 7, Data: { FNumber: 'MAT-CAP-1' } }] }),
        }
      }
      return base.impl(url, init)
    },
    calls: base.calls,
  }
  const adapter = adapterWith({
    profile: PROFILE_ID,
    readBodyTemplate: { SmuggledEnvelope: { Numbers: ['M-1'] } },
  }, probe)

  await adapter.read({ object: 'material', filters: { FNumber: 'MAT-CAP-1' } }).catch(() => {})
  assert.equal(bodies.length, 1, 'the read must reach GetDetail exactly once')
  assert.equal(JSON.stringify(bodies[0]).includes('SmuggledEnvelope'), false,
    'an overlay-authored body template must never reach the wire')
})

test('SWEEP CONTRACT: every objectConfig field, across EVERY consumer file, is TRIAGED', () => {
  // Round 2 claimed the request-shape hole was closed "class-wide" and backed it with a sweep
  // of ONE file. A reviewer found the class still open: k3-save-body-composer.cjs reads
  // passThroughBody and bodyTemplate from the same merged config, and both reached the live
  // Save body. So the sweep now scans EVERY consumer, and the consumer list itself is checked
  // against a repo-wide grep — forgetting to add a new module is a RED, not a silent hole.
  const fs = require('node:fs')
  const path = require('node:path')
  const libRoot = path.join(__dirname, '..', 'lib')
  const {
    K3_PROFILE_PINNED_REQUEST_KEYS,
    K3_PROFILE_FORBIDDEN_OVERLAY_KEYS,
    K3_PROFILE_TRIAGED_SAFE_KEYS,
    K3_PROFILE_OBJECT_CONFIG_CONSUMERS,
  } = require('../lib/adapters/k3-wise-webapi-adapter.cjs')

  function walk(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) return walk(full)
      return entry.isFile() && full.endsWith('.cjs') ? [full] : []
    })
  }
  // K3-specific consumers only: other adapters have their own objectConfig vocabularies and
  // their own targets. The filter is by K3 module identity, not by whether the file is
  // convenient to include.
  const discovered = walk(libRoot)
    .filter((f) => /objectConfig\./.test(fs.readFileSync(f, 'utf8')))
    .map((f) => path.relative(path.join(__dirname, '..'), f))
    .filter((rel) => /k3-(wise-webapi-adapter|save-body-composer)\.cjs$/.test(rel))
    .sort()
  assert.deepEqual(discovered, [...K3_PROFILE_OBJECT_CONFIG_CONSUMERS].sort(),
    'a K3 module reading objectConfig is missing from K3_PROFILE_OBJECT_CONFIG_CONSUMERS')

  const reads = new Set()
  for (const rel of K3_PROFILE_OBJECT_CONFIG_CONSUMERS) {
    const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8')
    for (const m of src.matchAll(/objectConfig\.([A-Za-z_][A-Za-z0-9_]*)/g)) reads.add(m[1])
  }
  assert.ok(reads.size >= 30, `the sweep must actually find reads (found ${reads.size}) — a regex matching nothing would pass vacuously`)

  const triaged = new Set([
    ...K3_PROFILE_PINNED_REQUEST_KEYS,
    ...K3_PROFILE_FORBIDDEN_OVERLAY_KEYS,
    ...K3_PROFILE_TRIAGED_SAFE_KEYS,
  ])
  assert.deepEqual([...reads].filter((k) => !triaged.has(k)).sort(), [],
    'untriaged objectConfig field(s) — decide: profile-pinned, forbidden-overlay, or documented-safe')
})

test('SET MEMBERSHIP IS PINNED BY NAME (a loop over the mutated array cannot catch its own move)', () => {
  // The disposition test below iterates the sets themselves — so moving a key OUT of PINNED
  // into TRIAGED_SAFE simply stops it being iterated and everything stays green (a reviewer
  // proved exactly that). Same shape as a count guard fooled by its own source. The security-
  // relevant keys are therefore anchored BY NAME here; TRIAGED_SAFE is pinned exactly, so a
  // key can only land there by editing this list deliberately.
  const {
    K3_PROFILE_PINNED_REQUEST_KEYS,
    K3_PROFILE_FORBIDDEN_OVERLAY_KEYS,
    K3_PROFILE_TRIAGED_SAFE_KEYS,
  } = require('../lib/adapters/k3-wise-webapi-adapter.cjs')

  for (const key of ['savePath', 'saveMethod', 'readPath', 'readMethod', 'bodyKey', 'keyParam', 'keyField', 'path', 'endpointPath']) {
    assert.ok(K3_PROFILE_PINNED_REQUEST_KEYS.includes(key), `${key} must stay PINNED — it chooses an endpoint, a verb or the key`)
  }
  for (const key of [
    'submitPath', 'auditPath', 'deletePath', 'writePath',
    'readBodyTemplate', 'bodyTemplate', 'passThroughBody',
    'readBomBodyTemplate', 'readBomBodyKey', 'readBomParentKeyField',
    'buildBody', 'buildLifecycleBody', 'k3Template',
    'submitMethod', 'auditMethod',
  ]) {
    assert.ok(K3_PROFILE_FORBIDDEN_OVERLAY_KEYS.includes(key), `${key} must stay FORBIDDEN — it authors a body or an unsanctioned endpoint`)
  }
  assert.deepEqual([...K3_PROFILE_TRIAGED_SAFE_KEYS].sort(),
    ['label', 'lifecycle', 'maxApplyRows', 'operations', 'schema'],
    'TRIAGED_SAFE is pinned exactly — a key may only arrive here by a deliberate edit here')
})

test('DISPOSITION CONTRACT: each key is BEHAVIOURALLY what its set says (membership is not enough)', () => {
  // A reviewer showed the sweep only asserted MEMBERSHIP: moving saveMethod/keyField from
  // PINNED to TRIAGED_SAFE, or the readBom* keys from FORBIDDEN to SAFE, left the whole chain
  // green. Membership is a label; this asserts the BEHAVIOUR each label promises, per key.
  const { __internals } = require('../lib/adapters/k3-wise-webapi-adapter.cjs')
  const {
    K3_PROFILE_PINNED_REQUEST_KEYS,
    K3_PROFILE_FORBIDDEN_OVERLAY_KEYS,
  } = require('../lib/adapters/k3-wise-webapi-adapter.cjs')
  const { K3_WISE_MATERIAL_PROFILES } = require('../lib/adapters/k3-wise-document-templates.cjs')
  const profile = K3_WISE_MATERIAL_PROFILES[PROFILE_ID]
  const SENTINEL = '__OPERATOR_SENTINEL__'

  for (const key of K3_PROFILE_PINNED_REQUEST_KEYS) {
    const effective = __internals.normalizeObjects({
      objects: { material: { profile: PROFILE_ID, [key]: SENTINEL } },
    }).material
    if (profile[key] === undefined) {
      assert.equal(effective[key], undefined, `${key}: profile declares none -> the overlay value must not survive`)
    } else {
      assert.deepEqual(effective[key], profile[key], `${key}: PINNED means the PROFILE's value wins over the overlay`)
    }
  }

  for (const key of K3_PROFILE_FORBIDDEN_OVERLAY_KEYS) {
    const effective = __internals.normalizeObjects({
      objects: { material: { profile: PROFILE_ID, [key]: SENTINEL } },
    }).material
    assert.equal(effective[key], undefined, `${key}: FORBIDDEN means an overlay value is DELETED, not merged`)
  }
})

test('an overlay cannot WIDEN the profile\'s operations (reachability is profile-owned)', () => {
  const { __internals } = require('../lib/adapters/k3-wise-webapi-adapter.cjs')
  const effective = __internals.normalizeObjects({
    objects: { material: { profile: PROFILE_ID, operations: ['upsert', 'read', 'delete'] } },
  })
  assert.deepEqual(effective.material.operations, ['upsert', 'read'],
    'the profile\'s operation set is the reachable set — an overlay must not add to it')
})

test('PREVIEW == WRITE: a save-only profile forces the preview\'s auto-flags off too', async () => {
  // Found while adapting the adapters suite: previewUpsert resolved auto-flags freely, so with
  // the profile armed AND config.autoSubmit true the PREVIEW said "Submit will fire" while the
  // real write forces it false. Safe direction, wrong property: the human approves the preview.
  const fetchPair = countingFetch()
  const adapter = createK3WiseWebApiAdapter({
    system: {
      id: 'preview-lock-k3', name: 'K3', kind: 'erp:k3-wise-webapi', role: 'target',
      credentials: { username: 'u', password: 'p', acctId: 'AIS' },
      config: {
        baseUrl: 'https://k3.example.test',
        autoSubmit: true, autoAudit: true,
        objects: { material: { profile: PROFILE_ID } },
      },
    },
    fetchImpl: fetchPair.impl,
  })
  const preview = await adapter.previewUpsert({ object: 'material', records: records(1), keyFields: ['FNumber'] })
  assert.equal(preview.metadata.autoSubmit, false, 'the preview must not promise a Submit the write will refuse')
  assert.equal(preview.metadata.autoAudit, false)
  const written = await adapter.upsert({ object: 'material', records: records(1), keyFields: ['FNumber'] })
  assert.equal(written.metadata.autoSubmit, preview.metadata.autoSubmit, 'preview and write must agree')
  assert.equal(written.metadata.autoAudit, preview.metadata.autoAudit)
})

test('ADVERSARIAL P1-C1: a read path may never target a write endpoint — WITHOUT any profile', () => {
  // The third axis a reviewer found: the whole class pin lived inside `if (saveOnlyProfile)`,
  // i.e. it was opt-in by the actor it defends against. A K3 SOURCE pipeline is legitimately
  // profile-less (the configured LIST read owns its readPath) and, driven through the real
  // runner, POSTed an operator-authored body to /K3API/Material/Submit — on dry-runs too.
  // This guard is unconditional; the positive control below is what proves it discriminates
  // rather than refusing every configured read.
  const { __internals } = require('../lib/adapters/k3-wise-webapi-adapter.cjs')

  for (const [label, objects] of [
    ['material read -> Submit', { material: { operations: ['read'], readPath: '/K3API/Material/Submit' } }],
    ['material read -> Audit', { material: { operations: ['read'], readPath: '/K3API/Material/Audit' } }],
    ['a custom object read -> Save', {
      widget: {
        operations: ['read'], readPath: '/K3API/Widget/Save', savePath: '/K3API/Widget/Save',
        schema: [{ name: 'A', label: 'A', type: 'string', required: true }],
      },
    }],
  ]) {
    assert.throws(
      () => __internals.normalizeObjects({ objects }),
      (error) => error.details && error.details.code === 'K3_WISE_READ_PATH_IS_WRITE_ENDPOINT',
      `${label} must be refused with NO profile selected`,
    )
  }

  // POSITIVE CONTROL: legitimate configured reads are untouched — without this, a guard that
  // refused every read would pass the assertions above.
  for (const [label, objects] of [
    ['GetList', { material: { operations: ['read'], readPath: '/K3API/Material/GetList' } }],
    ['GetDetail', { material: { operations: ['read'], readPath: '/K3API/Material/GetDetail' } }],
    ['profile-armed', { material: { profile: PROFILE_ID } }],
  ]) {
    assert.doesNotThrow(() => __internals.normalizeObjects({ objects }), `${label} is a legitimate read and must pass`)
  }
})
