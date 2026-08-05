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
  // REVIEW P2-D3/P2-E2: the walk was post-filtered by a TWO-FILENAME whitelist, so a brand-new
  // k3 consumer reading untriaged fields stayed green — the escape re-armed for the next file.
  // (And I claimed this fixed once before while a `git checkout --` had silently reverted it;
  // see the commit message retraction.) Filter is the module FAMILY now, and reads are matched
  // in dot AND bracket form. Dot form takes NO whitespace: with `\s*` it spanned newlines and
  // matched prose in a comment as a field named `The`.
  const OBJECT_CONFIG_READ = /objectConfig(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\])/g
  // REVIEW P2-F4 (round 6): a `.filter((rel) => /(^|\/)k3-[A-Za-z0-9-]+\.cjs$/.test(rel))` used
  // to sit here, so "the K3 module family" was really A FILENAME CONVENTION. A byte-identical
  // consumer named `kingdee-save-helper.cjs` swept GREEN. Membership is now decided ONLY by
  // content — does this file read objectConfig? — and everything found must be triaged into one
  // of the two declared lists. See the positive control below, which proves the removal is
  // load-bearing under a non-`k3-` filename.
  const discovered = walk(libRoot)
    .filter((f) => { OBJECT_CONFIG_READ.lastIndex = 0; return OBJECT_CONFIG_READ.test(fs.readFileSync(f, 'utf8')) })
    .map((f) => path.relative(path.join(__dirname, '..'), f))
    .sort()
  const { K3_NON_PROFILE_OBJECT_CONFIG_MODULES } = require('../lib/adapters/k3-wise-webapi-adapter.cjs')
  assert.deepEqual(discovered,
    [...K3_PROFILE_OBJECT_CONFIG_CONSUMERS, ...K3_NON_PROFILE_OBJECT_CONFIG_MODULES].sort(),
    'a K3 module reading objectConfig is in NEITHER list — triage it, or declare it out of scope WITH a reason')
  for (const rel of K3_PROFILE_OBJECT_CONFIG_CONSUMERS) {
    assert.ok(!K3_NON_PROFILE_OBJECT_CONFIG_MODULES.includes(rel),
      `${rel} cannot be both a consumer and out of scope — that would dodge the field triage`)
  }

  const reads = new Set()
  for (const rel of K3_PROFILE_OBJECT_CONFIG_CONSUMERS) {
    const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8')
    for (const m of src.matchAll(OBJECT_CONFIG_READ)) reads.add(m[1] || m[2])
    assert.equal(/const\s*\{[^}]*\}\s*=\s*objectConfig/.test(src), false,
      `${rel} destructures objectConfig — the sweep cannot see those reads; refactor or extend the sweep`)
  }
  assert.ok(reads.size >= 30, `the sweep must actually find reads (found ${reads.size}) — a regex matching nothing would pass vacuously`)

  const triaged = new Set([
    ...K3_PROFILE_PINNED_REQUEST_KEYS,
    ...K3_PROFILE_FORBIDDEN_OVERLAY_KEYS,
    ...K3_PROFILE_TRIAGED_SAFE_KEYS,
  ])
  assert.deepEqual([...reads].filter((k) => !triaged.has(k)).sort(), [],
    'untriaged objectConfig field(s) — decide: profile-pinned, forbidden-overlay, or documented-safe')

  // POSITIVE CONTROL for the FAMILY RULE (review P2-F4). The discovery above must be shown to
  // catch a new consumer whose filename does NOT start with `k3-` — that exact file swept GREEN
  // before this round. Written and removed inside the test so it cannot linger in the tree.
  const probe = path.join(libRoot, 'adapters', 'kingdee-save-helper.cjs')
  assert.equal(fs.existsSync(probe), false, 'probe filename must not collide with a real module')
  fs.writeFileSync(probe, "'use strict'\nmodule.exports = (objectConfig) => objectConfig.savePath\n")
  try {
    const rediscovered = walk(libRoot)
      .filter((f) => { OBJECT_CONFIG_READ.lastIndex = 0; return OBJECT_CONFIG_READ.test(fs.readFileSync(f, 'utf8')) })
      .map((f) => path.relative(path.join(__dirname, '..'), f))
      .sort()
    assert.ok(rediscovered.includes('lib/adapters/kingdee-save-helper.cjs'),
      'a non-`k3-` consumer must be DISCOVERED — otherwise the family filter is still a filename convention')
    assert.notDeepEqual(rediscovered,
      [...K3_PROFILE_OBJECT_CONFIG_CONSUMERS, ...K3_NON_PROFILE_OBJECT_CONFIG_MODULES].sort(),
      'and it must make the contract assertion RED until triaged')
  } finally {
    fs.unlinkSync(probe)
  }
  assert.equal(fs.existsSync(probe), false, 'probe must be removed even if the assertions failed')
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
    // REVIEW P1-D1: the guard used to test the RAW string while buildEndpointUrl's WHATWG
    // pathname setter rewrote it — `/GetDetail/../Submit/` cleared the guard and went out as
    // `/Submit/`. Check-before-normalize. Each vector below reaches the same resolved endpoint
    // by a different spelling; the check now runs on the RESOLVED pathname.
    ['traversal', { material: { operations: ['read'], readPath: '/K3API/Material/GetDetail/../Submit/' } }],
    ['trailing slash', { material: { operations: ['read'], readPath: '/K3API/Material/Submit/' } }],
    ['percent-encoded', { material: { operations: ['read'], readPath: '/K3API/Material/%53ubmit' } }],
    ['double slash', { material: { operations: ['read'], readPath: '/K3API/Material//Submit' } }],
    ['upper case', { material: { operations: ['read'], readPath: '/K3API/Material/SUBMIT' } }],
    // REVIEW P1-F1 — AXIS 6, the same defect once more: a bare `.` segment is not `..` and `.`
    // is inside the allowlist's character class, so these cleared BOTH guards; the pathname
    // setter then dropped the dot segment and `/K3API/Material/Submit/` went out on the wire.
    // The check now runs the SETTER itself rather than re-deriving what it does.
    ['dot segment', { material: { operations: ['read'], readPath: '/K3API/Material/Submit/.' } }],
    ['dot segment + slash', { material: { operations: ['read'], readPath: '/K3API/Material/Submit/./' } }],
    ['repeated dot segments', { material: { operations: ['read'], readPath: '/K3API/Material/Submit/./.' } }],
    ['dot segment mid-path', { material: { operations: ['read'], readPath: '/K3API/./Material/Submit/.' } }],
    ['dot segment + case', { material: { operations: ['read'], readPath: '/K3API/Material/SUBMIT/.' } }],
    ['dot segment -> Save', { material: { operations: ['read'], readPath: '/K3API/Material/Save/.' } }],
    ['a custom object read -> Save', {
      widget: {
        operations: ['read'], readPath: '/K3API/Widget/Save', savePath: '/K3API/Widget/Save',
        schema: [{ name: 'A', label: 'A', type: 'string', required: true }],
      },
    }],
  ]) {
    assert.throws(
      () => __internals.normalizeObjects({ objects }),
      // The positive allowlist (axis 5) now fires FIRST for the encoded/traversal spellings,
      // so accept either endpoint refusal — what matters is that none of them reaches the wire.
      (error) => error.details && (error.details.code === 'K3_WISE_READ_PATH_IS_WRITE_ENDPOINT'
        || error.details.code === 'K3_WISE_ENDPOINT_NOT_SAFE_RELATIVE'),
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


test('REVIEW P1-F2: config.healthPath — the third sibling — may not target a write endpoint', async () => {
  // loginPath and tokenPath were guarded one round earlier; healthPath sat on the NEXT LINE and
  // was missed, and testConnection takes its VERB from the request body, so this POSTed an
  // operator-authored envelope to Submit after a successful login. Enumerating siblings by hand
  // is what failed; the wire gate below is the structural half of the fix.
  const { __internals } = require('../lib/adapters/k3-wise-webapi-adapter.cjs')
  for (const healthPath of ['/K3API/Material/Submit', '/K3API/Material/Submit/.', '/K3API/Material/Save/']) {
    assert.throws(
      () => __internals.assertSafeK3ReadEndpoint(healthPath, 'config.healthPath'),
      (error) => error.details && (error.details.code === 'K3_WISE_READ_PATH_IS_WRITE_ENDPOINT'
        || error.details.code === 'K3_WISE_ENDPOINT_NOT_SAFE_RELATIVE'),
      `healthPath ${healthPath} must be refused`,
    )
  }
  // MUTATION M5 CAUGHT THIS: the assertions above call the helper DIRECTLY, so deleting the
  // call site in the factory left them all green — the guard was tested, its WIRING was not.
  // Drive the real constructor so the delegation itself is load-bearing.
  for (const healthPath of ['/K3API/Material/Submit', '/K3API/Material/Submit/.']) {
    assert.throws(
      () => createK3WiseWebApiAdapter({
        system: {
          kind: 'erp:k3-wise-webapi',
          config: {
            baseUrl: 'https://k3.invalid',
            healthPath,
            objects: { material: { operations: ['read'], readPath: '/K3API/Material/GetList' } },
          },
          credentials: { acctId: 'a', username: 'u', password: 'p' },
        },
        fetchImpl: async () => jsonResponse(200, { success: true }),
      }),
      (error) => error.details && error.details.field === 'config.healthPath'
        && (error.details.code === 'K3_WISE_READ_PATH_IS_WRITE_ENDPOINT'
          || error.details.code === 'K3_WISE_ENDPOINT_NOT_SAFE_RELATIVE'),
      `constructing with healthPath ${healthPath} must be refused AT SETUP, naming the field`,
    )
  }

  // POSITIVE CONTROL: a real health endpoint still passes, and absent stays absent.
  assert.doesNotThrow(() => __internals.assertSafeK3ReadEndpoint('/K3API/Health', 'config.healthPath'))
  assert.doesNotThrow(() => __internals.assertSafeK3ReadEndpoint(undefined, 'config.healthPath'))
  assert.doesNotThrow(() => createK3WiseWebApiAdapter({
    system: {
      kind: 'erp:k3-wise-webapi',
      config: {
        baseUrl: 'https://k3.invalid',
        healthPath: '/K3API/Health',
        objects: { material: { operations: ['read'], readPath: '/K3API/Material/GetList' } },
      },
      credentials: { acctId: 'a', username: 'u', password: 'p' },
    },
    fetchImpl: async () => jsonResponse(200, { success: true }),
  }), 'a legitimate healthPath must still construct')
  // P2-F5: a non-string used to return silently, making the guard a no-op on unchecked shapes.
  assert.throws(() => __internals.assertSafeK3ReadEndpoint({ toString: () => '/K3API/Health' }, 'config.healthPath'),
    (error) => error.details && error.details.code === 'K3_WISE_ENDPOINT_NOT_A_STRING')
})

test('REVIEW P1-F1: the WIRE gate is fail-closed on intent and sees the produced pathname', () => {
  // Six escapes came from two halves of one class: COVERAGE (which fields get checked) and
  // AGREEMENT (checked string vs used string). This gate closes both at the single choke point
  // every K3 request passes through. Undeclared intent THROWS, so a newly added path field
  // cannot reach the wire by omission — the omission is itself the failure.
  const { __internals } = require('../lib/adapters/k3-wise-webapi-adapter.cjs')
  const { assertWireEndpointIntent, toWireEndpointPathname } = __internals

  for (const intent of [undefined, null, '', 'write', 'READ', 'read ', 0, {}, true]) {
    assert.throws(() => assertWireEndpointIntent('/K3API/Material/GetList', intent),
      (error) => error.details && error.details.code === 'K3_WISE_ENDPOINT_INTENT_UNDECLARED',
      `intent ${JSON.stringify(intent)} must be refused — fail-closed, not fail-open`)
  }

  // A read intent may not land on a lifecycle write endpoint, in ANY spelling that resolves there.
  for (const raw of ['/K3API/Material/Submit', '/K3API/Material/Submit/.', '/K3API/Material/Submit/./',
    '/K3API/Material/GetDetail/../Submit/', '/K3API/Material/SUBMIT/.', '/K3API/Material/Save/.']) {
    assert.throws(() => assertWireEndpointIntent(toWireEndpointPathname(raw), 'read'),
      (error) => error.details && error.details.code === 'K3_WISE_READ_PATH_IS_WRITE_ENDPOINT',
      `${raw} must be refused for a read intent`)
  }

  // POSITIVE CONTROL: real reads pass, and lifecycle writes are still allowed to reach their
  // own endpoints — without this, a gate that refused everything would satisfy the above.
  for (const raw of ['/K3API/Material/GetList', '/K3API/Material/GetDetail', '/K3API/Login', '/K3API/Health']) {
    assert.doesNotThrow(() => assertWireEndpointIntent(toWireEndpointPathname(raw), 'read'), `${raw} is a legitimate read`)
  }
  for (const raw of ['/K3API/Material/Save', '/K3API/Material/Submit', '/K3API/Material/Audit']) {
    assert.doesNotThrow(() => assertWireEndpointIntent(toWireEndpointPathname(raw), 'lifecycle-write'),
      `${raw} is a legitimate lifecycle write`)
  }

  // The normalizer must agree with the SETTER, which is what buildEndpointUrl uses. The URL
  // CONSTRUCTOR disagrees on `//a/x` (it reads `a` as an authority) — re-deriving with the wrong
  // one is how a seventh axis would be born.
  const u = new URL('http://h'); u.pathname = '//a/Submit/.'
  assert.equal(toWireEndpointPathname('//a/Submit/.'), u.pathname.replace(/\/+$/, ''),
    'the normalizer must track the pathname SETTER, not the URL constructor')
})

test('REVIEW P1-F1 END-TO-END: the axis-6 exploit reaches NO write endpoint through the real adapter', async () => {
  // The reviewer proved the exploit end-to-end, not in helpers — so the fix is proven the same
  // way. A profile-less K3 SOURCE (legitimately profile-less: the configured LIST read owns its
  // readPath) with the dot-segment spelling previously POSTed to /K3API/Material/Submit/.
  const fetchPair = countingFetch()
  let caught = null
  try {
    const adapter = createK3WiseWebApiAdapter({
      system: {
        kind: 'erp:k3-wise-webapi',
        config: {
          baseUrl: 'https://k3.invalid',
          objects: { material: { operations: ['read'], readPath: '/K3API/Material/Submit/.' } },
        },
        credentials: { acctId: 'a', username: 'u', password: 'p' },
      },
      fetchImpl: fetchPair.impl,
    })
    await adapter.read({ object: 'material', filters: { FNumber: 'MAT-1' } })
  } catch (error) {
    caught = error
  }
  // Assert the CODE, not merely that something threw: an earlier draft of this test passed
  // while failing on K3_WISE_READ_KEY_REQUIRED — a missing filter, nothing to do with the guard.
  assert.equal(caught && caught.details && caught.details.code, 'K3_WISE_READ_PATH_IS_WRITE_ENDPOINT',
    `the dot-segment read must be refused BY THE ENDPOINT GUARD, got: ${caught && caught.message}`)
  // The load-bearing assertion is not "it threw" but "nothing reached a write endpoint".
  const writeCalls = fetchPair.calls.filter((p) => /\/(submit|audit|delete|save)\/?$/i.test(p))
  assert.deepEqual(writeCalls, [], `no request may reach a lifecycle write endpoint: ${JSON.stringify(fetchPair.calls)}`)

  // POSITIVE CONTROL for the COUNTER: this fetch mock does record calls, so the empty list above
  // is evidence of absence rather than evidence of a mock that never fires.
  const control = countingFetch()
  const ok = createK3WiseWebApiAdapter({
    system: {
      kind: 'erp:k3-wise-webapi',
      config: {
        baseUrl: 'https://k3.invalid',
        objects: { material: { operations: ['read'], readPath: '/K3API/Material/GetList' } },
      },
      credentials: { acctId: 'a', username: 'u', password: 'p' },
    },
    fetchImpl: control.impl,
  })
  await ok.read({ object: 'material', filters: { FNumber: 'MAT-1' } }).catch(() => {})
  assert.ok(control.calls.length > 0,
    'the counting fetch must actually record calls — otherwise the empty write-call list above proves nothing')
  assert.ok(control.calls.some((p) => p.endsWith('/Material/GetList')),
    'and the legitimate read must actually reach its own endpoint')
})

test('REVIEW P1-F1: EVERY request path declares an intent — health included, and future ones too', async () => {
  // Mutation M2 exposed this gap: deleting `intent:` from the health call site left the whole
  // suite GREEN, so the fail-closed COVERAGE property — the half that is supposed to stop the
  // next unguarded field — rested on nothing. Two complementary checks close it.

  // (1) BEHAVIOURAL: testConnection actually drives the health path, so a call site that stops
  //     declaring its intent throws K3_WISE_ENDPOINT_INTENT_UNDECLARED instead of quietly working.
  const calls = []
  const impl = async (url) => {
    calls.push(new URL(url).pathname)
    return jsonResponse(200, { success: true, sessionId: 'health-session' })
  }
  const adapter = createK3WiseWebApiAdapter({
    system: {
      kind: 'erp:k3-wise-webapi',
      config: {
        baseUrl: 'https://k3.invalid',
        healthPath: '/K3API/Health',
        objects: { material: { operations: ['read'], readPath: '/K3API/Material/GetList' } },
      },
      credentials: { acctId: 'a', username: 'u', password: 'p' },
    },
    fetchImpl: impl,
  })
  const result = await adapter.testConnection({})
  assert.equal(result.ok, true, 'the health probe must still work')
  assert.deepEqual(calls, ['/K3API/Login', '/K3API/Health'],
    'login + health must both have been driven — otherwise this test cannot detect a missing intent')

  // (2) MECHANICAL: every requestJson call site in the adapter must declare an intent. A
  //     behavioural test can only cover paths this suite happens to drive; the enumeration
  //     covers the ones it does not, which is where the last six escapes came from.
  const fs = require('node:fs')
  const path = require('node:path')
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'adapters', 'k3-wise-webapi-adapter.cjs'), 'utf8')
  function callSitesMissingIntent(text) {
    const missing = []
    // `await` anchors this to CALL SITES: the declaration `async function requestJson(path, {`
    // otherwise matched and reported a phantom site named `path` (the test caught it).
    const RE = /await requestJson\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*,\s*\{/g
    for (const m of text.matchAll(RE)) {
      // Scan the option object that opens at the matched `{` to its matching close brace.
      let depth = 0
      let i = m.index + m[0].length - 1
      let end = -1
      for (; i < text.length; i += 1) {
        if (text[i] === '{') depth += 1
        else if (text[i] === '}') { depth -= 1; if (depth === 0) { end = i; break } }
      }
      const options = end === -1 ? '' : text.slice(m.index, end)
      if (!/\bintent\s*:/.test(options)) missing.push(m[1])
    }
    return missing
  }
  const sites = [...src.matchAll(/await requestJson\(\s*[A-Za-z_][A-Za-z0-9_]*\s*,\s*\{/g)]
  assert.ok(sites.length >= 10,
    `the enumeration must find the call sites (found ${sites.length}) — a regex matching nothing passes vacuously`)
  assert.deepEqual(callSitesMissingIntent(src), [],
    'a requestJson call site does not declare an intent — it would be refused at runtime, declare it')

  // POSITIVE CONTROL for the enumeration: a call site without an intent must be REPORTED.
  assert.deepEqual(
    callSitesMissingIntent('await requestJson(sneakyPath, { method: "POST", body })'),
    ['sneakyPath'],
    'the enumeration must flag an intent-less call site, or it proves nothing about the real file')
})

test('REVIEW P1-F1/P1-F2 EXCLUSIVITY: the config-time check and the wire gate are independent', () => {
  // Two fail-closed doors covering for each other has already bitten this line twice. Each door
  // must be shown to catch something the other does not, or one of them is decoration.
  const { __internals } = require('../lib/adapters/k3-wise-webapi-adapter.cjs')

  // Only the WIRE gate can catch a path that never passed through config normalization at all
  // (this is precisely the healthPath/loginPath shape, and any future field like it).
  assert.throws(() => __internals.assertWireEndpointIntent(
    __internals.toWireEndpointPathname('/K3API/Material/Submit/.'), 'read'),
    (error) => error.details && error.details.code === 'K3_WISE_READ_PATH_IS_WRITE_ENDPOINT')

  // Only the CONFIG-time check reports the offending FIELD, which is what makes the error
  // actionable at setup time rather than at first request.
  try {
    __internals.assertSafeK3ReadEndpoint('/K3API/Material/Submit/.', 'config.healthPath')
    assert.fail('expected a config-time refusal')
  } catch (error) {
    assert.equal(error.details.field, 'config.healthPath',
      'the config-time check must name the field; the wire gate cannot know it')
  }
})

test('REVIEW P2-D4/P2-E3: the profile arm is UNFORGEABLE — a JSON config cannot claim it', async () => {
  // The Symbol's entire justification is "JSON config can never forge a Symbol key", and that
  // property had ZERO coverage repo-wide: mutating the Symbol to a plain string left every
  // suite green while making the guard bypassable with {profileArmed:true}. (I claimed this
  // test once before while a `git checkout --` had reverted it — see the retraction.)
  const fetchPair = countingFetch()
  for (const forged of [{ profileArmed: true }, { k3CustomerProfileArmed: true }, { 'Symbol(k3CustomerProfileArmed)': true }]) {
    const adapter = adapterWith({
      savePath: '/K3API/Material/Save',
      keyField: 'FNumber',
      schema: [
        { name: 'FNumber', label: 'Code', type: 'string', required: true },
        { name: 'FName', label: 'Name', type: 'string', required: true },
      ],
      ...forged,
    }, fetchPair)
    await assert.rejects(
      adapter.upsert({ object: 'material', records: records(1), keyFields: ['FNumber'] }),
      (error) => error.details && error.details.code === 'K3_WISE_MATERIAL_PROFILE_REQUIRED',
      `a config claiming ${JSON.stringify(forged)} must not arm the profile`,
    )
  }
  assert.deepEqual(fetchPair.calls, [], 'no forgery may reach the network')

  // POSITIVE CONTROL: the genuine selection still arms — otherwise a guard refusing everything
  // would satisfy the assertions above.
  const armed = adapterWith({ profile: PROFILE_ID }, fetchPair)
  assert.equal((await armed.upsert({ object: 'material', records: records(1), keyFields: ['FNumber'] })).written, 1)
})

test('REVIEW P1-E1: query/fragment spellings of a write endpoint are refused (axis 5)', () => {
  const { __internals } = require('../lib/adapters/k3-wise-webapi-adapter.cjs')
  // `new URL(v, base)` splits ?/# off the pathname, but the `pathname` SETTER percent-encodes
  // them into the path and keeps removing dot-segments — so these reached Submit on the wire
  // while the guard saw a clean GetDetail. A positive character allowlist has no such gap.
  for (const [label, readPath] of [
    ['query-hidden traversal', '/K3API/Material/GetDetail?/../Submit'],
    ['fragment-hidden traversal', '/K3API/Material/GetDetail#/../Submit'],
    ['absolute url', 'https://evil.test/x/Submit'],
    ['protocol relative', '//evil.test/Submit'],
    ['backslash', '/K3API\\Material\\Submit'],
    ['percent encoded', '/K3API/Material/%53ubmit'],
  ]) {
    assert.throws(
      () => __internals.normalizeObjects({ objects: { material: { operations: ['read'], readPath } } }),
      // Refused by SOME endpoint guard, and by the module's own error type — an incidental
      // TypeError would not count. Which guard fires is an implementation detail (the absolute
      // URL is caught by the pre-existing relative-endpoint check, before mine).
      (error) => error instanceof Error && /relative|write endpoint|must be relative/i.test(String(error.message)),
      `${label} must be refused`,
    )
  }
  for (const readPath of ['/K3API/Material/GetList', '/K3API/Material/GetDetail']) {
    assert.doesNotThrow(() => __internals.normalizeObjects({ objects: { material: { operations: ['read'], readPath } } }))
  }
})

test('REVIEW P1-E1 sibling: loginPath/tokenPath cannot be pointed at a write endpoint either', () => {
  // Found alongside axis 5: loginPath had NO endpoint guard at all, so `loginPath:
  // '/K3API/Material/Submit'` POSTed the credential envelope to Submit with no trick required.
  for (const [field, value] of [
    ['loginPath', '/K3API/Material/Submit'],
    ['loginPath', '/K3API/Material/GetDetail?/../Submit'],
    ['tokenPath', '/K3API/Material/Audit'],
  ]) {
    assert.throws(
      () => createK3WiseWebApiAdapter({
        system: {
          id: 'login-guard-k3', name: 'K3', kind: 'erp:k3-wise-webapi', role: 'target',
          credentials: { username: 'u', password: 'p', acctId: 'AIS' },
          config: { baseUrl: 'https://k3.example.test', [field]: value, objects: { material: { profile: PROFILE_ID } } },
        },
        fetchImpl: countingFetch().impl,
      }),
      (error) => error.details && (error.details.code === 'K3_WISE_ENDPOINT_NOT_SAFE_RELATIVE'
        || error.details.code === 'K3_WISE_READ_PATH_IS_WRITE_ENDPOINT'),
      `${field}=${value} must be refused`,
    )
  }
  // POSITIVE CONTROL: the default/legitimate paths still construct.
  assert.doesNotThrow(() => createK3WiseWebApiAdapter({
    system: {
      id: 'login-guard-ok', name: 'K3', kind: 'erp:k3-wise-webapi', role: 'target',
      credentials: { username: 'u', password: 'p', acctId: 'AIS' },
      config: { baseUrl: 'https://k3.example.test', loginPath: '/K3API/Login', objects: { material: { profile: PROFILE_ID } } },
    },
    fetchImpl: countingFetch().impl,
  }))
})
