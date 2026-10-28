'use strict'

const assert = require('node:assert/strict')
const { test } = require('node:test')
const { ReadableStream } = require('node:stream/web')
const { createYidaFormReadback, YidaFormReadbackError } = require('../lib/yida-form-readback.cjs')

// All fetch functions, credentials and responses are synthetic. This suite
// performs zero external requests and imports no sender, ledger or environment.
const MAX_BYTES = 128 * 1024
const signal = () => new AbortController().signal
const input = (patch = {}) => ({
  appType: 'synthetic-app', instanceId: 'synthetic-instance', accessToken: 'synthetic-private-access',
  systemToken: 'synthetic-private-system', userId: 'synthetic-private-user', ...patch,
})
const payload = (formData = { text: 'synthetic', quantity: 0 }, patch = {}) => ({ formInstId: 'synthetic-instance', formData, ...patch })
const response = (body = payload(), options = {}) => new Response(JSON.stringify(body), options)
const reader = (fetch, patch = {}) => createYidaFormReadback({ fetch, readEnablement: () => 'true', ...patch })
const raw = (value) => `{"formInstId":"synthetic-instance","formData":{"number":${value}}}`
const nextTurn = () => new Promise((resolve) => setImmediate(resolve))
const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function code(kind) {
  return (error) => {
    assert.ok(error instanceof YidaFormReadbackError)
    assert.equal(error.code, `YIDA_READBACK_${kind}`)
    assert.equal(Object.hasOwn(error, 'cause'), false)
    assert.deepEqual(Object.keys(error).sort(), ['code', 'name'])
    assert.doesNotMatch(String(error.stack), /synthetic-private|synthetic-instance|api\.dingtalk\.com|formData/)
    return true
  }
}

function streamResponse(chunks, options = {}, onCancel = () => {}) {
  const counts = { reads: 0, cancels: 0 }
  let index = 0
  const body = new ReadableStream({
    pull(stream) { counts.reads += 1; if (index < chunks.length) stream.enqueue(chunks[index++]); else stream.close() },
    cancel() { counts.cancels += 1; return onCancel() },
  }, { highWaterMark: 0 })
  return { response: new Response(body, options), counts }
}

test('fixed GET path/query/header uses exact credential strings and no body or overrides', async () => {
  const controller = new AbortController()
  const request = input({ appType: '应用_🚀', systemToken: ' synthetic-private +&=?/# 雪 🚀\t ', userId: ' synthetic-private +&=?/# 用户🚀 ' })
  let calls = 0
  const readback = reader(async (url, options) => {
    calls += 1
    const actual = new URL(url)
    assert.equal(actual.origin, 'https://api.dingtalk.com')
    assert.equal(actual.pathname, '/v1.0/yida/forms/instances/synthetic-instance')
    assert.equal(actual.hash, '')
    assert.deepEqual([...actual.searchParams.keys()], ['appType', 'systemToken', 'userId'])
    for (const field of ['appType', 'systemToken', 'userId']) assert.equal(actual.searchParams.get(field), request[field])
    assert.equal(actual.searchParams.has('accessToken'), false)
    assert.deepEqual(Object.keys(options).sort(), ['headers', 'method', 'redirect', 'signal'])
    assert.equal(options.method, 'GET')
    assert.equal(options.redirect, 'error')
    assert.equal(options.signal, controller.signal)
    assert.deepEqual(options.headers, { Accept: 'application/json', 'x-acs-dingtalk-access-token': request.accessToken })
    return response(payload())
  })
  assert.deepEqual(await readback.read(request, { signal: controller.signal }), { statusCode: 200, instanceId: request.instanceId, formData: payload().formData })
  assert.equal(calls, 1)
  assert.deepEqual(Object.keys(readback), ['read'])
  assert.equal(Object.isFrozen(readback), true)
})

test('query refuses unpaired UTF16 surrogates rather than silently replacing credential bytes', async () => {
  let calls = 0
  const readback = reader(async () => { calls += 1; return response() })
  for (const field of ['appType', 'systemToken', 'userId']) {
    for (const value of ['x\ud800', 'x\udfff', '\ud800x', '\udc00\ud800', '\ud800\ud800']) {
      await assert.rejects(readback.read(input({ [field]: value }), { signal: signal() }), code('INPUT'))
    }
  }
  assert.equal(calls, 0)
})

