'use strict'

/**
 * W-1(c) — DEFAULT-DENY GATE FOR GENERIC OUTBOUND HTTP WRITE.
 *
 * WHAT WAS OPEN BEFORE THIS SUITE'S SUBJECT EXISTED. The K3 four-layer permanent fence
 * (lib/k3-external-write-permanent-fence.cjs) is BY-KIND: it refuses `erp:k3-wise-webapi` and
 * nothing else. The generic `http` adapter POSTs to whatever `objectConfig.upsertPath` names, and
 * pipeline-runner calls `targetAdapter.upsert(...)` directly — so a generic `http` external system
 * whose `baseUrl` pointed at a K3 (or ANY) endpoint walked straight past the fence. The owner
 * rejected URL-sniffing for K3 (a matcher a proxy hop or an IP literal defeats is worse than none)
 * and ruled that the CAPABILITY is gated instead: env unset => every write refused.
 *
 * WHAT THIS SUITE PROVES, in three parts:
 *
 *   PART 1  THE LEAF. Load semantics (unset / unreadable / malformed / not-an-object), the closed
 *           key sets, the URL-matching refusal, the wildcard refusal, object-scope rules, operation
 *           vocabulary, values-free refusals, and evaluate-does-not-throw vs assert-throws.
 *
 *   PART 2  THE ADAPTER LAYER, WHICH MUST HOLD ALONE. Real `createHttpAdapter`, fake fetch that
 *           COUNTS EVERY CALL. Refused => zero calls. Authorized => the write lands. Both halves,
 *           because a gate that only ever refuses passes the "nothing was written" test while having
 *           broken the product — HG v1.2 §15.2 E4-05, restated for a gate.
 *
 *   PART 3  END TO END through the pipeline runner with the REAL http adapter wired in. Refused =>
 *           zero outbound calls AND no rows written. Authorized => the rows land at the endpoint.
 *           Plus the dry-run leg, which must keep READING and must carry `canApply:false` rather
 *           than presenting a plan that cannot be applied.
 *
 * NOT A DUPLICATE OF THE K3 FENCE SUITE. That one asserts a BAN with no runtime switch. This one
 * asserts a GATE that a deployment opens for named targets. The two are asserted separately, on
 * purpose: collapsing them would be the first step toward someone "simplifying" the gate into the
 * ban or the ban into the gate.
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const gate = require(path.join(LIB, 'outbound-http-write-gate.cjs'))
const {
  GENERIC_HTTP_WRITE_KINDS,
  OUTBOUND_HTTP_WRITE_ALLOWLIST_INVALID,
  OUTBOUND_HTTP_WRITE_DISABLED,
  OUTBOUND_HTTP_WRITE_OPERATIONS,
  OUTBOUND_HTTP_WRITE_OPERATION_REQUEST,
  OUTBOUND_HTTP_WRITE_OPERATION_UPSERT,
  OUTBOUND_HTTP_WRITE_TARGETS_ENV,
  OUTBOUND_HTTP_WRITE_TARGET_NOT_AUTHORIZED,
  OutboundHttpWriteGateError,
  SAFE_HTTP_METHODS,
  assertOutboundHttpWriteAuthorized,
  evaluateOutboundHttpWrite,
  isGenericHttpWriteKind,
  isWriteMethod,
  loadOutboundHttpWriteAllowlist,
} = gate

const { createAdapterRegistry, createReadResult } = require(path.join(LIB, 'contracts.cjs'))
const { createHttpAdapter, createHttpAdapterFactory } = require(path.join(LIB, 'adapters', 'http-adapter.cjs'))
const { createPipelineRunner } = require(path.join(LIB, 'pipeline-runner.cjs'))
const { createDeadLetterStore } = require(path.join(LIB, 'dead-letter.cjs'))
const { createWatermarkStore } = require(path.join(LIB, 'watermark.cjs'))
const { createRunLogger } = require(path.join(LIB, 'run-log.cjs'))

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-outbound-http-write-gate-'))
let tmpSeq = 0

/** Write an allowlist file and return its path. Content is authored inline so it is reviewable. */
function allowlistFile(content) {
  tmpSeq += 1
  const file = path.join(TMP_ROOT, `allowlist-${tmpSeq}.json`)
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2), 'utf8')
  return file
}

/** A fake `process.env` — never mutates the real one, so suite order cannot leak state. */
function envWith(file) {
  return file === null ? {} : { [OUTBOUND_HTTP_WRITE_TARGETS_ENV]: file }
}

const VALID_ALLOWLIST = Object.freeze({
  allowlistId: 'synthetic-v1',
  allowlistVersion: 1,
  targets: [
    { entryId: 'e1', systemId: 'sys_http', objects: ['materials'] },
    { entryId: 'e2', systemId: 'sys_all', allObjects: true, operations: ['upsert', 'request'] },
    { entryId: 'e3', systemId: 'sys_named', systemName: 'Named PLM', kind: 'http', objects: ['orders'] },
  ],
})

