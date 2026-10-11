'use strict'

const assert = require('node:assert/strict')
const { test } = require('node:test')
const { ReadableStream } = require('node:stream/web')
const {
  createDingTalkAppTokenExchange,
  YidaTokenExchangeError,
} = require('../lib/yida-token-exchange.cjs')

// Every transport and credential in this suite is synthetic. No listener, live
// authentication request, environment loader or customer credential is used.
const credentials = () => ({ appKey: 'synthetic-app-key', appSecret: 'synthetic-app-secret' })
const signal = () => new AbortController().signal
const validBody = () => ({ accessToken: 'synthetic-access-token', expireIn: 7200 })
const response = (body = validBody(), init = {}) => new Response(JSON.stringify(body), init)
const makeExchange = (fetch) => createDingTalkAppTokenExchange({ fetch })
const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((accept, refuse) => { resolve = accept; reject = refuse })
  return { promise, resolve, reject }
}
const nextTurn = () => new Promise((resolve) => setImmediate(resolve))

function code(kind) {
  return (error) => {
    assert.ok(error instanceof YidaTokenExchangeError)
    assert.equal(error.code, `YIDA_TOKEN_EXCHANGE_${kind}`)
    assert.equal(Object.hasOwn(error, 'cause'), false)
    assert.deepEqual(Object.keys(error).sort(), ['code', 'name'])
    assert.doesNotMatch(String(error.stack), /synthetic-private|synthetic-app-secret|synthetic-access-token|api\.dingtalk\.com/)
    return true
  }
}

function streamResponse(chunks, init = {}, cancel = () => {}) {
  const counters = { reads: 0, cancellations: 0 }
  let index = 0
  const body = new ReadableStream({
    pull(controller) {
      counters.reads += 1
      if (index === chunks.length) controller.close()
      else controller.enqueue(chunks[index++])
    },
    cancel() { counters.cancellations += 1; return cancel() },
  }, { highWaterMark: 0 })
  return { response: new Response(body, init), counters }
}

test('fixed endpoint and exact JSON credentials preserve bytes; unknown response fields are stripped', async () => {
  const control = new AbortController()
  const input = { appKey: '  synthetic-key\t', appSecret: ' synthetic-secret\nwith-雪 " \\ ' }
  let calls = 0
  const exchange = makeExchange(async (url, options) => {
    calls += 1
    assert.equal(url, 'https://api.dingtalk.com/v1.0/oauth2/accessToken')
    assert.deepEqual(Object.keys(options).sort(), ['body', 'headers', 'method', 'redirect', 'signal'])
    assert.equal(options.method, 'POST')
    assert.equal(options.redirect, 'error')
    assert.deepEqual(options.headers, { 'Content-Type': 'application/json' })
    assert.equal(options.signal, control.signal)
    assert.equal(options.body, JSON.stringify(input))
    assert.deepEqual(JSON.parse(options.body), input)
    return response({ ...validBody(), rawPrivate: 'synthetic-private-upstream' })
  })
  assert.deepEqual(await exchange(input, { signal: control.signal }), validBody())
  assert.equal(calls, 1)
})

test('factory requires one explicit own-data fetch dependency and has no global fallback', () => {
  let accessed = 0
  const accessor = Object.defineProperty({}, 'fetch', { enumerable: true, get() { accessed += 1; return () => response() } })
  for (const input of [undefined, null, {}, [], { fetch: null }, { fetch() {}, url: 'synthetic-private' },
    Object.create({ fetch() {} }), accessor, { fetch() {}, [Symbol('extra')]: true }]) {
    assert.throws(() => createDingTalkAppTokenExchange(input), code('INPUT'))
  }
  assert.equal(accessed, 0)
})

test('credential and signal options are closed own-data records, without evaluating getters', async () => {
  let fetches = 0
  let accessed = 0
  const exchange = makeExchange(async () => { fetches += 1; return response() })
  const getter = Object.defineProperty(credentials(), 'appSecret', { get() { accessed += 1; throw new Error('synthetic-private') } })
  const invalidCredentials = [undefined, null, [], {}, { appKey: 'key' }, { ...credentials(), token: 'synthetic-private' },
    { ...credentials(), url: 'https://synthetic.invalid' }, { ...credentials(), [Symbol('extra')]: 1 },
    Object.assign(Object.create({ inherited: true }), credentials()), getter]
  for (const input of invalidCredentials) await assert.rejects(exchange(input, { signal: signal() }), code('INPUT'))
  const optionsGetter = Object.defineProperty({}, 'signal', { enumerable: true, get() { accessed += 1; return signal() } })
  for (const options of [undefined, null, {}, [], { signal: signal(), headers: {} }, Object.create({ signal: signal() }), optionsGetter]) {
    await assert.rejects(exchange(credentials(), options), code('INPUT'))
  }
  assert.equal(accessed, 0)
  assert.equal(fetches, 0)
})