test('default OFF and non-literal or async enablement have zero fetches and no leaked rejection', async () => {
  let calls = 0
  let touched = 0
  const fetch = async () => { calls += 1; return response() }
  await assert.rejects(createYidaFormReadback({ fetch }).read(input(), { signal: signal() }), code('DISABLED'))
  const thenable = { get then() { touched += 1; throw new Error('synthetic-private') } }
  for (const value of [undefined, null, false, true, 1, 'TRUE', ' true', 'true ', {}, thenable, Promise.resolve('true'), Promise.reject(new Error('synthetic-private-enablement'))]) {
    await assert.rejects(reader(fetch, { readEnablement: () => value }).read(input(), { signal: signal() }), code('DISABLED'))
  }
  await assert.rejects(reader(fetch, { readEnablement() { throw new Error('synthetic-private') } }).read(input(), { signal: signal() }), code('DISABLED'))
  await nextTurn()
  assert.equal(calls + touched, 0)
})

test('enablement is re-read per call and is not latched after a successful observation', async () => {
  let enabled = 'true'
  let calls = 0
  const readback = reader(async () => { calls += 1; return response() }, { readEnablement: () => enabled })
  await readback.read(input(), { signal: signal() })
  enabled = 'false'
  await assert.rejects(readback.read(input(), { signal: signal() }), code('DISABLED'))
  assert.equal(calls, 1)
})

test('malformed or subclass enablement Promises refuse without constructor/species inspection', async () => {
  let touched = 0
  let calls = 0
  const fulfilled = Promise.resolve('true')
  const rejected = Promise.reject(new Error('synthetic-private-pre-rejected'))
  // Handling a malicious pre-rejected dependency is its owner's responsibility.
  // Install that handler before making its constructor unsafe to inspect.
  rejected.catch(() => {})
  for (const value of [fulfilled, rejected]) Object.defineProperty(value, 'constructor', {
    get() { touched += 1; throw new Error('synthetic-private-constructor') },
  })
  class PromiseSubclass extends Promise {
    static get [Symbol.species]() { touched += 1; throw new Error('synthetic-private-species') }
  }
  const subclass = new PromiseSubclass((resolve) => resolve('true'))
  const proxy = new Proxy(Promise.resolve('true'), {
    getPrototypeOf() { touched += 1; throw new Error('synthetic-private-prototype') },
    get() { touched += 1; throw new Error('synthetic-private-property') },
  })
  for (const value of [fulfilled, rejected, subclass, proxy]) {
    await assert.rejects(reader(async () => { calls += 1; return response() }, {
      readEnablement: () => value,
    }).read(input(), { signal: signal() }), code('DISABLED'))
  }
  await nextTurn()
  assert.equal(touched + calls, 0)
})

test('factory requires explicit own-data fetch; getters, proxies, extras and implicit fallback reject', () => {
  let touched = 0
  const getter = Object.defineProperty({}, 'fetch', { enumerable: true, get() { touched += 1; throw new Error('synthetic-private') } })
  const proxy = new Proxy({ fetch() {} }, { getPrototypeOf() { touched += 1; throw new Error('synthetic-private') } })
  for (const value of [undefined, null, {}, [], { fetch: null }, { fetch() {}, readEnablement: false },
    { fetch() {}, url: 'synthetic-private' }, { fetch() {}, [Symbol('extra')]: 1 }, Object.create({ fetch() {} }), getter, proxy]) {
    assert.throws(() => createYidaFormReadback(value), code('INPUT'))
  }
  assert.equal(touched, 0)
})

