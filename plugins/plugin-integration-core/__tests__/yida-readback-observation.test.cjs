'use strict'

// SA05C2 independent composition: actual planner -> actual fixed GET/readback ->
// native Response/stream -> actual pure comparison. Only fetch is synthetic.
// Supplied config/instance are NOT immutable historical authority or form proof.
const assert = require('node:assert/strict')
const { test } = require('node:test')

const INSTANCE = 'synthetic_instance_1'
const copy = (value) => structuredClone(value)
const deferred = () => {
  let resolve
  const promise = new Promise((yes) => { resolve = yes })
  return { promise, resolve }
}
const flush = async () => { await new Promise(setImmediate); await new Promise(setImmediate) }

async function fixture(variant = 'primary') {
  const planner = await import('../lib/yida-static-plan.mjs')
  const { compareYidaReadback, YidaReadbackObservationError } = await import('../lib/yida-readback-observation.mjs')
  const { createYidaFormReadback, YidaFormReadbackError } = require('../lib/yida-form-readback.cjs')
  const example = planner.createYidaProtocolExample(variant)
  const h = { config: example.config, row: example.rows[0], expectedInstanceId: INSTANCE,
    compareYidaReadback, YidaReadbackObservationError, createYidaFormReadback, YidaFormReadbackError }
  h.plan = () => planner.buildYidaStaticPlan({ config: h.config, rows: [h.row] })
  h.observation = (formData = copy(h.plan().rows[0].payload), patch = {}) => ({ statusCode: 200, instanceId: INSTANCE, formData, ...patch })
  h.compare = (patch = {}) => compareYidaReadback({ config: h.config, row: h.row,
    expectedInstanceId: h.expectedInstanceId, observation: h.observation(), ...patch })
  return h
}

function assertResult(result, expected = {}) {
  assert.deepEqual(Object.keys(result).sort(), [
    'kind', 'status', 'businessVerified', 'historyVerified', 'formOwnershipVerified', 'canRetry',
    'comparedFieldCount', 'matchedFieldCount', 'mismatchedFieldCount', 'missingFieldCount',
    'businessKeyMismatchCount', 'reasonCodes',
  ].sort())
  assert.equal(result.kind, 'yida_known_instance_observation')
  for (const field of ['businessVerified', 'historyVerified', 'formOwnershipVerified', 'canRetry']) assert.equal(result[field], false)
  assert.ok(['observed_match', 'observed_mismatch', 'inconclusive'].includes(result.status))
  for (const field of ['comparedFieldCount', 'matchedFieldCount', 'mismatchedFieldCount', 'missingFieldCount', 'businessKeyMismatchCount']) {
    assert.ok(Number.isSafeInteger(result[field]) && result[field] >= 0)
  }
  assert.equal(result.matchedFieldCount + result.mismatchedFieldCount + result.missingFieldCount, result.comparedFieldCount)
  assert.ok(result.businessKeyMismatchCount <= result.mismatchedFieldCount + result.missingFieldCount)
  assert.ok(result.reasonCodes.every((code) => ['INSTANCE_UNRESOLVED', 'NO_OBSERVATION', 'INSTANCE_MISMATCH', 'FIELD_MISMATCH', 'FIELD_MISSING'].includes(code)))
  assert.equal(new Set(result.reasonCodes).size, result.reasonCodes.length)
  assert.ok(Object.isFrozen(result))
  assert.ok(Object.isFrozen(result.reasonCodes))
  assert.doesNotMatch(JSON.stringify(result), /synthetic_|synthetic-|DEMO-|SPEC-|MAT-|projectNo|parentCode|formUuid|appType|formData|payload|digest|token/i)
  for (const [key, value] of Object.entries(expected)) assert.deepEqual(result[key], value)
}

function fullMatch(result, count = 9) {
  assertResult(result, { status: 'observed_match', comparedFieldCount: count, matchedFieldCount: count,
    mismatchedFieldCount: 0, missingFieldCount: 0, businessKeyMismatchCount: 0, reasonCodes: [] })
}

