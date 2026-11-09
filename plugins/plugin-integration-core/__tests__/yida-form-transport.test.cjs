'use strict'

const assert = require('node:assert/strict')
const { test } = require('node:test')
const { ReadableStream } = require('node:stream/web')
const { createYidaFormTransport, YidaFormTransportError } = require('../lib/yida-form-transport.cjs')

// No live listener, network request, environment or credentials: these are
// actual Response/ReadableStream objects supplied by synthetic fetch functions.
const signal = () => new AbortController().signal
const createRequest = (patch = {}) => ({
  intent: 'create',
  data: { appType: 'synthetic-app', formUuid: 'synthetic-form', formDataJson: '{"textField_a":"synthetic-row","numberField_b":1}' },
  accessToken: 'synthetic-private-access', systemToken: 'synthetic-private-system', userId: 'synthetic-private-user',
  ...patch,
})
const updateRequest = (patch = {}) => createRequest({
  intent: 'update',
  data: { appType: 'synthetic-app', formInstanceId: 'synthetic-instance', updateFormDataJson: '{"textField_a":"synthetic-row"}' },
  ...patch,
})
const receipt = (status = 200) => new Response('{"result":"synthetic-instance"}', { status })
const transport = (fetch, patch = {}) => createYidaFormTransport({ fetch, readEnablement: () => 'true', ...patch })
const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const nextTurn = () => new Promise((resolve) => setImmediate(resolve))

for (const shape of ['own-constructor-getter', 'own-species-getter', 'subclass']) {
  test(`nonordinary Promise ${shape} enablement stays disabled without inspecting dependency constructors`, async () => {
    let touched = 0, calls = 0
    const value = shape === 'subclass' ? new (class extends Promise {})(resolve => resolve('true')) : Promise.resolve('true')
    if (shape === 'own-constructor-getter') Object.defineProperty(value, 'constructor', {
      get() { touched++; throw new Error('synthetic-private-constructor') },
    })
    if (shape === 'own-species-getter') Object.defineProperty(value, 'constructor', { value: {
      get [Symbol.species]() { touched++; throw new Error('synthetic-private-species') },
    } })
    const sender = transport(async () => { calls++; return receipt() }, { readEnablement: () => value })
    await assert.rejects(sender.send(createRequest(), { signal: signal() }), code('DISABLED'))
    assert.equal(touched + calls, 0)
    await nextTurn()
  })
}

function code(kind) {
  return (error) => {
    assert.ok(error instanceof YidaFormTransportError)
    assert.equal(error.code, `YIDA_FORM_${kind}`)
    assert.equal(Object.hasOwn(error, 'cause'), false)
    assert.deepEqual(Object.keys(error).sort(), ['code', 'name'])
    assert.doesNotMatch(String(error.stack), /synthetic-private|api\.dingtalk\.com|synthetic-instance/)
    return true
  }
}

function streamResponse(chunks, options = {}, onCancel = () => {}) {
  const counts = { reads: 0, cancels: 0 }
  let at = 0
  const body = new ReadableStream({
    pull(stream) { counts.reads += 1; if (at < chunks.length) stream.enqueue(chunks[at++]); else stream.close() },
    cancel() { counts.cancels += 1; return onCancel() },
  }, { highWaterMark: 0 })
  return { response: new Response(body, options), counts }
}