test('request/options are closed own-data records checked before enablement or fetch', async () => {
  let enabled = 0
  let fetched = 0
  let touched = 0
  const readback = reader(async () => { fetched += 1; return response() }, { readEnablement: () => { enabled += 1; return 'true' } })
  const getter = input()
  Object.defineProperty(getter, 'systemToken', { get() { touched += 1; throw new Error('synthetic-private') } })
  const proxy = new Proxy(input(), { ownKeys() { touched += 1; throw new Error('synthetic-private') } })
  const hidden = input(); Object.defineProperty(hidden, 'appType', { enumerable: false })
  const invalid = [undefined, null, [], {}, getter, proxy, hidden, Object.assign(Object.create({ inherited: true }), input()),
    ...['url', 'headers', 'path', 'body', 'formUuid', 'language', 'approved'].map((field) => input({ [field]: 'synthetic-private' })),
    input({ [Symbol('extra')]: true })]
  for (const value of invalid) await assert.rejects(readback.read(value, { signal: signal() }), code('INPUT'))
  for (const field of Object.keys(input())) {
    const value = input(); delete value[field]
    await assert.rejects(readback.read(value, { signal: signal() }), code('INPUT'))
  }
  const signalGetter = Object.defineProperty({}, 'signal', { enumerable: true, get() { touched += 1; throw new Error('synthetic-private') } })
  for (const options of [undefined, {}, [], { signal: signal(), timeout: 1 }, Object.create({ signal: signal() }), signalGetter]) {
    await assert.rejects(readback.read(input(), options), code('INPUT'))
  }
  assert.equal(enabled + fetched + touched, 0)
})

test('native direct AbortSignal is required, without proxy or inherited signal traps', async () => {
  let touched = 0
  let calls = 0
  const readback = reader(async () => { calls += 1; return response() })
  const fake = { get aborted() { touched += 1; throw new Error('synthetic-private') } }
  const proxy = new Proxy(signal(), { get() { touched += 1; throw new Error('synthetic-private') } })
  for (const value of [undefined, null, {}, fake, proxy, Object.create(signal()), Object.create(AbortSignal.prototype)]) {
    await assert.rejects(readback.read(input(), { signal: value }), code('INPUT'))
  }
  assert.equal(touched + calls, 0)
})

test('safe instance path and bounded identities/tokens reject encoding and traversal tricks', async () => {
  let calls = 0
  const readback = reader(async () => { calls += 1; return response() })
  for (const instanceId of ['', '.', '..', '../other', 'a/b', 'a\\b', 'a?x=1', 'a#x', 'a%2Fb', 'a b', '雪', 'a'.repeat(129), 1]) {
    await assert.rejects(readback.read(input({ instanceId }), { signal: signal() }), code('INPUT'))
  }
  for (const [field, maximum] of [['appType', 128], ['accessToken', 8192], ['systemToken', 4096], ['userId', 128]]) {
    for (const value of ['', ' \t', null, undefined, {}, 7, 'x'.repeat(maximum + 1)]) {
      await assert.rejects(readback.read(input({ [field]: value }), { signal: signal() }), code('INPUT'))
    }
  }
  for (const field of ['appType', 'accessToken']) {
    for (const value of [' x', 'x ', 'x\n', 'x\u0000', 'x\u007f', 'x\u0085']) {
      await assert.rejects(readback.read(input({ [field]: value }), { signal: signal() }), code('INPUT'))
    }
  }
  assert.equal(calls, 0)
  const maximums = input({ appType: 'a'.repeat(128), accessToken: 'a'.repeat(8192), systemToken: 's'.repeat(4096), userId: 'u'.repeat(128), instanceId: 'I'.repeat(128) })
  await reader(async () => response(payload({}, { formInstId: maximums.instanceId }))).read(maximums, { signal: signal() })
})