function inconclusive(result, reason) {
  assertResult(result, { status: 'inconclusive', comparedFieldCount: 0, matchedFieldCount: 0,
    mismatchedFieldCount: 0, missingFieldCount: 0, businessKeyMismatchCount: 0, reasonCodes: [reason] })
}

function throwsObservation(h, callback, code) {
  assert.throws(callback, (error) => {
    assert.ok(error instanceof h.YidaReadbackObservationError)
    assert.equal(error.code, `YIDA_OBSERVATION_${code}`)
    assert.equal(error.message, error.code)
    assert.deepEqual(Object.keys(error).sort(), ['code', 'name'])
    assert.equal(error.cause, undefined)
    assert.doesNotMatch(JSON.stringify(error), /synthetic-private|secret|formData/)
    return true
  })
}

async function rejectsReadback(h, promise, code) {
  const messages = {
    INPUT: 'Invalid form readback input', DISABLED: 'Form readback disabled',
    ABORTED: 'Form readback cancelled', RESPONSE: 'Invalid form readback response',
    TOO_LARGE: 'Form readback exceeds limit', UNAVAILABLE: 'Form readback unavailable',
  }
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof h.YidaFormReadbackError)
    assert.equal(error.code, `YIDA_READBACK_${code}`)
    assert.equal(error.message, messages[code])
    assert.equal(error.cause, undefined)
    assert.deepEqual(Object.keys(error).sort(), ['code', 'name'])
    assert.doesNotMatch(JSON.stringify(error), /synthetic-private|secret|formData|api\.dingtalk/)
    return true
  })
}

const readInput = () => ({ appType: 'synthetic_app', instanceId: INSTANCE,
  accessToken: 'synthetic-private-access', systemToken: ' synthetic-private-system &?#+ ', userId: ' synthetic-private-user + ' })

function wire(formData, patch = {}) {
  return JSON.stringify({ formInstId: INSTANCE, formData, modifiedTimeGMT: '2026-09-30T00:00:00Z', originator: 'synthetic-private-originator', ...patch })
}

async function fetchObservation(h, body, options = {}) {
  const calls = []
  const controller = new AbortController()
  const transport = h.createYidaFormReadback({ readEnablement: () => 'true', fetch: async (...args) => {
    calls.push(args)
    return new Response(body, options)
  } })
  const observation = await transport.read(readInput(), { signal: controller.signal })
  assert.equal(calls.length, 1)
  return { observation, calls }
}

for (const variant of ['primary', 'renamed']) {
  test(`full ${variant} planner/readback/native stream/comparison chain is a values-free observation only`, async () => {
    const h = await fixture(variant)
    const plan = h.plan()
    assert.equal(plan.canApply, false)
    assert.equal(plan.rows[0].remoteState, 'unverified')
    const bytes = new TextEncoder().encode(wire({ ...plan.rows[0].payload, unused: { nested: [true, null, 3] } }))
    // Deliberately split the UTF-8 bytes inside a non-ASCII field value; streaming
    // must preserve real bytes, not decode each arbitrary chunk independently.
    const stream = new ReadableStream({ start(controller) {
      for (let index = 0; index < bytes.length; index += 7) controller.enqueue(bytes.slice(index, index + 7))
      controller.close()
    } })
    const { observation, calls } = await fetchObservation(h, stream)
    assert.deepEqual(Object.keys(observation).sort(), ['formData', 'instanceId', 'statusCode'])
    assert.ok(Object.isFrozen(observation))
    assert.ok(Object.isFrozen(observation.formData))
    assert.ok(Object.isFrozen(observation.formData.unused.nested))
    assert.equal(observation.originator, undefined)
    assert.equal(observation.modifiedTimeGMT, undefined)
    assert.equal(observation.formUuid, undefined)
    const [address, options] = calls[0]
    const url = new URL(address)
    assert.equal(url.origin, 'https://api.dingtalk.com')
    assert.equal(url.pathname, `/v1.0/yida/forms/instances/${INSTANCE}`)
    assert.deepEqual([...url.searchParams.keys()].sort(), ['appType', 'systemToken', 'userId'])
    for (const key of ['appType', 'systemToken', 'userId']) assert.equal(url.searchParams.get(key), readInput()[key])
    assert.equal(options.method, 'GET')
    assert.equal(options.body, undefined)
    assert.equal(options.redirect, 'error')
    const headers = new Headers(options.headers)
    assert.equal(headers.get('x-acs-dingtalk-access-token'), readInput().accessToken)
    assert.equal(headers.get('Accept'), 'application/json')
    fullMatch(h.compare({ observation }))
  })
}