for (const intent of ['create', 'update']) {
  test(`${intent} uses fixed HTTPS path, verb, headers and exact serialized body without trimming`, async () => {
    const controller = new AbortController()
    const input = (intent === 'create' ? createRequest : updateRequest)({ systemToken: ' synthetic-private-system\t ', userId: ' synthetic-private-user ' })
    const jsonField = intent === 'create' ? 'formDataJson' : 'updateFormDataJson'
    input.data[jsonField] = ' { "textField_a": "雪 \\" ", "numberField_b": -1.25, "booleanField_c": false } '
    let calls = 0
    const sender = transport(async (url, options) => {
      calls += 1
      assert.equal(url, 'https://api.dingtalk.com/v1.0/yida/forms/instances')
      assert.deepEqual(Object.keys(options).sort(), ['body', 'headers', 'method', 'redirect', 'signal'])
      assert.equal(options.method, intent === 'create' ? 'POST' : 'PUT')
      assert.equal(options.redirect, 'error')
      // Gate 6: fetch receives a transport-owned native signal, not the run signal itself. It follows
      // the run signal only until the status line arrives (see the forwarding tests below).
      assert.equal(Object.getPrototypeOf(options.signal), AbortSignal.prototype)
      assert.notEqual(options.signal, controller.signal)
      assert.equal(options.signal.aborted, false)
      assert.deepEqual(options.headers, {
        'Content-Type': 'application/json; charset=utf-8', Accept: 'application/json',
        'x-acs-dingtalk-access-token': input.accessToken,
      })
      assert.equal(options.body, JSON.stringify({ ...input.data, systemToken: input.systemToken, userId: input.userId }))
      const sent = JSON.parse(options.body)
      assert.equal(sent[jsonField], input.data[jsonField])
      assert.equal('accessToken' in sent, false)
      assert.deepEqual(Object.keys(sent).sort(), [...Object.keys(input.data), 'systemToken', 'userId'].sort())
      return intent === 'create' ? receipt() : new Response('accepted')
    })
    assert.deepEqual(await sender.send(input, { signal: controller.signal }), { statusCode: 200, instanceId: 'synthetic-instance' })
    assert.equal(calls, 1)
    assert.deepEqual(Object.keys(sender), ['send'])
    assert.equal(Object.isFrozen(sender), true)
  })
}

test('default OFF and every non-literal enablement value cause zero fetch calls', async () => {
  let calls = 0
  const fetch = async () => { calls += 1; return receipt() }
  await assert.rejects(createYidaFormTransport({ fetch }).send(createRequest(), { signal: signal() }), code('DISABLED'))
  for (const value of [undefined, null, false, true, 1, 'TRUE', ' true', 'true ', 'false', {}, Promise.resolve('true'), Promise.reject(new Error('synthetic-private-enable'))]) {
    await assert.rejects(transport(fetch, { readEnablement: () => value }).send(createRequest(), { signal: signal() }), code('DISABLED'))
  }
  await assert.rejects(transport(fetch, { readEnablement() { throw new Error('synthetic-private-enable') } }).send(createRequest(), { signal: signal() }), code('DISABLED'))
  assert.equal(calls, 0)
  await nextTurn()
})

test('enablement is read fresh per send; no successful-send latch or retries', async () => {
  let enabled = 'true'
  let calls = 0
  const sender = transport(async () => { calls += 1; return receipt() }, { readEnablement: () => enabled })
  await sender.send(createRequest(), { signal: signal() })
  enabled = 'false'
  await assert.rejects(sender.send(createRequest(), { signal: signal() }), code('DISABLED'))
  assert.equal(calls, 1)
})

test('factory rejects missing implicit dependencies, extras, getters and proxy records', () => {
  let touched = 0
  const getter = Object.defineProperty({}, 'fetch', { enumerable: true, get() { touched += 1; throw new Error('synthetic-private') } })
  const proxy = new Proxy({ fetch() {} }, { getPrototypeOf() { touched += 1; throw new Error('synthetic-private') } })
  for (const value of [undefined, null, {}, { fetch: null }, { fetch() {}, readEnablement: null }, { fetch() {}, url: 'synthetic-private' },
    Object.create({ fetch() {} }), getter, proxy, { fetch() {}, [Symbol('extra')]: 1 },
    // The body deadline is an integer in [10, 60000] ms, like the runner budget; never a string or a float.
    { fetch() {}, bodyReadTimeoutMs: 9 }, { fetch() {}, bodyReadTimeoutMs: 60001 }, { fetch() {}, bodyReadTimeoutMs: '5000' },
    { fetch() {}, bodyReadTimeoutMs: 1.5 }, { fetch() {}, bodyReadTimeoutMs: null }]) {
    assert.throws(() => createYidaFormTransport(value), code('INPUT'))
  }
  assert.equal(touched, 0)
  for (const bodyReadTimeoutMs of [10, 5000, 60000]) assert.deepEqual(Object.keys(createYidaFormTransport({ fetch() {}, bodyReadTimeoutMs })), ['send'])
})