test('owned nested standard JSON is deeply frozen; metadata and nonexistent form ownership are not returned', async () => {
  const body = payload({ text: 'synthetic', other: [null, false, { values: [1, 2.5] }], empty: {} }, { modifiedTimeGMT: 1700000000000, originator: 'synthetic-private-originator' })
  const result = await reader(async () => response(body)).read(input(), { signal: signal() })
  assert.deepEqual(Object.keys(result).sort(), ['formData', 'instanceId', 'statusCode'])
  assert.deepEqual(result.formData, body.formData)
  assert.notEqual(result.formData, body.formData)
  assert.equal(Object.getPrototypeOf(result.formData), Object.prototype)
  for (const value of [result, result.formData, result.formData.other, result.formData.other[2], result.formData.other[2].values, result.formData.empty]) assert.equal(Object.isFrozen(value), true)
  assert.throws(() => { result.formData.text = 'changed' }, TypeError)
  assert.throws(() => result.formData.other.push('changed'), TypeError)
  for (const field of ['appType', 'formUuid', 'modifiedTimeGMT', 'originator', 'businessVerified', 'historyVerified', 'formOwnershipVerified']) assert.equal(Object.hasOwn(result, field), false)
  assert.doesNotMatch(JSON.stringify(result), /synthetic-private/)
})

test('nested special JSON keys are own data, not prototype pollution or missing duplicate checks', async () => {
  const body = '{"formInstId":"synthetic-instance","formData":{"__proto__":{"polluted":true},"constructor":null,"prototype":[1]}}'
  const result = await reader(async () => new Response(body)).read(input(), { signal: signal() })
  assert.equal(Object.getPrototypeOf(result.formData), Object.prototype)
  assert.equal(Object.hasOwn(result.formData, '__proto__'), true)
  assert.deepEqual(result.formData.__proto__, { polluted: true })
  assert.equal({}.polluted, undefined)
})

for (const status of [200, 201, 206, 299]) {
  test(`HTTP ${status} with exact instance and bounded formData yields only an observation`, async () => {
    const result = await reader(async () => response(payload(), { status })).read(input(), { signal: signal() })
    assert.deepEqual(result, { statusCode: status, instanceId: 'synthetic-instance', formData: payload().formData })
  })
}

test('empty, wrong-shaped, unknown-field and mismatched-instance envelopes fail closed', async () => {
  for (const body of [null, [], {}, true, 'text', { body: payload() }, { result: payload() },
    payload({}, { success: true }), payload({}, { appType: 'synthetic-app' }), payload({}, { formUuid: 'synthetic-form' }),
    { formData: {} }, { formInstId: 'synthetic-instance' }, payload({}, { formInstId: 'other-instance' }),
    payload({}, { formInstId: null }), payload(null), payload([]), payload('{}'), payload(1)]) {
    await assert.rejects(reader(async () => response(body)).read(input(), { signal: signal() }), code('RESPONSE'))
  }
  for (const value of [new Response(''), new Response(null), new Response(null, { status: 204 })]) {
    await assert.rejects(reader(async () => value).read(input(), { signal: signal() }), code('RESPONSE'))
  }
})

test('duplicate keys including escaped equivalents reject at every level, even when values match', async () => {
  const bodies = [
    '{"formInstId":"synthetic-instance","formInstId":"synthetic-instance","formData":{}}',
    '{"formInstId":"synthetic-instance","form\\u0049nstId":"synthetic-instance","formData":{}}',
    '{"formInstId":"synthetic-instance","formData":{"a":1,"a":1}}',
    '{"formInstId":"synthetic-instance","formData":{"a":1,"\\u0061":1}}',
    '{"formInstId":"synthetic-instance","formData":{"unmapped":[{"x":1,"x":2}]}}',
    '{"formInstId":"synthetic-instance","formData":{},"originator":{"x":1,"\\u0078":2}}',
  ]
  for (const body of bodies) await assert.rejects(reader(async () => new Response(body)).read(input(), { signal: signal() }), code('RESPONSE'))
})

test('raw numeric lexemes cannot round, underflow, become negative zero or exceed safe integers', async () => {
  const invalid = ['9007199254740993', '9007199254740992', '-9007199254740992', '9007199254740991.1',
    '0.10000000000000001', '1.234567890123456789', '1.0000000000000001', '1e309', '1e-400', '-1e-400',
    '-0', '-0.0', '-0e100', '-0e-100', '1e999999999999999999999', '1e-999999999999999999999']
  for (const number of invalid) {
    await assert.rejects(reader(async () => new Response(raw(number))).read(input(), { signal: signal() }), code('RESPONSE'))
  }
  // Unknown nested controls and stripped metadata are still subject to numeric
  // validation; they cannot hide a lossy number outside the compared fields.
  for (const body of ['{"formInstId":"synthetic-instance","formData":{"unmapped":[{"x":1e-400}]}}',
    '{"formInstId":"synthetic-instance","formData":{},"modifiedTimeGMT":9007199254740993}']) {
    await assert.rejects(reader(async () => new Response(body)).read(input(), { signal: signal() }), code('RESPONSE'))
  }
})