test('comparison is pure and neither invokes global fetch nor logs values', async () => {
  const h = await fixture()
  const globalFetch = globalThis.fetch
  const original = Object.fromEntries(['log', 'warn', 'error', 'info'].map((key) => [key, console[key]]))
  let calls = 0
  try {
    globalThis.fetch = () => { calls++; throw new Error('synthetic-private-unexpected-network') }
    for (const key of Object.keys(original)) console[key] = () => { calls++ }
    fullMatch(h.compare())
  } finally {
    globalThis.fetch = globalFetch
    for (const [key, method] of Object.entries(original)) console[key] = method
  }
  assert.equal(calls, 0)
})

for (let keyCount = 1; keyCount <= 8; keyCount++) {
  test(`${keyCount} mapped business keys are supported without hardcoding the seven-key example`, async () => {
    const h = await fixture()
    h.config.businessKey = h.config.fieldMap.slice(0, keyCount).map((entry) => entry.source)
    h.config.emptyKeyFields = h.config.businessKey.includes('parentCode') ? ['parentCode'] : []
    const expectedCount = keyCount >= 7 ? 9 : 8
    const { observation } = await fetchObservation(h, wire(h.plan().rows[0].payload))
    fullMatch(h.compare({ observation }), expectedCount)
    const wrong = copy(observation)
    wrong.formData.project = 'different-project'
    assertResult(h.compare({ observation: wrong }), { status: 'observed_mismatch', comparedFieldCount: expectedCount,
      matchedFieldCount: expectedCount - 1, mismatchedFieldCount: 1, missingFieldCount: 0,
      businessKeyMismatchCount: 1, reasonCodes: ['FIELD_MISMATCH'] })
  })
}

for (const sourceBlank of ['absent', null, '']) {
  for (const remoteBlank of ['absent', null, '']) {
    test(`declared empty parent normalizes local ${String(sourceBlank)} and remote ${String(remoteBlank)} only`, async () => {
      const h = await fixture()
      if (sourceBlank === 'absent') delete h.row.parentCode
      else h.row.parentCode = sourceBlank
      const remote = copy(h.plan().rows[0].payload)
      if (remoteBlank !== 'absent') remote.parentCode = remoteBlank
      const { observation } = await fetchObservation(h, wire(remote))
      fullMatch(h.compare({ observation }))
    })
  }
}

test('whitespace is neither an empty parent nor a matching normalized identity', async () => {
  const h = await fixture()
  const observation = h.observation(); observation.formData.parentCode = ' '
  assertResult(h.compare({ observation }), { status: 'observed_mismatch', matchedFieldCount: 8,
    mismatchedFieldCount: 1, missingFieldCount: 0, businessKeyMismatchCount: 1, reasonCodes: ['FIELD_MISMATCH'] })
  h.row.parentCode = ' '
  throwsObservation(h, () => h.compare({ observation: null }), 'PLAN')
})

test('empty equivalence is unavailable to undeclared keys or nonempty declared keys', async () => {
  const h = await fixture()
  h.config.emptyKeyFields = []
  throwsObservation(h, () => h.compare({ observation: null }), 'PLAN')
  h.config.emptyKeyFields = ['parentCode']; h.row.parentCode = 'synthetic-parent'
  for (const remote of [null, '']) {
    const observation = h.observation(); observation.formData.parentCode = remote
    assertResult(h.compare({ observation }), { mismatchedFieldCount: 1, missingFieldCount: 0, businessKeyMismatchCount: 1 })
  }
  const absent = h.observation(); delete absent.formData.parentCode
  assertResult(h.compare({ observation: absent }), { mismatchedFieldCount: 0, missingFieldCount: 1, businessKeyMismatchCount: 1 })
})

