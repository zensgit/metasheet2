'use strict'

const assert = require('node:assert/strict')
const { test } = require('node:test')
const { createYidaConnectionProbeBinding, YidaConnectionProbeError } = require('../lib/yida-connection-probe.cjs')

// probeForm() (ADR adr-yida-connection-test-20261028, addendum 2026-11-23): the same single token
// exchange, then exactly one READ of the form's component definitions with that token. Every
// transport, credential and form identifier here is synthetic and injected; no listener or network.
// Endpoints are literals written here on purpose, never imported from the module under test.
const DINGTALK_OAUTH_ENDPOINT = 'https://api.dingtalk.com/v1.0/oauth2/accessToken'
const DEFINITIONS_PREFIX = 'https://api.dingtalk.com/v1.0/yida/forms/definitions/'
const TOKEN = 'synthetic-form-access-token'
const credentials = () => ({ appKey: 'synthetic-form-key', appSecret: 'synthetic-form-secret' })
const form = () => ({ appType: 'APP_SYNTHETIC01', formUuid: 'FORM-SYNTHETIC-01', systemToken: 'synthetic-system-token', userId: 'synthetic-user' })
const tokenBody = () => JSON.stringify({ accessToken: TOKEN, expireIn: 7200 })
const definitions = (result) => JSON.stringify({ result })
const sample = () => [
  { fieldId: 'textField_proj01', label: '项目号', componentName: 'TextField' },
  { fieldId: 'numberField_qty01', label: { zh_CN: '数量', en_US: 'Qty', type: 'i18n' }, componentName: 'NumberField', parentId: '' },
  { fieldId: 'selectField_pri01', label: '优先级', componentName: 'SelectField', props: { ignored: true } },
]

function harness(definitionsResponse) {
  const calls = []
  const fetch = async (url, init) => {
    calls.push({ url, init })
    if (url === DINGTALK_OAUTH_ENDPOINT) return new Response(tokenBody(), { status: 200 })
    return definitionsResponse(url, init)
  }
  const probe = createYidaConnectionProbeBinding().createConnectionProbe({ fetch })
  return { calls, probe }
}
const signal = () => new AbortController().signal

test('ok: one exchange then one GET of the fixed definitions path; the reply has fields only, never the token', async () => {
  const h = harness(() => new Response(definitions(sample()), { status: 200 }))
  const result = await h.probe.probeForm(credentials(), form(), { signal: signal() })
  assert.deepEqual(Object.keys(result), ['outcome', 'form'])
  assert.equal(result.outcome, 'ok')
  assert.equal(result.form.outcome, 'ok')
  assert.deepEqual(JSON.parse(JSON.stringify(result.form.fields)), [
    { fieldId: 'textField_proj01', label: '项目号', componentName: 'TextField', parentId: null },
    { fieldId: 'numberField_qty01', label: '数量', componentName: 'NumberField', parentId: null },
    { fieldId: 'selectField_pri01', label: '优先级', componentName: 'SelectField', parentId: null },
  ])
  assert.equal(Object.isFrozen(result) && Object.isFrozen(result.form) && Object.isFrozen(result.form.fields), true)
  assert.equal(result.form.fields.every(Object.isFrozen), true)
  assert.equal(JSON.stringify(result).includes(TOKEN), false)
  assert.equal(JSON.stringify(result).includes('synthetic-system-token'), false)
  assert.equal(h.calls.length, 2)
  const [, read] = h.calls
  const url = new URL(read.url)
  assert.equal(url.origin + url.pathname, DEFINITIONS_PREFIX + 'APP_SYNTHETIC01/FORM-SYNTHETIC-01')
  assert.deepEqual([...url.searchParams.keys()], ['systemToken', 'userId', 'language'])
  assert.equal(url.searchParams.get('systemToken'), 'synthetic-system-token')
  assert.equal(url.searchParams.get('userId'), 'synthetic-user')
  assert.equal(read.init.method, 'GET')
  assert.equal(read.init.redirect, 'error')
  assert.equal(read.init.headers['x-acs-dingtalk-access-token'], TOKEN)
  assert.equal(read.init.body, undefined)
})

test('a failed exchange never reads the form: form outcome not_attempted', async () => {
  for (const [respond, outcome] of [
    [() => new Response('{}', { status: 401 }), 'upstream_rejected'],
    [() => { throw new TypeError('fetch failed') }, 'unreachable'],
  ]) {
    const calls = []
    const probe = createYidaConnectionProbeBinding().createConnectionProbe({ fetch: async (url, init) => { calls.push(url); return respond(url, init) } })
    const result = await probe.probeForm(credentials(), form(), { signal: signal() })
    assert.deepEqual(JSON.parse(JSON.stringify(result)), { outcome, form: { outcome: 'not_attempted' } })
    assert.deepEqual(calls, [DINGTALK_OAUTH_ENDPOINT])
  }
})