test('closed request/data/options reject overrides, missing fields and accessors before enablement/fetch', async () => {
  let enabled = 0
  let fetched = 0
  let touched = 0
  const sender = transport(async () => { fetched += 1; return receipt() }, { readEnablement: () => { enabled += 1; return 'true' } })
  const getter = createRequest()
  Object.defineProperty(getter, 'accessToken', { get() { touched += 1; throw new Error('synthetic-private') } })
  const inherited = Object.assign(Object.create({ inherited: true }), createRequest())
  const proxy = new Proxy(createRequest(), { ownKeys() { touched += 1; throw new Error('synthetic-private') } })
  const invalid = [undefined, null, [], {}, getter, inherited, proxy,
    createRequest({ intent: 'delete' }), createRequest({ url: 'https://synthetic.invalid' }),
    createRequest({ headers: {} }), createRequest({ body: '{}' }), createRequest({ approved: true }),
    createRequest({ [Symbol('extra')]: true }),
    createRequest({ data: { ...createRequest().data, systemToken: 'synthetic-private' } }),
    createRequest({ data: { ...createRequest().data, formInstanceId: 'synthetic-instance' } }),
    updateRequest({ data: { ...updateRequest().data, formUuid: 'synthetic-form' } }),
    updateRequest({ data: { appType: 'synthetic-app', formInstId: 'synthetic-instance', updateFormDataJson: '{}' } }),
  ]
  for (const value of invalid) await assert.rejects(sender.send(value, { signal: signal() }), code('INPUT'))
  for (const name of ['intent', 'data', 'accessToken', 'systemToken', 'userId']) {
    const input = createRequest(); delete input[name]
    await assert.rejects(sender.send(input, { signal: signal() }), code('INPUT'))
  }
  for (const options of [undefined, {}, { signal: signal(), url: 'synthetic-private' }, Object.create({ signal: signal() })]) {
    await assert.rejects(sender.send(createRequest(), options), code('INPUT'))
  }
  assert.equal(touched, 0)
  assert.equal(enabled, 0)
  assert.equal(fetched, 0)
})

test('native direct AbortSignal is mandatory; proxies and inherited signals are rejected without traps', async () => {
  let touched = 0
  let calls = 0
  const sender = transport(async () => { calls += 1; return receipt() })
  const proxy = new Proxy(signal(), { get() { touched += 1; throw new Error('synthetic-private') } })
  const fake = { get aborted() { touched += 1; throw new Error('synthetic-private') } }
  for (const value of [undefined, null, {}, fake, proxy, Object.create(signal()), Object.create(AbortSignal.prototype)]) {
    await assert.rejects(sender.send(createRequest(), { signal: value }), code('INPUT'))
  }
  assert.equal(touched, 0)
  assert.equal(calls, 0)
})

test('credential and target lengths/types are bounded; token whitespace and controls are refused', async () => {
  let calls = 0
  const sender = transport(async () => { calls += 1; return receipt() })
  for (const [field, maximum] of [['accessToken', 8192], ['systemToken', 4096], ['userId', 128]]) {
    for (const value of ['', ' \t', undefined, null, {}, 1, 'a'.repeat(maximum + 1)]) {
      await assert.rejects(sender.send(createRequest({ [field]: value }), { signal: signal() }), code('INPUT'))
    }
  }
  for (const value of [' token', 'token ', 'to\nken', 'to\u0000ken', 'to\u007fken', 'to\u0085ken']) {
    await assert.rejects(sender.send(createRequest({ accessToken: value }), { signal: signal() }), code('INPUT'))
  }
  for (const field of ['appType', 'formUuid']) {
    for (const value of ['', ' a', 'a ', 'a\n', 'a'.repeat(129), 1]) {
      await assert.rejects(sender.send(createRequest({ data: { ...createRequest().data, [field]: value } }), { signal: signal() }), code('INPUT'))
    }
  }
  assert.equal(calls, 0)
  await sender.send(createRequest({ accessToken: 'a'.repeat(8192), systemToken: 's'.repeat(4096), userId: 'u'.repeat(128) }), { signal: signal() })
  assert.equal(calls, 1)
})