test('credentials reject missing, blank, wrong-type and overlong values before fetch', async () => {
  let fetches = 0
  const exchange = makeExchange(async () => { fetches += 1; return response() })
  for (const field of ['appKey', 'appSecret']) {
    for (const value of ['', ' \n\t', null, undefined, 7, {}, 'x'.repeat(4097)]) {
      await assert.rejects(exchange({ ...credentials(), [field]: value }, { signal: signal() }), code('INPUT'))
    }
  }
  assert.equal(fetches, 0)
  await exchange({ appKey: 'k'.repeat(4096), appSecret: 's'.repeat(4096) }, { signal: signal() })
  assert.equal(fetches, 1)
})

test('only native AbortSignal passes the brand check; forged getters are never evaluated', async () => {
  let fetches = 0
  let accessed = 0
  const exchange = makeExchange(async () => { fetches += 1; return response() })
  const fake = { get aborted() { accessed += 1; throw new Error('synthetic-private') }, addEventListener() {} }
  for (const value of [undefined, null, {}, false, fake, Object.create(AbortSignal.prototype), Object.create(signal()), new Proxy(signal(), {})]) {
    await assert.rejects(exchange(credentials(), { signal: value }), code('INPUT'))
  }
  assert.equal(fetches, 0)
  assert.equal(accessed, 0)
})

for (const status of [201, 204, 301, 302, 307, 400, 429, 500]) {
  test(`HTTP ${status} is refused before body reading and cleanup never waits on cancel`, async () => {
    if (status === 204) {
      await assert.rejects(makeExchange(async () => new Response(null, { status }))(credentials(), { signal: signal() }), code('RESPONSE'))
      return
    }
    const tracked = streamResponse([new TextEncoder().encode('synthetic-private')], { status }, () => new Promise(() => {}))
    await assert.rejects(makeExchange(async () => tracked.response)(credentials(), { signal: signal() }), code('RESPONSE'))
    assert.equal(tracked.counters.reads, 0)
    assert.equal(tracked.counters.cancellations, 1)
  })
}

test('redirected response is refused before body reads and unconsumed body is cancelled', async () => {
  const tracked = streamResponse([new TextEncoder().encode('synthetic-private')])
  Object.defineProperty(tracked.response, 'redirected', { value: true })
  await assert.rejects(makeExchange(async () => tracked.response)(credentials(), { signal: signal() }), code('RESPONSE'))
  assert.equal(tracked.counters.reads, 0)
  assert.equal(tracked.counters.cancellations, 1)
})

test('unsafe non-Response values and response accessors fail without exposing or invoking them', async () => {
  let accessed = 0
  const fake = { get status() { accessed += 1; throw new Error('synthetic-private') }, get body() { accessed += 1 } }
  for (const value of [undefined, null, {}, fake, Object.create(Response.prototype)]) {
    await assert.rejects(makeExchange(async () => value)(credentials(), { signal: signal() }), code('RESPONSE'))
  }
  for (const field of ['status', 'headers', 'body', 'redirected']) {
    const value = response()
    Object.defineProperty(value, field, { get() { accessed += 1; throw new Error('synthetic-private') } })
    await assert.rejects(makeExchange(async () => value)(credentials(), { signal: signal() }), code('RESPONSE'))
  }
  assert.equal(accessed, 0)
})

test('malformed and oversized declared lengths fail before read and cancel unconsumed streams', async () => {
  for (const declared of ['-1', '+1', '', '1.5', '1, 2', 'nope', '16385', '9007199254740993']) {
    const tracked = streamResponse([new TextEncoder().encode(JSON.stringify(validBody()))], { headers: { 'content-length': declared } })
    const kind = ['16385', '9007199254740993'].includes(declared) ? 'TOO_LARGE' : 'RESPONSE'
    await assert.rejects(makeExchange(async () => tracked.response)(credentials(), { signal: signal() }), code(kind))
    assert.equal(tracked.counters.reads, 0)
    assert.equal(tracked.counters.cancellations, 1)
  }
})

test('stream consumes actual bytes with a strict 16KiB bound even when declared length lies', async () => {
  const base = JSON.stringify({ ...validBody(), padding: '' })
  for (const extra of [0, 1]) {
    const payload = JSON.stringify({ ...validBody(), padding: 'p'.repeat(16384 - Buffer.byteLength(base) + extra) })
    assert.equal(Buffer.byteLength(payload), 16384 + extra)
    const bytes = new TextEncoder().encode(payload)
    const tracked = streamResponse([bytes.subarray(0, 8192), bytes.subarray(8192)], { headers: { 'content-length': '1' } })
    const promise = makeExchange(async () => tracked.response)(credentials(), { signal: signal() })
    if (extra) {
      await assert.rejects(promise, code('TOO_LARGE'))
      assert.equal(tracked.counters.cancellations, 1)
    } else {
      assert.deepEqual(await promise, validBody())
      assert.equal(tracked.counters.cancellations, 0)
    }
    assert.equal(tracked.response.body.locked, false)
  }
})