const SUBJECT = Object.freeze({
  systemId: 'sys_http',
  systemName: 'HTTP PLM',
  kind: 'http',
  object: 'materials',
  operation: OUTBOUND_HTTP_WRITE_OPERATION_UPSERT,
})

// The strings a refusal must never contain, whatever path produced it.
const FORBIDDEN_IN_REFUSALS = /plm\.example\.test|https?:\/\/|bearer|token-1|key-1|Authorization|\/api\/|C:\\|\/tmp\/|ms-outbound-http-write-gate/i

function assertValuesFree(payload, label) {
  assert.doesNotMatch(JSON.stringify(payload), FORBIDDEN_IN_REFUSALS, label)
}

// ───────────────────────── PART 1 — THE LEAF ─────────────────────────────────

function partOne() {
  // 1.1 UNSET IS DENY, and it is deny WITHOUT TOUCHING THE FILESYSTEM.
  assert.equal(loadOutboundHttpWriteAllowlist({}), null, 'unset env loads nothing')
  assert.equal(loadOutboundHttpWriteAllowlist({ [OUTBOUND_HTTP_WRITE_TARGETS_ENV]: '   ' }), null,
    'a blank env value is unset, not a path')
  const unsetDecision = evaluateOutboundHttpWrite(SUBJECT, {})
  assert.equal(unsetDecision.authorized, false)
  assert.equal(unsetDecision.canApply, false)
  assert.equal(unsetDecision.code, OUTBOUND_HTTP_WRITE_DISABLED, 'the FIXED unset code')
  assert.equal(unsetDecision.status, 403)
  assert.equal(unsetDecision.reason, 'capability_not_authorized')
  assertValuesFree(unsetDecision, 'the unset refusal is values-free')
  // It DOES name the system and object, deliberately: without them an operator cannot write the
  // allowlist entry that fixes the refusal, and an operator who cannot fix a gate widens it.
  assert.equal(unsetDecision.systemId, 'sys_http')
  assert.equal(unsetDecision.object, 'materials')

  // 1.2 A BROKEN DEPLOYMENT NEVER FALLS THROUGH TO ALLOW.
  const missingPath = path.join(TMP_ROOT, 'does-not-exist.json')
  const unreadable = () => loadOutboundHttpWriteAllowlist(envWith(missingPath))
  assert.throws(unreadable, (error) => {
    assert.ok(error instanceof OutboundHttpWriteGateError)
    assert.equal(error.code, OUTBOUND_HTTP_WRITE_ALLOWLIST_INVALID)
    assert.equal(error.status, 500, 'a broken deployment is not a refused caller')
    assert.match(error.message, new RegExp(OUTBOUND_HTTP_WRITE_TARGETS_ENV), 'names the ENV KEY')
    assert.doesNotMatch(error.message, /does-not-exist/, 'never echoes the path')
    assertValuesFree({ message: error.message, details: error.details }, 'load fault is values-free')
    return true
  }, 'an unreadable file throws rather than degrading to unset')

  assert.throws(() => loadOutboundHttpWriteAllowlist(envWith(allowlistFile('{not json'))),
    (error) => error.code === OUTBOUND_HTTP_WRITE_ALLOWLIST_INVALID && error.details.reason === 'malformed_json')
  assert.throws(() => loadOutboundHttpWriteAllowlist(envWith(allowlistFile('[]'))),
    (error) => error.details.reason === 'not_an_object')

  // …and `evaluate` reports the same fault WITHOUT throwing, so a dry-run preview degrades into an
  // honest refusal instead of taking the read leg down with it.
  const brokenDecision = evaluateOutboundHttpWrite(SUBJECT, envWith(missingPath))
  assert.equal(brokenDecision.authorized, false)
  assert.equal(brokenDecision.code, OUTBOUND_HTTP_WRITE_ALLOWLIST_INVALID)
  assert.equal(brokenDecision.status, 500)
  assertValuesFree(brokenDecision, 'the load-fault decision is values-free')

  // 1.3 IDENTITY MATCHING ONLY — the ruling, enforced at load.
  for (const key of ['url', 'baseUrl', 'host', 'hostname', 'path', 'headers', 'apiKey', 'password']) {
    assert.throws(
      () => loadOutboundHttpWriteAllowlist(envWith(allowlistFile({
        allowlistId: 'x', allowlistVersion: 1,
        targets: [{ entryId: 'e', systemId: 's', objects: ['o'], [key]: 'anything' }],
      }))),
      (error) => {
        assert.equal(error.code, OUTBOUND_HTTP_WRITE_ALLOWLIST_INVALID)
        assert.equal(error.details.reason, 'identity_matching_only',
          `${key} must be refused BY THE RULE, not as a generic unsupported key`)
        return true
      },
      `an allowlist may not authorize by ${key}`,
    )
  }
  // An unlisted key that is NOT in the forbidden roster still fails — closed key set — but with the
  // generic message. Both branches asserted so the roster cannot rot into the only check.
  assert.throws(
    () => loadOutboundHttpWriteAllowlist(envWith(allowlistFile({
      allowlistId: 'x', allowlistVersion: 1,
      targets: [{ entryId: 'e', systemId: 's', objects: ['o'], note: 'hi' }],
    }))),
    (error) => error.code === OUTBOUND_HTTP_WRITE_ALLOWLIST_INVALID && error.details.reason === undefined,
  )

  // 1.4 NO WILDCARDS, in any position.
  for (const wildcard of ['*', '**', 'all', 'ANY', 'sys_*']) {
    assert.throws(
      () => loadOutboundHttpWriteAllowlist(envWith(allowlistFile({
        allowlistId: 'x', allowlistVersion: 1,
        targets: [{ entryId: 'e', systemId: wildcard, objects: ['o'] }],
      }))),
      (error) => error.details.reason === 'wildcard_forbidden',
      `systemId ${wildcard} must be refused`,
    )
    assert.throws(
      () => loadOutboundHttpWriteAllowlist(envWith(allowlistFile({
        allowlistId: 'x', allowlistVersion: 1,
        targets: [{ entryId: 'e', systemId: 's', objects: [wildcard] }],
      }))),
      (error) => error.details.reason === 'wildcard_forbidden',
      `objects[] ${wildcard} must be refused`,
    )
  }

  // 1.5 OBJECT SCOPE IS EXPLICIT OR IT IS A LOAD ERROR. Never an implicit wildcard.
  assert.throws(
    () => loadOutboundHttpWriteAllowlist(envWith(allowlistFile({
      allowlistId: 'x', allowlistVersion: 1, targets: [{ entryId: 'e', systemId: 's' }],
    }))),
    (error) => error.details.reason === 'object_scope_required',
    'omitting both objects and allObjects is a load error, not "everything"',
  )
  assert.throws(
    () => loadOutboundHttpWriteAllowlist(envWith(allowlistFile({
      allowlistId: 'x', allowlistVersion: 1,
      targets: [{ entryId: 'e', systemId: 's', objects: ['o'], allObjects: true }],
    }))),
    (error) => error.details.reason === 'ambiguous_object_scope',
    'declaring both is a load error, not a silent precedence rule',
  )
  assert.throws(
    () => loadOutboundHttpWriteAllowlist(envWith(allowlistFile({
      allowlistId: 'x', allowlistVersion: 1, targets: [{ entryId: 'e', systemId: 's', objects: [] }],
    }))),
    (error) => error.code === OUTBOUND_HTTP_WRITE_ALLOWLIST_INVALID,
    'an empty enumeration is not a scope',
  )

  // 1.6 STRUCTURAL LOAD CHECKS.
  assert.throws(() => loadOutboundHttpWriteAllowlist(envWith(allowlistFile({
    allowlistId: 'x', allowlistVersion: 0, targets: [],
  }))), (error) => error.details.field === 'allowlistVersion')
  assert.throws(() => loadOutboundHttpWriteAllowlist(envWith(allowlistFile({
    allowlistId: 'x', allowlistVersion: 1,
    targets: [
      { entryId: 'dup', systemId: 'a', objects: ['o'] },
      { entryId: 'dup', systemId: 'b', objects: ['o'] },
    ],
  }))), (error) => error.details.reason === 'duplicate_entry_id')
  assert.throws(() => loadOutboundHttpWriteAllowlist(envWith(allowlistFile({
    allowlistId: 'x', allowlistVersion: 1,
    targets: [{ entryId: 'e', systemId: 's', objects: ['o'], operations: ['delete-everything'] }],
  }))), (error) => error.details.reason === 'unknown_operation',
  'an operation outside the closed vocabulary is refused at load')

  // An ARMED, EMPTY allowlist is legal and authorizes nothing. Rejecting it would push operators
  // toward leaving the env unset, which is not safer — only less visible.
  const empty = loadOutboundHttpWriteAllowlist(envWith(allowlistFile({
    allowlistId: 'empty', allowlistVersion: 3, targets: [],
  })))
  assert.equal(empty.targetCount, 0)
  assert.equal(evaluateOutboundHttpWrite(SUBJECT, envWith(allowlistFile({
    allowlistId: 'empty', allowlistVersion: 3, targets: [],
  }))).code, OUTBOUND_HTTP_WRITE_TARGET_NOT_AUTHORIZED,
  'an armed empty allowlist refuses with the ARMED code, distinguishable from unset')

  // 1.7 MATCHING.
  const armed = envWith(allowlistFile(VALID_ALLOWLIST))
  const authorized = evaluateOutboundHttpWrite(SUBJECT, armed)
  assert.equal(authorized.authorized, true, 'the listed system+object is authorized')
  assert.equal(authorized.canApply, true)
  assert.equal(authorized.code, null)
  assert.equal(authorized.entryId, 'e1')
  assert.equal(authorized.allowlistId, 'synthetic-v1')

  const cases = [
    [{ ...SUBJECT, systemId: 'sys_other' }, 'target_not_listed', 'an unlisted system id'],
    [{ ...SUBJECT, object: 'orders' }, 'target_not_listed', 'an unlisted object on a listed system'],
    [{ ...SUBJECT, object: null }, 'target_not_listed', 'an unresolvable object fails closed'],
    [{ ...SUBJECT, systemId: null }, 'missing_system_identity', 'an unresolvable system fails closed'],
    [{ ...SUBJECT, operation: OUTBOUND_HTTP_WRITE_OPERATION_REQUEST }, 'target_not_listed',
      'an entry with the default operations does not authorize a request-steered verb'],
    [{ ...SUBJECT, operation: 'invented' }, 'unknown_write_operation',
      'an operation outside the closed vocabulary default-refuses'],
    [{ ...SUBJECT, systemId: 'sys_named', object: 'orders', systemName: 'Wrong Name' },
      'target_not_listed', 'a corroborating systemName must AGREE when the entry states one'],
    [{ ...SUBJECT, systemId: 'sys_named', object: 'orders', systemName: 'Named PLM', kind: 'https' },
      'target_not_listed', 'a corroborating kind must AGREE when the entry states one'],
  ]
  for (const [subject, reason, label] of cases) {
    const decision = evaluateOutboundHttpWrite(subject, armed)
    assert.equal(decision.authorized, false, label)
    assert.equal(decision.reason, reason, label)
    assert.equal(decision.code, OUTBOUND_HTTP_WRITE_TARGET_NOT_AUTHORIZED, label)
    assertValuesFree(decision, `${label}: values-free`)
  }
  assert.equal(
    evaluateOutboundHttpWrite({ ...SUBJECT, systemId: 'sys_named', object: 'orders', systemName: 'Named PLM' }, armed).authorized,
    true, 'a fully corroborated entry matches')
  assert.equal(
    evaluateOutboundHttpWrite({ ...SUBJECT, systemId: 'sys_all', object: 'anything-at-all' }, armed).authorized,
    true, 'an explicit allObjects entry authorizes every object of THAT system')
  assert.equal(
    evaluateOutboundHttpWrite({ ...SUBJECT, systemId: 'sys_all', object: 'x', operation: OUTBOUND_HTTP_WRITE_OPERATION_REQUEST }, armed).authorized,
    true, 'an entry that names `request` authorizes the transport entry point')

  // 1.8 ASSERT THROWS WHERE EVALUATE REPORTS, and hands the layer its own error type.
  class LayerError extends Error {
    constructor(status, code, message, details) {
      super(message)
      this.status = status
      this.code = code
      this.details = details
    }
  }
  const build = (status, code, message, details) => new LayerError(status, code, message, details)
  assert.equal(assertOutboundHttpWriteAuthorized(build, SUBJECT, armed).authorized, true,
    'an authorized subject returns the stanza instead of throwing')
  assert.throws(() => assertOutboundHttpWriteAuthorized(build, SUBJECT, {}), (error) => {
    assert.ok(error instanceof LayerError, 'the layer keeps its own error type')
    assert.equal(error.code, OUTBOUND_HTTP_WRITE_DISABLED)
    assert.equal(error.status, 403)
    assert.equal(error.details.code, OUTBOUND_HTTP_WRITE_DISABLED, 'the code also rides details')
    assert.equal(error.details.authorized, undefined, 'the boolean is not smuggled into details')
    assertValuesFree({ message: error.message, details: error.details }, 'thrown refusal is values-free')
    return true
  })

  // 1.9 THE FROZEN VOCABULARIES.
  assert.deepEqual([...OUTBOUND_HTTP_WRITE_OPERATIONS], ['upsert', 'request'])
  assert.deepEqual([...SAFE_HTTP_METHODS], ['GET', 'HEAD', 'OPTIONS'])
  assert.deepEqual([...GENERIC_HTTP_WRITE_KINDS], ['http'])
  assert.equal(isGenericHttpWriteKind('http'), true)
  assert.equal(isGenericHttpWriteKind('erp:k3-wise-webapi'), false,
    'the K3 kind is NOT this gate\'s subject — it is permanently banned by G-4, elsewhere')
  for (const method of ['POST', 'put', 'PATCH', 'delete', 'weird']) {
    assert.equal(isWriteMethod(method), true, `${method} is a write method`)
  }
  for (const method of ['GET', 'get', 'HEAD', 'OPTIONS', undefined]) {
    assert.equal(isWriteMethod(method), false, `${String(method)} is a safe method`)
  }
  assert.throws(() => { OUTBOUND_HTTP_WRITE_OPERATIONS.push('x') }, TypeError, 'the vocabulary is frozen')

  // 1.10 THE BAN-VS-GATE DISTINCTION, ASSERTED IN CODE. This module is env-configurable BY DESIGN;
  // the K3 fence must never become so. Both halves are pinned so a future edit that blurs them is
  // a RED here rather than a review miss.
  const gateSource = fs.readFileSync(path.join(LIB, 'outbound-http-write-gate.cjs'), 'utf8')
  const fenceSource = fs.readFileSync(path.join(LIB, 'k3-external-write-permanent-fence.cjs'), 'utf8')
  assert.match(gateSource, /process\.env/, 'the GATE reads env — that is its mechanism')
  assert.doesNotMatch(fenceSource, /process\.env|require\(/,
    'the permanent K3 FENCE must stay env-free and dependency-free (HG v1.2 §10.1)')
  assert.match(gateSource, /NOT G-4/, 'the gate states, in its own header, that it is not the ban')
  // The gate is a LEAF: no intra-package requires, so it can be pulled into the adapter, the runner
  // and any future route without a cycle.
  const gateRequires = [...gateSource.matchAll(/require\('([^']+)'\)/g)].map((match) => match[1])
  assert.deepEqual(gateRequires, ['node:fs'], 'the gate requires nothing but node:fs')

  // 1.11 WHY THERE IS NO C6 LAYER — pinned rather than asserted in prose.
  //
  // The C6 apply engine (external-write-dry-run.cjs) is PER-KIND: `normalizeTargetConfig` refuses
  // any system whose kind is not the resolved write profile's, and no profile in this package names
  // a generic-http kind. A generic `http` target therefore CANNOT reach C6 today, which is why
  // W-1(c) gates the pipeline-runner seam instead. If someone later adds an http write profile,
  // this assertion turns RED and the gate must grow a third layer with it.
  const c6 = require(path.join(LIB, 'external-write-dry-run.cjs')).__internals
  assert.equal(isGenericHttpWriteKind(c6.resolveTargetWriteProfile({}).kind), false,
    'the default C6 write profile is not a generic-http kind')
  assert.equal(isGenericHttpWriteKind(c6.SQL_WRITE_GATED_PROFILE.kind), false)
  assert.throws(
    () => c6.normalizeTargetConfig({ kind: 'http', config: {} }, c6.SQL_WRITE_GATED_PROFILE),
    (error) => error.code === 'C6_WRITE_TARGET_REQUIRED',
    'C6 refuses a generic-http target before any write path — no http target flows through C6',
  )

  console.log('  ✓ part 1: leaf contract (load, identity matching, wildcards, scope, vocabulary)')
}

// ─────────────────── PART 2 — THE ADAPTER LAYER, ALONE ───────────────────────

function createCountingFetch() {
  const calls = []
  const writeCalls = []
  const fetchImpl = async (url, options = {}) => {
    const record = { url, method: options.method || 'GET', body: options.body }
    calls.push(record)
    if (options.body !== undefined || !SAFE_HTTP_METHODS.includes(String(record.method).toUpperCase())) {
      writeCalls.push(record)
    }
    // A faithful-enough endpoint: it acknowledges exactly the records it was sent, so a `partial`
    // run status can only come from the runner, never from an under-counting stub.
    const sent = options.body === undefined ? [] : (JSON.parse(options.body).records || [])
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          written: sent.length,
          skipped: 0,
          failed: 0,
          results: sent.map((record) => ({ key: record._integration_idempotency_key })),
          items: [],
        })
      },
    }
  }
  return { calls, writeCalls, fetchImpl }
}