test('inner JSON must have1..32 flat finite scalar fields with valid planner field IDs', async () => {
  let calls = 0
  const sender = transport(async () => { calls += 1; return receipt() })
  const invalid = ['', '{}', '[]', 'null', 'true', '{bad', '{"field":null}', '{"field":{}}', '{"field":[]}',
    '{"field":1e999}', '{"field":-0}', '{"field":"' + 'x'.repeat(4097) + '"}',
    '{"field":1,"field":2}', '{"field":1,"\\u0066ield":2}', '{"__proto__":"x"}', '{"accessToken":"x"}', '{"bad key":1}',
    JSON.stringify(Object.fromEntries(Array.from({ length: 33 }, (_, n) => [`field_${n}`, n])))]
  for (const formDataJson of invalid) {
    await assert.rejects(sender.send(createRequest({ data: { ...createRequest().data, formDataJson } }), { signal: signal() }), code('INPUT'))
  }
  assert.equal(calls, 0)
  const formDataJson = JSON.stringify(Object.fromEntries(Array.from({ length: 32 }, (_, n) => [`field_${n}`, n % 2 ? false : -1.25])))
  await sender.send(createRequest({ data: { ...createRequest().data, formDataJson } }), { signal: signal() })
  assert.equal(calls, 1)
})

test('serialized UTF8 request limit is256KiB including outer JSON/credentials, not character count', async () => {
  const fields = Object.fromEntries(Array.from({ length: 32 }, (_, n) => [`field_${n}`, n === 31 ? '' : 'λ'.repeat(4096)]))
  const input = createRequest()
  const wire = () => JSON.stringify({ ...input.data, formDataJson: JSON.stringify(fields), systemToken: input.systemToken, userId: input.userId })
  const remaining = 262144 - Buffer.byteLength(wire(), 'utf8')
  fields.field_31 = 'λ'.repeat(Math.floor(remaining / 2)) + (remaining % 2 ? 'a' : '')
  assert.ok(fields.field_31.length <= 4096)
  input.data.formDataJson = JSON.stringify(fields)
  assert.equal(Buffer.byteLength(wire(), 'utf8'), 262144)
  let calls = 0
  const sender = transport(async (_url, options) => { calls += 1; assert.equal(Buffer.byteLength(options.body, 'utf8'), 262144); return receipt() })
  await sender.send(input, { signal: signal() })
  fields.field_31 += 'a'
  input.data.formDataJson = JSON.stringify(fields)
  await assert.rejects(sender.send(input, { signal: signal() }), code('INPUT'))
  assert.equal(calls, 1)
})

for (const status of [200, 201, 202, 206, 299]) {
  test(`create accepts HTTP${status} only with a valid result and returns no extra fields`, async () => {
    const value = new Response('{"result":"synthetic-instance","success":true,"private":"synthetic-private"}', { status })
    assert.deepEqual(await transport(async () => value).send(createRequest(), { signal: signal() }), { statusCode: status, instanceId: 'synthetic-instance' })
  })
}

test('create does not accept missing/wrapped/non-string/unbounded/control result or empty204: a 2xx was received, so RECEIPT', async () => {
  for (const body of ['', 'null', '[]', '"synthetic-instance"', '{}', '{"body":{"result":"synthetic-instance"}}',
    ...[null, 1, true, {}, '', ' x', 'x ', 'x\n', 'x'.repeat(129)].map((result) => JSON.stringify({ result }))]) {
    await assert.rejects(transport(async () => new Response(body)).send(createRequest(), { signal: signal() }), code('RECEIPT'))
  }
  await assert.rejects(transport(async () => new Response(null, { status: 204 })).send(createRequest(), { signal: signal() }), code('RECEIPT'))
})

test('update accepts bounded non-JSON/empty/204 response and retains only the requested instance identity', async () => {
  for (const value of [new Response('accepted'), new Response(''), new Response(null, { status: 204 }), new Response('{"result":"different-instance"}', { status: 201 })]) {
    const statusCode = value.status
    assert.deepEqual(await transport(async () => value).send(updateRequest(), { signal: signal() }), { statusCode, instanceId: 'synthetic-instance' })
  }
})