test('missing and mismatched fields count separately; key failures are an exact subset', async () => {
  const h = await fixture()
  const observation = h.observation()
  delete observation.formData.project
  delete observation.formData.priority
  observation.formData.componentCode = 'synthetic-private-wrong-code'
  observation.formData.qty = '0'
  assertResult(h.compare({ observation }), { status: 'observed_mismatch', comparedFieldCount: 9,
    matchedFieldCount: 5, mismatchedFieldCount: 2, missingFieldCount: 2, businessKeyMismatchCount: 2,
    reasonCodes: ['FIELD_MISMATCH', 'FIELD_MISSING'] })
})

for (const value of ['0', null, false, [0], { value: 0 }, 1]) {
  test(`numeric payload is not coerced from ${JSON.stringify(value)}`, async () => {
    const h = await fixture()
    const observation = h.observation(); observation.formData.qty = value
    assertResult(h.compare({ observation }), { status: 'observed_mismatch', comparedFieldCount: 9,
      matchedFieldCount: 8, mismatchedFieldCount: 1, missingFieldCount: 0, businessKeyMismatchCount: 0,
      reasonCodes: ['FIELD_MISMATCH'] })
  })
}

test('string comparison does not trim either compared value', async () => {
  const h = await fixture()
  const observation = h.observation(); observation.formData.project += ' '
  assertResult(h.compare({ observation }), { status: 'observed_mismatch', businessKeyMismatchCount: 1,
    mismatchedFieldCount: 1, missingFieldCount: 0 })
})

test('update omission does not demand clearing remote nonkey fields', async () => {
  const h = await fixture()
  h.config.intent = 'update'; h.config.instanceIdField = 'instance'
  h.row.instance = INSTANCE
  delete h.row.priority
  const observation = h.observation()
  observation.formData.priority = { old: ['remote-existing-value'] }
  fullMatch(h.compare({ observation }), 8)
  h.row.priority = 'rush'
  assertResult(h.compare({ observation }), { status: 'observed_mismatch', comparedFieldCount: 9,
    matchedFieldCount: 8, mismatchedFieldCount: 1, businessKeyMismatchCount: 0 })
})

test('update expected instance is separately admitted, not silently borrowed from the source row', async () => {
  const h = await fixture()
  h.config.intent = 'update'; h.config.instanceIdField = 'instance'; h.row.instance = INSTANCE
  fullMatch(h.compare())
  throwsObservation(h, () => h.compare({ expectedInstanceId: 'synthetic_other_instance' }), 'PLAN')
  inconclusive(h.compare({ expectedInstanceId: null }), 'INSTANCE_UNRESOLVED')
})

test('unknown instance, absent observation, and mismatched instance remain inconclusive with zero counts', async () => {
  const h = await fixture()
  inconclusive(h.compare({ expectedInstanceId: null, observation: null }), 'INSTANCE_UNRESOLVED')
  inconclusive(h.compare({ expectedInstanceId: null }), 'INSTANCE_UNRESOLVED')
  inconclusive(h.compare({ observation: null }), 'NO_OBSERVATION')
  const observation = h.observation({}, { instanceId: 'synthetic_other_instance' })
  inconclusive(h.compare({ observation }), 'INSTANCE_MISMATCH')
})

test('changing formUuid or current config cannot be distinguished from this response and never proves history/ownership', async () => {
  const h = await fixture()
  const { observation } = await fetchObservation(h, wire(h.plan().rows[0].payload))
  fullMatch(h.compare({ observation }))
  h.config.target.formUuid = 'synthetic_other_form'
  const result = h.compare({ observation })
  fullMatch(result)
  assert.equal(result.formOwnershipVerified, false)
  assert.equal(result.historyVerified, false)
  assert.equal(result.businessVerified, false)
  assert.equal(result.canRetry, false)
  // A remote field with this name is merely unrelated form data, not SDK echo.
  const withPretendIdentity = copy(observation)
  withPretendIdentity.formData.formUuid = 'different-remote-form'
  fullMatch(h.compare({ observation: withPretendIdentity }))
})