function httpSystem(overrides = {}) {
  return {
    id: 'sys_e2e',
    name: 'E2E HTTP target',
    kind: 'http',
    role: 'bidirectional',
    credentials: { bearerToken: 'token-1', apiKey: 'key-1' },
    config: {
      baseUrl: 'https://plm.example.test/root/',
      healthPath: '/health',
      objects: {
        BD_MATERIAL: { path: '/api/materials', upsertPath: '/api/materials/batch', operations: ['read', 'upsert'] },
        materials: { path: '/api/materials', recordsPath: 'items', operations: ['read'] },
      },
    },
    ...overrides,
  }
}

const E2E_ALLOWLIST = Object.freeze({
  allowlistId: 'e2e-synthetic',
  allowlistVersion: 1,
  targets: [{ entryId: 'e2e', systemId: 'sys_e2e', kind: 'http', objects: ['BD_MATERIAL'] }],
})

/**
 * The gate reads the REAL `process.env` at every production call site — deliberately, since an
 * injected allowlist would be an unlock surface. So the layered proofs must set and restore it.
 * `withEnv` keeps that mutation scoped and restores the prior value even on a throw.
 */
async function withEnv(value, fn) {
  const previous = process.env[OUTBOUND_HTTP_WRITE_TARGETS_ENV]
  if (value === null) delete process.env[OUTBOUND_HTTP_WRITE_TARGETS_ENV]
  else process.env[OUTBOUND_HTTP_WRITE_TARGETS_ENV] = value
  try {
    return await fn()
  } finally {
    if (previous === undefined) delete process.env[OUTBOUND_HTTP_WRITE_TARGETS_ENV]
    else process.env[OUTBOUND_HTTP_WRITE_TARGETS_ENV] = previous
  }
}