test('update200 with business-error-looking body is HTTP ACK ONLY, never business verification', async () => {
  const value = new Response('{"success":false,"code":"synthetic-private-business-error","message":"synthetic-private-denied"}')
  const result = await transport(async () => value).send(updateRequest(), { signal: signal() })
  assert.deepEqual(result, { statusCode: 200, instanceId: 'synthetic-instance' })
  assert.deepEqual(Object.keys(result).sort(), ['instanceId', 'statusCode'])
  assert.equal('businessVerified' in result, false)
  assert.equal('success' in result, false)
  // The runner must keep businessVerified:false. A later independent read-back
  // verifier is required; this deliberately does not invent a vendor envelope.
})

for (const status of [301, 302, 307, 308, 400, 401, 429, 500]) {
  test(`HTTP${status} refuses before body read, cancels cleanup without waiting, and never retries`, async () => {
    const tracked = streamResponse([Buffer.from('synthetic-private-body')], { status }, () => new Promise(() => {}))
    let calls = 0
    await assert.rejects(transport(async () => { calls += 1; return tracked.response }).send(createRequest(), { signal: signal() }), code('RESPONSE'))
    assert.equal(calls, 1)
    assert.equal(tracked.counts.reads, 0)
    assert.equal(tracked.counts.cancels, 1)
  })
}

test('redirected response refuses before body read even with2xx status', async () => {
  const tracked = streamResponse([Buffer.from('{"result":"synthetic-instance"}')])
  Object.defineProperty(tracked.response, 'redirected', { value: true })
  await assert.rejects(transport(async () => tracked.response).send(createRequest(), { signal: signal() }), code('RESPONSE'))
  assert.equal(tracked.counts.reads, 0)
  assert.equal(tracked.counts.cancels, 1)
})

test('unsafe responses/proxies/getters reject without invoking unknown properties', async () => {
  let touched = 0
  const unsafe = { get status() { touched += 1; throw new Error('synthetic-private') } }
  const proxy = new Proxy(receipt(), { get() { touched += 1; throw new Error('synthetic-private') } })
  for (const value of [undefined, null, {}, unsafe, proxy, Object.create(receipt()), Object.create(Response.prototype)]) {
    await assert.rejects(transport(() => value).send(createRequest(), { signal: signal() }), code('RESPONSE'))
  }
  for (const field of ['status', 'body', 'headers', 'redirected']) {
    const value = receipt()
    Object.defineProperty(value, field, { get() { touched += 1; throw new Error('synthetic-private') } })
    await assert.rejects(transport(async () => value).send(createRequest(), { signal: signal() }), code('RESPONSE'))
  }
  assert.equal(touched, 0)
})

test('invalid/oversized declared response lengths reject before read; valid leadingzeros are allowed', async () => {
  for (const declared of ['', '-1', '+1', '1.5', '1,2', 'nope', '16385', '9007199254740993']) {
    const tracked = streamResponse([Buffer.from('{"result":"synthetic-instance"}')], { headers: { 'content-length': declared } })
    await assert.rejects(transport(async () => tracked.response).send(createRequest(), { signal: signal() }), code(['16385', '9007199254740993'].includes(declared) ? 'TOO_LARGE' : 'RESPONSE'))
    assert.equal(tracked.counts.reads, 0)
    assert.equal(tracked.counts.cancels, 1)
  }
  const tracked = streamResponse([Buffer.from('{"result":"synthetic-instance"}')], { headers: { 'content-length': '00016384' } })
  await transport(async () => tracked.response).send(createRequest(), { signal: signal() })
})

test('actual response byte cap applies to create/update despite a false short declared length', async () => {
  for (const intent of ['create', 'update']) {
    for (const extra of [0, 1]) {
      const base = JSON.stringify({ result: 'synthetic-instance', padding: '' })
      const bytes = Buffer.from(JSON.stringify({ result: 'synthetic-instance', padding: 'x'.repeat(16384 - Buffer.byteLength(base) + extra) }))
      const tracked = streamResponse([bytes.subarray(0, 8192), bytes.subarray(8192)], { headers: { 'content-length': '1' } })
      const result = transport(async () => tracked.response).send((intent === 'create' ? createRequest : updateRequest)(), { signal: signal() })
      if (extra) { await assert.rejects(result, code('TOO_LARGE')); assert.equal(tracked.counts.cancels, 1) }
      else assert.deepEqual(await result, { statusCode: 200, instanceId: 'synthetic-instance' })
      assert.equal(tracked.response.body.locked, false)
    }
  }
})