test('any non-2xx, redirect, malformed, oversized or unexpected definitions answer is upstream_rejected', async () => {
  const samples = [
    () => new Response('{"code":"Forbidden.AccessDenied"}', { status: 403 }),
    () => new Response('{}', { status: 400 }),
    () => new Response('{}', { status: 500 }),
    () => new Response('<html>synthetic proxy page</html>', { status: 200 }),
    () => new Response('{"result":{}}', { status: 200 }),
    () => new Response('{"data":[]}', { status: 200 }),
    () => new Response(definitions([{ fieldId: 'bad id', componentName: 'TextField' }]), { status: 200 }),
    () => new Response(definitions([{ fieldId: 'textField_a', componentName: '' }]), { status: 200 }),
    () => new Response(definitions([{ fieldId: 'textField_a', componentName: 'TextField' }, { fieldId: 'textField_a', componentName: 'TextField' }]), { status: 200 }),
    () => new Response(definitions(Array.from({ length: 257 }, (_v, index) => ({ fieldId: `textField_${index}`, componentName: 'TextField' }))), { status: 200 }),
    () => new Response('{}', { status: 200, headers: { 'content-length': String(256 * 1024 + 1) } }),
    () => new Response('x'.repeat(256 * 1024 + 1), { status: 200 }),
    () => new Response(new Uint8Array([0xff, 0xfe, 0x7b]), { status: 200 }),
  ]
  for (const [index, respond] of samples.entries()) {
    const h = harness(respond)
    const result = await h.probe.probeForm(credentials(), form(), { signal: signal() })
    assert.deepEqual(JSON.parse(JSON.stringify(result)), { outcome: 'ok', form: { outcome: 'upstream_rejected' } }, `sample ${index}`)
    assert.equal(h.calls.length, 2, `sample ${index}`)
  }
})

test('a definitions fetch that cannot connect is unreachable; the pair itself stays ok', async () => {
  const h = harness(() => { throw new TypeError('fetch failed') })
  assert.deepEqual(JSON.parse(JSON.stringify(await h.probe.probeForm(credentials(), form(), { signal: signal() }))),
    { outcome: 'ok', form: { outcome: 'unreachable' } })
})

test('an abort during the definitions read is a form timeout, not a lost pair', async () => {
  const control = new AbortController()
  const h = harness((_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    control.abort()
  }))
  const result = await h.probe.probeForm(credentials(), form(), { signal: control.signal })
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { outcome: 'ok', form: { outcome: 'timeout' } })
})

test('blank or odd labels become empty text; the field still counts', async () => {
  const h = harness(() => new Response(definitions([
    { fieldId: 'textField_a', componentName: 'TextField', label: 42 },
    { fieldId: 'textField_b', componentName: 'TextField', label: 'line\nbreak' },
    { fieldId: 'textField_c', componentName: 'TextField', label: 'x'.repeat(257) },
    { fieldId: 'textField_d', componentName: 'TextField', label: { en_US: 'English only' }, parentId: 'tableField_p' },
  ]), { status: 200 }))
  const result = await h.probe.probeForm(credentials(), form(), { signal: signal() })
  assert.deepEqual(result.form.fields.map((field) => [field.label, field.parentId]),
    [['', null], ['', null], ['', null], ['English only', 'tableField_p']])
})

test('invalid form identifiers or private values never reach fetch', async () => {
  const bad = [
    { ...form(), appType: 'APP/../x' },
    { ...form(), formUuid: '' },
    { ...form(), formUuid: 'FORM?x=1' },
    { ...form(), systemToken: ' padded' },
    { ...form(), systemToken: 'zero​width' },
    { ...form(), userId: 'x'.repeat(129) },
    { ...form(), extra: 'x' },
    { appType: 'APP_A', formUuid: 'FORM-A', systemToken: 'synthetic' },
  ]
  for (const [index, target] of bad.entries()) {
    const h = harness(() => new Response(definitions(sample())))
    await assert.rejects(h.probe.probeForm(credentials(), target, { signal: signal() }), (error) => error instanceof YidaConnectionProbeError
      && error.code === 'YIDA_CONNECTION_PROBE_UNAVAILABLE', `sample ${index}`)
    assert.equal(h.calls.length, 0, `sample ${index}`)
  }
})

test('caller abort before the exchange is a cancellation and nothing is fetched', async () => {
  const aborted = new AbortController(); aborted.abort()
  const h = harness(() => new Response(definitions(sample())))
  await assert.rejects(h.probe.probeForm(credentials(), form(), { signal: aborted.signal }), { code: 'YIDA_CONNECTION_PROBE_CANCELLED' })
  assert.equal(h.calls.length, 0)
})