test('byte chunks can split UTF8 sequences and exact declared limit is accepted', async () => {
  const expected = { accessToken: 'synthetic-雪-token', expireIn: 1 }
  const bytes = new TextEncoder().encode(JSON.stringify(expected))
  for (const declared of ['16384', '00016384']) {
    const tracked = streamResponse(Array.from(bytes, (byte) => Uint8Array.of(byte)), { headers: { 'content-length': declared } })
    assert.deepEqual(await makeExchange(async () => tracked.response)(credentials(), { signal: signal() }), expected)
  }
})

test('endless empty chunks have a finite read bound and their source is cancelled', async () => {
  let reads = 0
  let cancellations = 0
  const body = new ReadableStream({
    pull(stream) { reads += 1; stream.enqueue(new Uint8Array(0)) },
    cancel() { cancellations += 1 },
  }, { highWaterMark: 0 })
  await assert.rejects(makeExchange(async () => new Response(body))(credentials(), { signal: signal() }), code('TOO_LARGE'))
  assert.equal(reads, 16385)
  assert.equal(cancellations, 1)
  assert.equal(body.locked, false)
})

test('all-one-byte exact-limit body can include its final done read', async () => {
  const base = JSON.stringify({ ...validBody(), padding: '' })
  const bytes = new TextEncoder().encode(JSON.stringify({ ...validBody(), padding: 'p'.repeat(16384 - Buffer.byteLength(base)) }))
  const tracked = streamResponse(Array.from(bytes, (byte) => Uint8Array.of(byte)))
  assert.deepEqual(await makeExchange(async () => tracked.response)(credentials(), { signal: signal() }), validBody())
  assert.equal(tracked.counters.reads, 16385)
})

test('chunk copying does not evaluate shadowed byteLength or iterators', async () => {
  let accessed = 0
  const bytes = new TextEncoder().encode(JSON.stringify(validBody()))
  Object.defineProperty(bytes, 'byteLength', { get() { accessed += 1; throw new Error('synthetic-private') } })
  Object.defineProperty(bytes, Symbol.iterator, { get() { accessed += 1; throw new Error('synthetic-private') } })
  const tracked = streamResponse([bytes])
  assert.deepEqual(await makeExchange(async () => tracked.response)(credentials(), { signal: signal() }), validBody())
  assert.equal(accessed, 0)
})

test('malformed UTF8, non-byte chunks, empty body and invalid JSON are refused', async () => {
  const malformedUtf8 = new Uint8Array([...Buffer.from('{"accessToken":"'), 0xc3, 0x28, ...Buffer.from('","expireIn":1}')])
  for (const chunks of [[malformedUtf8], ['not-bytes'], [new TextEncoder().encode('{synthetic-private')], []]) {
    const tracked = streamResponse(chunks)
    await assert.rejects(makeExchange(async () => tracked.response)(credentials(), { signal: signal() }), code('RESPONSE'))
    assert.equal(tracked.response.body.locked, false)
  }
  await assert.rejects(makeExchange(async () => new Response(null))(credentials(), { signal: signal() }), code('RESPONSE'))
})

test('token and TTL required fields are strictly checked with no fallback or coercion', async () => {
  const invalid = [null, [], true, {}, { accessToken: 't' }, { expireIn: 7200 },
    ...['', ' token', 'token ', '\ttoken', 'token\n', 'to\u0000ken', 'to\u007fken', 'to\u0085ken', 't'.repeat(8193), 1, {}, null]
      .map((accessToken) => ({ accessToken, expireIn: 7200 })),
    ...[0, -1, 1.5, 86401, Number.MAX_SAFE_INTEGER + 1, '7200', null, true, {}]
      .map((expireIn) => ({ accessToken: 'synthetic-token', expireIn })),
    { body: validBody(), statusCode: 200 }, { access_token: 'synthetic-token', expires_in: 7200 }]
  for (const body of invalid) {
    await assert.rejects(makeExchange(async () => response(body))(credentials(), { signal: signal() }), code('RESPONSE'))
  }
  for (const expireIn of [1, 86400]) {
    const body = { accessToken: 't'.repeat(8192), expireIn }
    assert.deepEqual(await makeExchange(async () => response(body))(credentials(), { signal: signal() }), body)
  }
})