test('endless empty chunks hit16385-read cap and are cancelled; all-one-byte16KiB body succeeds', async () => {
  let reads = 0
  let cancels = 0
  const body = new ReadableStream({ pull(stream) { reads += 1; stream.enqueue(new Uint8Array(0)) }, cancel() { cancels += 1 } }, { highWaterMark: 0 })
  await assert.rejects(transport(async () => new Response(body)).send(updateRequest(), { signal: signal() }), code('TOO_LARGE'))
  assert.equal(reads, 16385)
  assert.equal(cancels, 1)
  const tracked = streamResponse(Array.from({ length: 16384 }, () => Uint8Array.of(97)))
  assert.deepEqual(await transport(async () => tracked.response).send(updateRequest(), { signal: signal() }), { statusCode: 200, instanceId: 'synthetic-instance' })
  assert.equal(tracked.counts.reads, 16385)
})

test('UTF8 chunks may split codepoints, but malformed bytes/non-byte chunks are RECEIPT (2xx received) even on update', async () => {
  const bytes = Buffer.from('{"result":"synthetic-雪"}')
  const valid = streamResponse(Array.from(bytes, (byte) => Uint8Array.of(byte)))
  assert.deepEqual(await transport(async () => valid.response).send(createRequest(), { signal: signal() }), { statusCode: 200, instanceId: 'synthetic-雪' })
  for (const chunks of [[Uint8Array.of(0xc3, 0x28)], ['not-bytes']]) {
    const tracked = streamResponse(chunks)
    await assert.rejects(transport(async () => tracked.response).send(updateRequest(), { signal: signal() }), code('RECEIPT'))
    assert.equal(tracked.response.body.locked, false)
  }
})

test('abort before send causes zero enablement/fetch and never reads signal reason', async () => {
  const controller = new AbortController()
  let touched = 0
  let enabled = 0
  let fetched = 0
  Object.defineProperty(controller.signal, 'reason', { get() { touched += 1; throw new Error('synthetic-private') } })
  controller.abort('synthetic-private-reason')
  const sender = transport(async () => { fetched += 1; return receipt() }, { readEnablement: () => { enabled += 1; return 'true' } })
  await assert.rejects(sender.send(createRequest(), { signal: controller.signal }), code('ABORTED'))
  assert.equal(touched + enabled + fetched, 0)
})

test('abort from enablement callback is checked before fetch', async () => {
  const controller = new AbortController()
  let calls = 0
  const sender = transport(async () => { calls += 1; return receipt() }, { readEnablement: () => { controller.abort('synthetic-private'); return 'true' } })
  await assert.rejects(sender.send(createRequest(), { signal: controller.signal }), code('ABORTED'))
  assert.equal(calls, 0)
})

test('before the status line the run signal is forwarded to the fetch signal; after it, no later abort reaches the body', async () => {
  const gate = deferred()
  const controller = new AbortController()
  let fetchSignal
  const tracked = streamResponse([Buffer.from('{"result":"synthetic-instance"}')])
  const result = transport((_url, options) => { fetchSignal = options.signal; return gate.promise }).send(createRequest(), { signal: controller.signal })
  await nextTurn()
  assert.equal(fetchSignal.aborted, false)
  gate.resolve(tracked.response)
  await nextTurn()
  // The status line has arrived: the forwarding is gone, so the run signal no longer aborts the fetch signal.
  controller.abort('synthetic-private')
  assert.equal(fetchSignal.aborted, false)
  assert.deepEqual(await result, { statusCode: 200, instanceId: 'synthetic-instance' })
  assert.equal(tracked.counts.cancels, 0)
  // Before the status line the same abort IS forwarded (the request is torn down, nothing is known).
  const early = new AbortController(), earlyGate = deferred()
  let earlySignal
  const pending = transport((_url, options) => { earlySignal = options.signal; return earlyGate.promise }).send(createRequest(), { signal: early.signal })
  await nextTurn()
  early.abort('synthetic-private')
  assert.equal(earlySignal.aborted, true)
  earlyGate.reject(Object.assign(new Error('synthetic-private-abort'), { name: 'AbortError' }))
  await assert.rejects(pending, code('ABORTED'))
})