test('equivalent valid decimal/exponent spellings preserve numbers rather than imposing a spelling', async () => {
  for (const number of ['0', '0.00', '0e999999999999999999999', '1', '1.00', '1e+0', '1E000000001',
    '1000e-3', '0.0100', '0.1', '-1.25', '1e-20', '1e-300', '5e-324', '2.2250738585072014e-308',
    '9007199254740991', '-9007199254740991']) {
    const result = await reader(async () => new Response(raw(number))).read(input(), { signal: signal() })
    assert.equal(result.formData.number, Number(number))
  }
  const longEquivalent = '0.' + '0'.repeat(10000) + '1e10001'
  assert.equal((await reader(async () => new Response(raw(longEquivalent))).read(input(), { signal: signal() })).formData.number, 1)
})

test('JSON grammar is strict without eval, non-JSON whitespace or trailing content', async () => {
  for (const number of ['+1', '.1', '01', '-01', '1.', '1e', '1e+', 'NaN', 'Infinity', 'undefined', '0x10', '1_000']) {
    await assert.rejects(reader(async () => new Response(raw(number))).read(input(), { signal: signal() }), code('RESPONSE'))
  }
  for (const body of [JSON.stringify(payload()) + ' trailing', JSON.stringify(payload()) + '{}', '\u00a0' + JSON.stringify(payload()),
    '{"formInstId":"synthetic-instance","formData":{"x":1,}}', '{"formInstId":"synthetic-instance","formData":{"x":[1,]}}',
    '{"formInstId":"synthetic-instance","formData":{"x":"\\q"}}', '{"formInstId":"synthetic-instance","formData":{"x":"\\u12G4"}}',
    '{"formInstId":"synthetic-instance","formData":{"x":"unclosed}}', '{"formInstId":"synthetic-instance","formData":{"x":"raw\nline"}}']) {
    await assert.rejects(reader(async () => new Response(body)).read(input(), { signal: signal() }), code('RESPONSE'))
  }
  const body = ' \t\r\n' + JSON.stringify(payload({ text: 'quote" slash\\ line\n tab\t 雪🚀' })) + '\r\n'
  assert.equal((await reader(async () => new Response(body)).read(input(), { signal: signal() })).formData.text, 'quote" slash\\ line\n tab\t 雪🚀')
})

test('depth budget accepts depth twelve and refuses depth thirteen for unmapped nested values', async () => {
  for (const levels of [10, 11]) {
    let nested = 1
    for (let index = 0; index < levels; index += 1) nested = [nested]
    const promise = reader(async () => response(payload({ nested }))).read(input(), { signal: signal() })
    if (levels === 10) await promise
    else await assert.rejects(promise, code('TOO_LARGE'))
  }
})

test('each object/array permits 256 items and refuses 257', async () => {
  for (const length of [256, 257]) {
    for (const formData of [Object.fromEntries(Array.from({ length }, (_, index) => [`field_${index}`, index])), { nested: Array(length).fill(null) }]) {
      const promise = reader(async () => response(payload(formData))).read(input(), { signal: signal() })
      if (length === 256) await promise
      else await assert.rejects(promise, code('TOO_LARGE'))
    }
  }
})

test('node budget includes the root and all values, accepting 4096 and refusing 4097', async () => {
  for (const extra of [0, 1]) {
    const formData = Object.fromEntries(Array.from({ length: 16 }, (_, index) => [`field_${index}`, Array(index === 15 ? 237 + extra : 256).fill(null)]))
    const promise = reader(async () => response(payload(formData))).read(input(), { signal: signal() })
    if (extra) await assert.rejects(promise, code('TOO_LARGE'))
    else await promise
  }
})