test('strict observation input rejects extra claims, invalid status/instance and nonobject form data', async () => {
  const h = await fixture()
  for (const observation of [
    { ...h.observation(), verified: true }, { ...h.observation(), formUuid: h.config.target.formUuid },
    ...[199, 300, 404, '200', 200.5].map((statusCode) => h.observation({}, { statusCode })),
    ...['', '../other', 'a/b', 'a?b', 'a%2Fb', ' white ', 'é', 'a'.repeat(129)].map((instanceId) => h.observation({}, { instanceId })),
    ...[null, [], 'text'].map((formData) => h.observation(formData)),
  ]) throwsObservation(h, () => h.compare({ observation }), 'INPUT')
  throwsObservation(h, () => h.compare({ expectedInstanceId: undefined }), 'INPUT')
  throwsObservation(h, () => h.compareYidaReadback({ config: h.config, row: h.row, expectedInstanceId: INSTANCE, observation: h.observation(), approved: true }), 'INPUT')
})

test('strict preflight rejects Proxy/getters/negative zero/nonfinite/sparse/exotic data without invoking a getter', async () => {
  const h = await fixture()
  let touched = false
  const accessor = h.observation()
  Object.defineProperty(accessor.formData, 'qty', { enumerable: true, get() { touched = true; throw new Error('synthetic-private-getter') } })
  const sparse = h.observation(); sparse.formData.extra = Array(2)
  const prototype = h.observation(); prototype.formData.extra = Object.create({ inherited: true })
  for (const observation of [accessor, new Proxy(h.observation(), {}), sparse, prototype,
    h.observation({ qty: -0 }), h.observation({ qty: Infinity }), h.observation({ extra: new Date() }),
  ]) throwsObservation(h, () => h.compare({ observation }), 'INPUT')
  throwsObservation(h, () => h.compare({ row: { ...h.row, quantity: -0 } }), 'INPUT')
  assert.equal(touched, false)
})

test('depth, node and byte budgets reject oversized pure inputs before comparison', async () => {
  const h = await fixture()
  const deep = h.observation(); let node = deep.formData
  for (let index = 0; index < 15; index++) { node.extra = {}; node = node.extra }
  const many = h.observation(); many.formData.extra = Array.from({ length: 4097 }, () => null)
  const huge = h.observation(); huge.formData.extra = 'x'.repeat(270000)
  for (const observation of [deep, many, huge]) throwsObservation(h, () => h.compare({ observation }), 'INPUT')
})

test('v1, invalid v2 rows and unmapped identity are not accepted as plans', async () => {
  const h = await fixture()
  throwsObservation(h, () => h.compare({ config: { ...h.config, version: 1 } }), 'PLAN')
  throwsObservation(h, () => h.compare({ row: { ...h.row, quantity: '0' } }), 'PLAN')
  throwsObservation(h, () => h.compare({ config: { ...h.config, businessKey: ['notMapped'] } }), 'PLAN')
})

for (const lexeme of ['0.0e0', '1e0', '1.2300', '1e-3', '9007199254740991']) {
  test(`wire numeric spelling ${lexeme} preserves a legal equivalent number through comparison`, async () => {
    const h = await fixture(); h.row.quantity = Number(lexeme)
    const raw = wire(h.plan().rows[0].payload).replace(`"qty":${JSON.stringify(h.row.quantity)}`, `"qty":${lexeme}`)
    assert.ok(raw.includes(`"qty":${lexeme}`))
    const { observation } = await fetchObservation(h, raw)
    fullMatch(h.compare({ observation }))
  })
}