test('aborted uncooperative fetch remains pending until settled; the late 2xx is then READ and returned (gate 6)', async () => {
  const gate = deferred()
  const controller = new AbortController()
  let settled = false
  let calls = 0
  let fetchSignal
  const result = transport((_url, options) => { calls += 1; fetchSignal = options.signal; return gate.promise }).send(createRequest(), { signal: controller.signal })
  result.then(() => { settled = true }, () => { settled = true })
  controller.abort('synthetic-private')
  await nextTurn()
  assert.equal(fetchSignal.aborted, true, 'the abort reached the fetch signal before any status line')
  assert.equal(settled, false, 'runner BUSY must retain this underlying pending fetch')
  const tracked = streamResponse([Buffer.from('{"result":"synthetic-instance"}')])
  gate.resolve(tracked.response)
  // A fetch that ignored the abort and still produced a 2xx: that receipt is evidence, never discarded.
  assert.deepEqual(await result, { statusCode: 200, instanceId: 'synthetic-instance' })
  assert.equal(calls, 1)
  assert.ok(tracked.counts.reads > 0)
  assert.equal(tracked.counts.cancels, 0)
})

test('a stalled 2xx body ends as RECEIPT at the transport body deadline (not by the run signal), cancels its reader and releases the lock', async () => {
  const entered = deferred()
  const controller = new AbortController()
  let cancels = 0
  const body = new ReadableStream({
    pull() { entered.resolve(); return new Promise(() => {}) },
    cancel() { cancels += 1; return Promise.reject(new Error('synthetic-private-cleanup')) },
  }, { highWaterMark: 0 })
  const started = Date.now()
  const result = transport(async () => new Response(body), { bodyReadTimeoutMs: 20 }).send(createRequest(), { signal: controller.signal })
  let settled = false
  result.then(() => { settled = true }, () => { settled = true })
  await entered.promise
  controller.abort('synthetic-private')
  await nextTurn()
  assert.equal(settled, false, 'an abort after the status line does not end the attempt')
  await assert.rejects(result, code('RECEIPT'))
  assert.ok(Date.now() - started < 5000, 'the deadline, not the default budget, ended the stall')
  assert.equal(cancels, 1)
  assert.equal(body.locked, false)
  await nextTurn()
})

test('abort immediately after chunk delivery publishes the ACK (the 2xx had already been received)', async () => {
  const controller = new AbortController()
  const body = new ReadableStream({ pull(stream) { stream.enqueue(Buffer.from('{"result":"synthetic-instance"}')); stream.close(); controller.abort('synthetic-private') } }, { highWaterMark: 0 })
  assert.deepEqual(await transport(async () => new Response(body)).send(createRequest(), { signal: controller.signal }), { statusCode: 200, instanceId: 'synthetic-instance' })
  assert.equal(controller.signal.aborted, true)
})