async function partTwo() {
  // 2.1 REFUSED => ZERO OUTBOUND CALLS. Not "zero writes recorded by the fake server" — zero
  // invocations of fetch at all, so nothing was even attempted.
  await withEnv(null, async () => {
    const { calls, fetchImpl } = createCountingFetch()
    const adapter = createHttpAdapter({ system: httpSystem(), fetchImpl })
    const refusal = await adapter.upsert({
      object: 'BD_MATERIAL',
      records: [{ FNumber: 'A-01' }],
      keyFields: ['FNumber'],
    }).catch((error) => error)
    assert.equal(refusal.code, OUTBOUND_HTTP_WRITE_DISABLED)
    assert.equal(calls.length, 0, 'ZERO fetch invocations with the capability unauthorized')
    assertValuesFree({ message: refusal.message, details: refusal.details }, 'adapter refusal values-free')

    // The read leg is UNTOUCHED — the half that stops this being a blanket deny.
    await adapter.read({ object: 'materials', limit: 10 })
    assert.equal(calls.length, 1, 'the read reached fetch')
    assert.equal(calls[0].method, 'GET')
  })

  // 2.2 AUTHORIZED => THE WRITE PROCEEDS. The E4-05 half.
  await withEnv(allowlistFile(E2E_ALLOWLIST), async () => {
    const { calls, writeCalls, fetchImpl } = createCountingFetch()
    const adapter = createHttpAdapter({ system: httpSystem(), fetchImpl })
    const result = await adapter.upsert({
      object: 'BD_MATERIAL',
      records: [{ FNumber: 'A-01' }],
      keyFields: ['FNumber'],
    })
    assert.equal(result.written, 1, 'the authorized write lands')
    assert.equal(writeCalls.length, 1, 'exactly one outbound write')
    assert.equal(writeCalls[0].method, 'POST')
    assert.match(writeCalls[0].url, /\/api\/materials\/batch$/, 'at the configured upsert path')
    assert.equal(calls.length, 1)
  })

  // 2.3 THE ADAPTER LAYER MUST HOLD WITHOUT THE RUNNER. An in-process caller that never goes near
  // pipeline-runner — a script, a future scheduler, a route that builds its own adapter — is
  // refused all the same, because the gate lives INSIDE `createHttpAdapter`.
  await withEnv(allowlistFile(E2E_ALLOWLIST), async () => {
    const { calls, fetchImpl } = createCountingFetch()
    // Same allowlist, DIFFERENT system id: the deployment authorized `sys_e2e`, not this one, even
    // though the baseUrl is byte-identical. This is the URL-vs-identity ruling, observed.
    const adapter = createHttpAdapter({ system: httpSystem({ id: 'sys_impostor' }), fetchImpl })
    const refusal = await adapter.upsert({
      object: 'BD_MATERIAL', records: [{ FNumber: 'A-01' }], keyFields: ['FNumber'],
    }).catch((error) => error)
    assert.equal(refusal.code, OUTBOUND_HTTP_WRITE_TARGET_NOT_AUTHORIZED)
    assert.equal(calls.length, 0, 'ZERO fetch invocations for an unlisted system at the same URL')
  })

  // 2.4 NO ARGUMENT, HEADER OR OPTION UNLOCKS IT. The adapter constructor takes no policy, and the
  // upsert input cannot carry one — asserted by trying the shapes a caller would reach for.
  await withEnv(null, async () => {
    const { calls, fetchImpl } = createCountingFetch()
    const smuggles = [
      { system: httpSystem(), fetchImpl, outboundHttpWriteAllowlist: E2E_ALLOWLIST },
      { system: httpSystem({ config: { ...httpSystem().config, outboundHttpWriteTargets: E2E_ALLOWLIST } }), fetchImpl },
      { system: httpSystem({ capabilities: { outboundHttpWrite: true } }), fetchImpl },
    ]
    for (const options of smuggles) {
      const adapter = createHttpAdapter(options)
      const refusal = await adapter.upsert({
        object: 'BD_MATERIAL', records: [{ FNumber: 'A-01' }], keyFields: ['FNumber'],
        options: { outboundHttpWriteTargets: E2E_ALLOWLIST },
      }).catch((error) => error)
      assert.equal(refusal.code, OUTBOUND_HTTP_WRITE_DISABLED, 'no argument unlocks the gate')
    }
    assert.equal(calls.length, 0, 'ZERO fetch invocations across every unlock attempt')
  })

  console.log('  ✓ part 2: adapter layer holds alone (refused => 0 calls; authorized => write lands)')
}