test('decoded string and key budgets allow 8192 characters including escapes but reject 8193', async () => {
  for (const length of [8192, 8193]) {
    for (const body of [JSON.stringify(payload({ text: 'x'.repeat(length) })),
      JSON.stringify(payload({ ['k'.repeat(length)]: true })),
      '{"formInstId":"synthetic-instance","formData":{"text":"' + '\\u0078'.repeat(length) + '"}}']) {
      const promise = reader(async () => new Response(body)).read(input(), { signal: signal() })
      if (length === 8192) await promise
      else await assert.rejects(promise, code('TOO_LARGE'))
    }
  }
})

function exactLimitBody() {
  const formData = Object.fromEntries(Array.from({ length: 16 }, (_, index) => [`field_${index}`, index === 15 ? '' : 'x'.repeat(8192)]))
  const remaining = MAX_BYTES - Buffer.byteLength(JSON.stringify(payload(formData)))
  assert.ok(remaining <= 8192)
  formData.field_15 = 'x'.repeat(remaining)
  return JSON.stringify(payload(formData))
}

test('128KiB actual byte cap is inclusive and cannot be bypassed by a short declared length', async () => {
  const exact = exactLimitBody()
  assert.equal(Buffer.byteLength(exact), MAX_BYTES)
  for (const extra of [0, 1]) {
    const bytes = Buffer.from(exact + ' '.repeat(extra))
    const tracked = streamResponse([bytes.subarray(0, MAX_BYTES / 2), bytes.subarray(MAX_BYTES / 2)], { headers: { 'content-length': '1' } })
    const promise = reader(async () => tracked.response).read(input(), { signal: signal() })
    if (extra) { await assert.rejects(promise, code('TOO_LARGE')); assert.equal(tracked.counts.cancels, 1) }
    else assert.equal((await promise).instanceId, 'synthetic-instance')
    assert.equal(tracked.response.body.locked, false)
  }
})

test('read-count cap stops endless empty chunks without storing them; all-one-byte limit body still succeeds', async () => {
  let reads = 0
  let cancels = 0
  const body = new ReadableStream({ pull(stream) { reads += 1; stream.enqueue(new Uint8Array(0)) }, cancel() { cancels += 1 } }, { highWaterMark: 0 })
  await assert.rejects(reader(async () => new Response(body)).read(input(), { signal: signal() }), code('TOO_LARGE'))
  assert.equal(reads, MAX_BYTES + 1)
  assert.equal(cancels, 1)
  const bytes = Buffer.from(exactLimitBody())
  let position = 0
  const oneByte = new ReadableStream({ pull(stream) { if (position === bytes.length) stream.close(); else stream.enqueue(Uint8Array.of(bytes[position++])); } }, { highWaterMark: 0 })
  assert.equal((await reader(async () => new Response(oneByte)).read(input(), { signal: signal() })).instanceId, 'synthetic-instance')
  assert.equal(position, MAX_BYTES)
})

test('UTF8 sequences can cross chunk boundaries; malformed bytes and non-byte chunks are refused', async () => {
  const bytes = Buffer.from(JSON.stringify(payload({ text: '雪🚀' })))
  const valid = streamResponse(Array.from(bytes, (byte) => Uint8Array.of(byte)))
  assert.equal((await reader(async () => valid.response).read(input(), { signal: signal() })).formData.text, '雪🚀')
  const prefix = Buffer.from('{"formInstId":"synthetic-instance","formData":{"text":"')
  const suffix = Buffer.from('"}}')
  for (const chunks of [[Buffer.concat([prefix, Uint8Array.of(0xc3, 0x28), suffix])], ['not-bytes']]) {
    const tracked = streamResponse(chunks)
    await assert.rejects(reader(async () => tracked.response).read(input(), { signal: signal() }), code('RESPONSE'))
    assert.equal(tracked.response.body.locked, false)
  }
})