test('abort before fetch fails closed without reading signal reason', async () => {
  const control = new AbortController()
  let accessed = 0
  let fetches = 0
  Object.defineProperty(control.signal, 'reason', { get() { accessed += 1; throw new Error('synthetic-private') } })
  control.abort('synthetic-private-abort-reason')
  const exchange = makeExchange(async () => { fetches += 1; return response() })
  await assert.rejects(exchange(credentials(), { signal: control.signal }), code('ABORTED'))
  assert.equal(accessed, 0)
  assert.equal(fetches, 0)
})

test('abort retains an uncooperative pending fetch until it settles, then cancels the late response', async () => {
  const control = new AbortController()
  const gate = deferred()
  let settled = false
  const exchange = makeExchange((_url, options) => { assert.equal(options.signal, control.signal); return gate.promise })
  const result = exchange(credentials(), { signal: control.signal })
  result.then(() => { settled = true }, () => { settled = true })
  control.abort('synthetic-private-abort-reason')
  await nextTurn()
  assert.equal(settled, false, 'lifecycle must retain the outstanding slot while raw fetch remains pending')
  const tracked = streamResponse([new TextEncoder().encode(JSON.stringify(validBody()))])
  gate.resolve(tracked.response)
  await assert.rejects(result, code('ABORTED'))
  assert.equal(tracked.counters.reads, 0)
  assert.equal(tracked.counters.cancellations, 1)
})

test('abort rejects after fetch rejects without carrying its private rejection value', async () => {
  const gate = deferred()
  const control = new AbortController()
  const result = makeExchange(() => gate.promise)(credentials(), { signal: control.signal })
  control.abort('synthetic-private-abort')
  gate.reject(new Error('synthetic-private-fetch'))
  await assert.rejects(result, code('ABORTED'))
})

test('abort of a stalled body cancels its reader, releases its lock, and ignores cancellation failures', async () => {
  const started = deferred()
  const control = new AbortController()
  let cancellations = 0
  const body = new ReadableStream({
    pull() { started.resolve(); return new Promise(() => {}) },
    cancel() { cancellations += 1; return Promise.reject(new Error('synthetic-private-cancel')) },
  }, { highWaterMark: 0 })
  const value = new Response(body)
  const result = makeExchange(async () => value)(credentials(), { signal: control.signal })
  await started.promise
  assert.equal(body.locked, true)
  control.abort('synthetic-private-abort')
  await assert.rejects(result, code('ABORTED'))
  assert.equal(cancellations, 1)
  assert.equal(body.locked, false)
  await nextTurn()
})

test('abort after read completion but before continuation cannot publish a token', async () => {
  const control = new AbortController()
  const body = new ReadableStream({
    pull(stream) {
      stream.enqueue(new TextEncoder().encode(JSON.stringify(validBody())))
      control.abort('synthetic-private-abort')
    },
  }, { highWaterMark: 0 })
  await assert.rejects(makeExchange(async () => new Response(body))(credentials(), { signal: control.signal }), code('ABORTED'))
})

test('arbitrary transport and stream errors are replaced with fixed values without inspecting them', async () => {
  let accessed = 0
  const unsafe = { get message() { accessed += 1; throw new Error('synthetic-private') }, get code() { accessed += 1 } }
  const decorated = new YidaTokenExchangeError('RESPONSE')
  decorated.cause = 'synthetic-private-cause'
  decorated.message = 'synthetic-private-message'
  for (const error of [undefined, null, 'synthetic-private-string', new Error('synthetic-private-fetch'), unsafe, decorated]) {
    await assert.rejects(makeExchange(async () => { throw error })(credentials(), { signal: signal() }), code(error === decorated ? 'RESPONSE' : 'UNAVAILABLE'))
  }
  const body = new ReadableStream({ pull(stream) { stream.error(new Error('synthetic-private-stream')) } }, { highWaterMark: 0 })
  await assert.rejects(makeExchange(async () => new Response(body))(credentials(), { signal: signal() }), code('UNAVAILABLE'))
  assert.equal(accessed, 0)
  const hostileKind = { toString() { throw new Error('synthetic-private-kind') } }
  assert.equal(new YidaTokenExchangeError(hostileKind).code, 'YIDA_TOKEN_EXCHANGE_UNAVAILABLE')
})

test('no automatic retry occurs after transport or response refusal', async () => {
  for (const outcome of ['throw', 'status']) {
    let calls = 0
    const exchange = makeExchange(async () => {
      calls += 1
      if (outcome === 'throw') throw new Error('synthetic-private-fetch')
      return response({ error: 'synthetic-private' }, { status: 400 })
    })
    await assert.rejects(exchange(credentials(), { signal: signal() }), code(outcome === 'throw' ? 'UNAVAILABLE' : 'RESPONSE'))
    assert.equal(calls, 1)
  }
})