// ───────────── PART 3 — END TO END THROUGH THE PIPELINE RUNNER ───────────────

function createMockDb() {
  const tables = new Map([
    ['integration_dead_letters', []],
    ['integration_watermarks', []],
    ['integration_runs', []],
  ])
  const rows = (table) => {
    if (!tables.has(table)) tables.set(table, [])
    return tables.get(table)
  }
  const matches = (row, where) => Object.entries(where || {}).every(([key, value]) => (
    value === null || value === undefined
      ? row[key] === null || row[key] === undefined
      : row[key] === value
  ))
  return {
    tables,
    async selectOne(table, where) { return rows(table).find((row) => matches(row, where)) || null },
    async insertOne(table, row) {
      const stored = { ...row, created_at: '2026-08-29T00:00:00.000Z', updated_at: '2026-08-29T00:00:00.000Z' }
      rows(table).push(stored)
      return [stored]
    },
    async updateRow(table, set, where) {
      const row = rows(table).find((candidate) => matches(candidate, where))
      if (!row) return []
      Object.assign(row, set, { updated_at: '2026-08-29T01:00:00.000Z' })
      return [row]
    },
    async select(table, options = {}) { return rows(table).filter((row) => matches(row, options.where || {})) },
  }
}

function createHarness({ fetchImpl, targetSystemId = 'sys_e2e' }) {
  const db = createMockDb()
  const pipeline = {
    id: 'pipe_http',
    tenantId: 'tenant_1',
    workspaceId: null,
    projectId: 'project_1',
    sourceSystemId: 'source_1',
    sourceObject: 'materials',
    targetSystemId,
    targetObject: 'BD_MATERIAL',
    mode: 'full',
    status: 'active',
    idempotencyKeyFields: ['code'],
    options: { batchSize: 100 },
    fieldMappings: [
      { sourceField: 'code', targetField: 'FNumber', validation: [{ type: 'required' }] },
    ],
  }
  let nextRun = 1
  const pipelineRegistry = {
    async getPipeline() { return pipeline },
    async createPipelineRun(input) {
      const id = `run_${nextRun++}`
      await db.insertOne('integration_runs', {
        id,
        tenant_id: input.tenantId,
        workspace_id: input.workspaceId ?? null,
        pipeline_id: input.pipelineId,
        status: input.status,
        details: input.details || {},
      })
      return { id, tenantId: input.tenantId, workspaceId: input.workspaceId ?? null, pipelineId: input.pipelineId, status: input.status, details: {} }
    },
    async updatePipelineRun(input) {
      const rows = await db.updateRow('integration_runs', {
        status: input.status,
        rows_written: input.rowsWritten,
        details: input.details || {},
      }, { tenant_id: input.tenantId, workspace_id: input.workspaceId ?? null, id: input.id })
      const row = rows[0] || {}
      return { ...row, id: input.id, status: input.status, details: row.details || {}, provenanceEvents: [] }
    },
  }
  const systems = new Map([
    ['source_1', { id: 'source_1', name: 'PLM mock', kind: 'mock-source', role: 'source', config: {} }],
    [targetSystemId, { ...httpSystem({ id: targetSystemId }), role: 'target' }],
  ])
  const externalSystemRegistry = {
    async getExternalSystem(input) { return systems.get(input.id) },
    async getExternalSystemForAdapter(input) { return systems.get(input.id) },
  }
  const adapterRegistry = createAdapterRegistry()
    .registerAdapter('mock-source', () => ({
      async testConnection() { return { ok: true } },
      async listObjects() { return [{ name: 'materials' }] },
      async getSchema() { return { fields: [] } },
      async read() { return createReadResult({ records: [{ code: 'A-01' }, { code: 'B-02' }] }) },
      async upsert() { throw new Error('source upsert must not be called') },
    }))
    // THE REAL HTTP ADAPTER. `fetchImpl` is the transport, not policy — the allowlist still comes
    // only from the server-side file.
    .registerAdapter('http', createHttpAdapterFactory({ fetchImpl }))

  const runner = createPipelineRunner({
    pipelineRegistry,
    externalSystemRegistry,
    adapterRegistry,
    deadLetterStore: createDeadLetterStore({ db, idGenerator: () => `dl_${db.tables.get('integration_dead_letters').length + 1}` }),
    watermarkStore: createWatermarkStore({ db }),
    runLogger: createRunLogger({ pipelineRegistry }),
    clock: (() => { let tick = 0; return () => tick++ * 25 })(),
  })
  return { db, runner }
}