test('chunk copying does not evaluate shadowed length, constructor or iterator properties', async () => {
  let touched = 0
  const bytes = Buffer.from(JSON.stringify(payload()))
  for (const property of ['byteLength', 'constructor', Symbol.iterator]) Object.defineProperty(bytes, property, { get() { touched += 1; throw new Error('synthetic-private') } })
  const tracked = streamResponse([bytes])
  assert.deepEqual((await reader(async () => tracked.response).read(input(), { signal: signal() })).formData, payload().formData)
  assert.equal(touched, 0)
})

for (const status of [301, 302, 307, 308, 400, 401, 404, 429, 500]) {
  test(`HTTP ${status} refuses before body reading, with one fetch and detached cancellation`, async () => {
    const tracked = streamResponse([Buffer.from('synthetic-private-body')], { status }, () => new Promise(() => {}))
    let calls = 0
    await assert.rejects(reader(async () => { calls += 1; return tracked.response }).read(input(), { signal: signal() }), code('RESPONSE'))
    assert.equal(calls, 1)
    assert.equal(tracked.counts.reads, 0)
    assert.equal(tracked.counts.cancels, 1)
    // In particular, 404 is not an observation or proof that no write occurred.
  })
}

test('redirected2xx and unsafe Response values/proxies/accessors are refused without reading unknown getters', async () => {
  let touched = 0
  const tracked = streamResponse([Buffer.from(JSON.stringify(payload()))])
  Object.defineProperty(tracked.response, 'redirected', { value: true })
  await assert.rejects(reader(async () => tracked.response).read(input(), { signal: signal() }), code('RESPONSE'))
  assert.equal(tracked.counts.reads, 0)
  assert.equal(tracked.counts.cancels, 1)
  const fake = { get status() { touched += 1; throw new Error('synthetic-private') } }
  const proxy = new Proxy(response(), { get() { touched += 1; throw new Error('synthetic-private') } })
  for (const value of [undefined, null, {}, fake, proxy, Object.create(response()), Object.create(Response.prototype)]) {
    await assert.rejects(reader(() => value).read(input(), { signal: signal() }), code('RESPONSE'))
  }
  for (const property of ['status', 'headers', 'body', 'redirected']) {
    const value = response()
    Object.defineProperty(value, property, { get() { touched += 1; throw new Error('synthetic-private') } })
    await assert.rejects(reader(async () => value).read(input(), { signal: signal() }), code('RESPONSE'))
  }
  assert.equal(touched, 0)
})

test('invalid/oversized Content-Length is refused before body read; all-digit leadingzeros are legal', async () => {
  for (const declared of ['', '-1', '+1', '1.5', '1,2', 'NaN', '131073', '9007199254740993']) {
    const tracked = streamResponse([Buffer.from(JSON.stringify(payload()))], { headers: { 'content-length': declared } })
    await assert.rejects(reader(async () => tracked.response).read(input(), { signal: signal() }), code(['131073', '9007199254740993'].includes(declared) ? 'TOO_LARGE' : 'RESPONSE'))
    assert.equal(tracked.counts.reads, 0)
    assert.equal(tracked.counts.cancels, 1)
  }
  const tracked = streamResponse([Buffer.from(JSON.stringify(payload()))], { headers: { 'content-length': '000131072' } })
  await reader(async () => tracked.response).read(input(), { signal: signal() })
})

test('already aborted input never invokes enablement/fetch or signal.reason', async () => {
  const controller = new AbortController()
  let touched = 0
  let calls = 0
  Object.defineProperty(controller.signal, 'reason', { get() { touched += 1; throw new Error('synthetic-private') } })
  controller.abort('synthetic-private-reason')
  const readback = reader(async () => { calls += 1; return response() }, { readEnablement() { calls += 1; return 'true' } })
  await assert.rejects(readback.read(input(), { signal: controller.signal }), code('ABORTED'))
  assert.equal(touched + calls, 0)
})

test('abort during enablement is checked before dispatching fetch', async () => {
  const controller = new AbortController()
  let calls = 0
  const readback = reader(async () => { calls += 1; return response() }, { readEnablement() { controller.abort('synthetic-private'); return 'true' } })
  await assert.rejects(readback.read(input(), { signal: controller.signal }), code('ABORTED'))
  assert.equal(calls, 0)
})