for (const lexeme of ['-0', '-0.0', '-0e2', '9007199254740992', '9007199254740993', '1.0000000000000001', '0.10000000000000001', '1e-324', '1e309']) {
  test(`wire numeric spelling ${lexeme} is refused before comparison can falsely match rounded data`, async () => {
    const h = await fixture()
    const raw = wire(h.plan().rows[0].payload).replace('"qty":0', `"qty":${lexeme}`)
    await rejectsReadback(h, fetchObservation(h, raw), 'RESPONSE')
  })
}

test('duplicate and escaped-equivalent JSON keys are rejected even in unmapped nested fields', async () => {
  const h = await fixture()
  const base = wire(h.plan().rows[0].payload)
  for (const raw of [
    base.replace('"qty":0', '"qty":0,"qty":0'),
    base.replace('"qty":0', '"qty":0,"\\u0071ty":0'),
    base.replace('"qty":0', '"qty":0,"unused":{"k":1,"\\u006b":1}'),
    base.replace('"formInstId":', `"formInstId":"${INSTANCE}","formInstId":`),
  ]) await rejectsReadback(h, fetchObservation(h, raw), 'RESPONSE')
})

test('known-ID GET errors never establish absence, retry safety or a first-result search fallback', async () => {
  const h = await fixture()
  for (const [body, options] of [
    ['', {}], ['{}', {}], [wire({}, { formInstId: 'synthetic_other_instance' }), {}],
    [wire({}), { status: 404 }], [wire({}), { status: 302, headers: { Location: 'https://invalid.example/synthetic-private' } }],
    [wire({}, { formUuid: 'synthetic-form' }), {}],
  ]) await rejectsReadback(h, fetchObservation(h, body, options), 'RESPONSE')
})

test('default-OFF and invalid path cannot invoke the synthetic fetch', async () => {
  const h = await fixture(); let calls = 0
  const fetch = async () => { calls++; return new Response(wire({})) }
  for (const enablement of [undefined, false, true, 'TRUE', ' true']) {
    const transport = h.createYidaFormReadback({ fetch, ...(enablement === undefined ? {} : { readEnablement: () => enablement }) })
    await rejectsReadback(h, transport.read(readInput(), { signal: new AbortController().signal }), 'DISABLED')
  }
  const active = h.createYidaFormReadback({ fetch, readEnablement: () => 'true' })
  for (const instanceId of ['../x', 'a/b', 'a?b', 'a#b', 'a%2Fb', 'é']) {
    await rejectsReadback(h, active.read({ ...readInput(), instanceId }, { signal: new AbortController().signal }), 'INPUT')
  }
  assert.equal(calls, 0)
})

test('cancellation of ignored fetch keeps read pending until actual dependency settlement then discards the reply', async () => {
  const h = await fixture(); const reached = deferred(); const release = deferred(); const controller = new AbortController()
  let calls = 0; let settled = false
  const transport = h.createYidaFormReadback({ readEnablement: () => 'true', fetch: async (_url, options) => {
    calls++; assert.equal(options.signal, controller.signal); reached.resolve(); await release.promise
    return new Response(wire(h.plan().rows[0].payload))
  } })
  const pending = transport.read(readInput(), { signal: controller.signal })
  const observed = pending.then((value) => ({ value }), (error) => ({ error })).finally(() => { settled = true })
  await reached.promise; controller.abort('synthetic-private-cancel')
  await flush(); assert.equal(settled, false)
  release.resolve()
  const outcome = await observed
  assert.ok(outcome.error)
  await rejectsReadback(h, Promise.reject(outcome.error), 'ABORTED')
  assert.equal(calls, 1)
})

test('actual byte budget and strict UTF-8 reject oversized or invalid streamed bodies', async () => {
  const h = await fixture()
  const tooLarge = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(128 * 1024 + 1)); controller.close() } })
  await rejectsReadback(h, fetchObservation(h, tooLarge), 'TOO_LARGE')
  const invalidUtf8 = new ReadableStream({ start(controller) { controller.enqueue(Uint8Array.from([0xc3, 0x28])); controller.close() } })
  await rejectsReadback(h, fetchObservation(h, invalidUtf8), 'RESPONSE')
})