test('undici model: an abort before the status line is ABORTED; one microtask after it the errored body is RECEIPT, later it is a receipt', async () => {
  // Models real undici: the request follows options.signal for its whole life, so a late abort
  // errors the body stream instead of being ignored. The transport must not hand it that signal
  // after the status line, and must classify what it still gets as "2xx received".
  function undiciLike(respond) {
    return (_url, options) => new Promise((resolve, reject) => {
      const fetchSignal = options.signal
      if (fetchSignal.aborted) { reject(Object.assign(new Error('synthetic-private-abort'), { name: 'AbortError' })); return }
      let controller
      const body = new ReadableStream({
        start(stream) { controller = stream },
        pull(stream) { respond(stream) },
      }, { highWaterMark: 0 })
      fetchSignal.addEventListener('abort', () => { try { controller.error(Object.assign(new Error('synthetic-private-abort'), { name: 'AbortError' })) } catch { /* already closed */ } }, { once: true })
      setImmediate(() => {
        if (fetchSignal.aborted) reject(Object.assign(new Error('synthetic-private-abort'), { name: 'AbortError' }))
        else resolve(new Response(body))
      })
    })
  }
  const chunk = Buffer.from('{"result":"synthetic-instance"}')
  // (a) abort while the request is in flight (the model answers on the next turn): torn down, nothing known.
  const early = new AbortController()
  const earlyResult = transport(undiciLike((stream) => { stream.enqueue(chunk); stream.close() })).send(createRequest(), { signal: early.signal })
  early.abort('synthetic-private')
  await assert.rejects(earlyResult, code('ABORTED'))
  // (b) abort inside the microtask window right after the fetch promise resolved: the body is errored
  // by the undici model, but the status line was received, so it is RECEIPT, never UNAVAILABLE/ABORTED.
  const window = new AbortController()
  let resolvedResponse
  const windowFetch = undiciLike((stream) => { stream.enqueue(chunk); stream.close() })
  const windowResult = transport(async (url, options) => {
    const response = await windowFetch(url, options)
    resolvedResponse = response
    window.abort('synthetic-private') // same microtask as the resolution the transport is about to observe
    return response
  }).send(createRequest(), { signal: window.signal })
  await assert.rejects(windowResult, code('RECEIPT'))
  assert.ok(resolvedResponse instanceof Response)
  // (c) abort a whole turn after the status line: the body is read normally, the receipt is returned.
  const late = new AbortController()
  const lateResult = transport(undiciLike((stream) => { setImmediate(() => { stream.enqueue(chunk); stream.close() }) })).send(createRequest(), { signal: late.signal })
  await nextTurn(); await nextTurn()
  late.abort('synthetic-private')
  assert.deepEqual(await lateResult, { statusCode: 200, instanceId: 'synthetic-instance' })
})

test('transport/read errors are values-free and never retried or sent through refresh', async () => {
  let touched = 0
  const unsafe = { get code() { touched += 1; throw new Error('synthetic-private') }, get message() { touched += 1 } }
  const decorated = new YidaFormTransportError('RESPONSE')
  decorated.message = 'synthetic-private'
  decorated.cause = 'synthetic-private'
  for (const error of [undefined, null, 'synthetic-private', new Error('synthetic-private'), unsafe, decorated]) {
    let calls = 0
    const sender = transport(async () => { calls += 1; throw error })
    await assert.rejects(sender.send(createRequest(), { signal: signal() }), code(error === decorated ? 'RESPONSE' : 'UNAVAILABLE'))
    assert.equal(calls, 1)
  }
  // An errored 2xx body is RECEIPT: the status line was received before the stream failed.
  const body = new ReadableStream({ pull(stream) { stream.error(new Error('synthetic-private')) } }, { highWaterMark: 0 })
  await assert.rejects(transport(async () => new Response(body)).send(createRequest(), { signal: signal() }), code('RECEIPT'))
  assert.equal(touched, 0)
})

test('2xx with an oversized declared or actual body is TOO_LARGE and a 2xx non-JSON body is RECEIPT; both are post-status classes', async () => {
  const declared = streamResponse([Buffer.from('{"result":"synthetic-instance"}')], { status: 201, headers: { 'content-length': '16385' } })
  await assert.rejects(transport(async () => declared.response).send(createRequest(), { signal: signal() }), code('TOO_LARGE'))
  assert.equal(declared.counts.reads, 0)
  const actual = streamResponse([Buffer.from('x'.repeat(16385))], { status: 201 })
  await assert.rejects(transport(async () => actual.response).send(createRequest(), { signal: signal() }), code('TOO_LARGE'))
  await assert.rejects(transport(async () => new Response('not-json', { status: 201 })).send(createRequest(), { signal: signal() }), code('RECEIPT'))
  // Non-2xx and redirects stay RESPONSE: nothing says the remote accepted anything.
  await assert.rejects(transport(async () => new Response('not-json', { status: 500 })).send(createRequest(), { signal: signal() }), code('RESPONSE'))
})