test('uncooperative aborted fetch remains pending until settlement then discards/cancels late body', async () => {
  const gate = deferred()
  const controller = new AbortController()
  let calls = 0
  let settled = false
  const promise = reader((_url, options) => { calls += 1; assert.equal(options.signal, controller.signal); return gate.promise }).read(input(), { signal: controller.signal })
  promise.then(() => { settled = true }, () => { settled = true })
  controller.abort('synthetic-private')
  await nextTurn()
  assert.equal(settled, false)
  const tracked = streamResponse([Buffer.from(JSON.stringify(payload()))])
  gate.resolve(tracked.response)
  await assert.rejects(promise, code('ABORTED'))
  assert.equal(calls, 1)
  assert.equal(tracked.counts.reads, 0)
  assert.equal(tracked.counts.cancels, 1)
})

test('aborted fetch rejection remains values-free and does not retry or refresh a token', async () => {
  const gate = deferred()
  const controller = new AbortController()
  let calls = 0
  const promise = reader(() => { calls += 1; return gate.promise }).read(input(), { signal: controller.signal })
  controller.abort('synthetic-private-reason')
  gate.reject(new Error('synthetic-private-fetch'))
  await assert.rejects(promise, code('ABORTED'))
  assert.equal(calls, 1)
})

test('abort of stalled body cancels reader without awaiting cleanup and releases its lock', async () => {
  const entered = deferred()
  const controller = new AbortController()
  let cancels = 0
  const body = new ReadableStream({
    pull() { entered.resolve(); return new Promise(() => {}) },
    cancel() { cancels += 1; return Promise.reject(new Error('synthetic-private-cancel')) },
  }, { highWaterMark: 0 })
  const promise = reader(async () => new Response(body)).read(input(), { signal: controller.signal })
  await entered.promise
  controller.abort('synthetic-private')
  await assert.rejects(promise, code('ABORTED'))
  await nextTurn()
  assert.equal(cancels, 1)
  assert.equal(body.locked, false)
})

test('abort immediately after a chunk cannot publish a late observation', async () => {
  const controller = new AbortController()
  const body = new ReadableStream({ pull(stream) { stream.enqueue(Buffer.from(JSON.stringify(payload()))); controller.abort('synthetic-private') } }, { highWaterMark: 0 })
  await assert.rejects(reader(async () => new Response(body)).read(input(), { signal: controller.signal }), code('ABORTED'))
})

test('arbitrary upstream errors cannot expose URL, query credentials, bodies or getters and do not log', async () => {
  let touched = 0
  let logged = 0
  const saved = Object.fromEntries(['log', 'warn', 'error', 'info', 'debug'].map((method) => [method, console[method]]))
  const unsafe = { get code() { touched += 1; throw new Error('synthetic-private') }, get message() { touched += 1; throw new Error('synthetic-private') } }
  const decorated = new YidaFormReadbackError('RESPONSE')
  decorated.message = 'synthetic-private-query'
  decorated.cause = 'synthetic-private-body'
  try {
    for (const method of Object.keys(saved)) console[method] = () => { logged += 1 }
    for (const error of [undefined, null, 'synthetic-private', new Error('synthetic-private-query'), unsafe, decorated]) {
      let calls = 0
      await assert.rejects(reader(async () => { calls += 1; throw error }).read(input(), { signal: signal() }), code(error === decorated ? 'RESPONSE' : 'UNAVAILABLE'))
      assert.equal(calls, 1)
    }
    const body = new ReadableStream({ pull(stream) { stream.error(new Error('synthetic-private-body')) } }, { highWaterMark: 0 })
    await assert.rejects(reader(async () => new Response(body)).read(input(), { signal: signal() }), code('UNAVAILABLE'))
    assert.equal(new YidaFormReadbackError({ toString() { touched += 1; throw new Error('synthetic-private') } }).code, 'YIDA_READBACK_UNAVAILABLE')
  } finally {
    Object.assign(console, saved)
  }
  assert.equal(touched + logged, 0)
})