const RUN_INPUT = Object.freeze({
  tenantId: 'tenant_1', workspaceId: null, pipelineId: 'pipe_http', mode: 'manual', triggeredBy: 'test',
})

async function partThree() {
  // 3.1 UNSET => the run refuses at TARGET RESOLUTION: zero fetch calls of ANY kind, so the SOURCE
  // was never read either. That is the point of the second layer — a refused run costs nothing and
  // leaves no half-run behind.
  await withEnv(null, async () => {
    const { calls, fetchImpl } = createCountingFetch()
    const { runner } = createHarness({ fetchImpl })
    const refusal = await runner.runPipeline({ ...RUN_INPUT }).catch((error) => error)
    assert.ok(refusal instanceof Error, 'the run refuses')
    assert.equal(refusal.details.code, OUTBOUND_HTTP_WRITE_DISABLED)
    assert.equal(refusal.details.status, 403)
    assert.equal(calls.length, 0, 'ZERO outbound HTTP calls for a refused run')
    assertValuesFree({ message: refusal.message, details: refusal.details }, 'runner refusal values-free')
  })

  // 3.2 ARMED BUT UNLISTED => the DISTINCT code, still zero calls.
  await withEnv(allowlistFile(E2E_ALLOWLIST), async () => {
    const { calls, fetchImpl } = createCountingFetch()
    const { runner } = createHarness({ fetchImpl, targetSystemId: 'sys_unlisted' })
    const refusal = await runner.runPipeline({ ...RUN_INPUT }).catch((error) => error)
    assert.equal(refusal.details.code, OUTBOUND_HTTP_WRITE_TARGET_NOT_AUTHORIZED)
    assert.equal(calls.length, 0, 'ZERO outbound HTTP calls for an unlisted target')
  })

  // 3.3 AUTHORIZED => THE RUN WRITES. Without this the suite would prove only that a deny is a deny.
  await withEnv(allowlistFile(E2E_ALLOWLIST), async () => {
    const { calls, writeCalls, fetchImpl } = createCountingFetch()
    const { runner } = createHarness({ fetchImpl })
    const result = await runner.runPipeline({ ...RUN_INPUT })
    assert.equal(result.run.status, 'succeeded', 'the authorized run succeeds end to end')
    assert.equal(writeCalls.length, 1, 'exactly one outbound write reached the endpoint')
    assert.equal(writeCalls[0].method, 'POST')
    const body = JSON.parse(writeCalls[0].body)
    assert.deepEqual(body.records.map((record) => record.FNumber), ['A-01', 'B-02'],
      'the transformed rows actually left the process')
    assert.equal(calls.length, 1, 'the write is the only outbound call — the source is a mock')
  })

  // 3.4 DRY RUN KEEPS READING and tells the truth about apply. A preview that showed a clean plan
  // for a write the gate will refuse would be a lie; one that died on the gated target would be the
  // E4-05 FAIL. It must do neither.
  await withEnv(null, async () => {
    const { writeCalls, fetchImpl } = createCountingFetch()
    const { runner } = createHarness({ fetchImpl })
    const dry = await runner.runPipeline({ ...RUN_INPUT, dryRun: true })
    assert.equal(dry.run.status, 'succeeded', 'the dry run is NOT refused — it performs no write')
    assert.equal(dry.preview.records.length, 2, 'the read/transform legs still produce a preview')
    assert.equal(writeCalls.length, 0, 'a dry run emits no outbound write, gated or not')
    assert.equal(dry.preview.outboundHttpWrite.canApply, false, 'the preview does not pretend it can be applied')
    assert.equal(dry.preview.outboundHttpWrite.refusalCode, OUTBOUND_HTTP_WRITE_DISABLED)
    assertValuesFree(dry.preview.outboundHttpWrite, 'the preview stanza is values-free')
  })

  await withEnv(allowlistFile(E2E_ALLOWLIST), async () => {
    const { writeCalls, fetchImpl } = createCountingFetch()
    const { runner } = createHarness({ fetchImpl })
    const dry = await runner.runPipeline({ ...RUN_INPUT, dryRun: true })
    assert.equal(dry.preview.outboundHttpWrite.canApply, true,
      'an authorized target previews as appliable — the discriminating control for 3.4')
    assert.equal(dry.preview.outboundHttpWrite.refusalCode, null)
    assert.equal(writeCalls.length, 0, 'a dry run still writes nothing')
  })

  console.log('  ✓ part 3: end-to-end runner -> real http adapter -> fake fetch (deny, allow, dry-run)')
}

async function main() {
  partOne()
  await partTwo()
  await partThree()
  console.log('✓ outbound-http-write-gate: W-1(c) default-deny gate tests passed')
}

main().catch((error) => {
  console.error('✗ outbound-http-write-gate FAILED')
  console.error(error)
  process.exit(1)
})
