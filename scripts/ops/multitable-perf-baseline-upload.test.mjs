import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_SEED_UPLOAD_TIMEOUT_MS,
  DEFAULT_XLSX_CHUNK_SIZE,
  XLSX_SERVER_MAX_ROWS,
  buildUploadDispatcherOptions,
  createUploadDispatcher,
  formatErrorWithCause,
  resolveSeedUploadTimeoutMs,
  resolveXlsxChunkSize,
  wrapUndiciLoadError,
} from './multitable-perf-baseline-upload.mjs'

// ---------------------------------------------------------------------------
// Dispatcher construction (verdict §6 fix #2 — timeouts applied; no network)
// ---------------------------------------------------------------------------

class FakeAgent {
  constructor(opts) {
    this.opts = opts
  }
}

test('createUploadDispatcher applies 1800s headers/body timeouts by default', () => {
  const dispatcher = createUploadDispatcher(FakeAgent, undefined)
  assert.deepEqual(dispatcher.opts, {
    headersTimeout: 1_800_000,
    bodyTimeout: 1_800_000,
  })
})

test('default seed-upload timeout is ≥1800s (the verdict requirement)', () => {
  assert.equal(DEFAULT_SEED_UPLOAD_TIMEOUT_MS, 1_800_000)
  assert.ok(DEFAULT_SEED_UPLOAD_TIMEOUT_MS >= 1_800_000)
  // …and strictly above the undici default 300s headersTimeout that produced
  // the 307s wall on every ≥50k chunk.
  assert.ok(DEFAULT_SEED_UPLOAD_TIMEOUT_MS > 300_000)
})

test('resolveSeedUploadTimeoutMs allows raising but floors at 1800s', () => {
  assert.equal(resolveSeedUploadTimeoutMs('3600000'), 3_600_000) // raise OK
  assert.equal(resolveSeedUploadTimeoutMs('1000'), 1_800_000) // cannot go below
  assert.equal(resolveSeedUploadTimeoutMs('300000'), 1_800_000) // undici default rejected
  assert.equal(resolveSeedUploadTimeoutMs(''), DEFAULT_SEED_UPLOAD_TIMEOUT_MS)
  assert.equal(resolveSeedUploadTimeoutMs(undefined), DEFAULT_SEED_UPLOAD_TIMEOUT_MS)
  assert.equal(resolveSeedUploadTimeoutMs('not-a-number'), DEFAULT_SEED_UPLOAD_TIMEOUT_MS)
})

test('buildUploadDispatcherOptions sets ONLY headers/body timeouts', () => {
  const opts = buildUploadDispatcherOptions('2400000')
  assert.deepEqual(Object.keys(opts).sort(), ['bodyTimeout', 'headersTimeout'])
  assert.equal(opts.headersTimeout, 2_400_000)
  assert.equal(opts.bodyTimeout, 2_400_000)
})

test('real undici Agent constructs with the raised timeouts (no network)', async () => {
  const { Agent } = await import('undici')
  const dispatcher = createUploadDispatcher(Agent, undefined)
  assert.equal(typeof dispatcher.dispatch, 'function') // fetch dispatcher contract
  assert.equal(typeof dispatcher.close, 'function')
  await dispatcher.close()
})

// ---------------------------------------------------------------------------
// Chunk-size math
// ---------------------------------------------------------------------------

test('resolveXlsxChunkSize default stays at the 50k server cap', () => {
  assert.equal(DEFAULT_XLSX_CHUNK_SIZE, 50_000)
  assert.equal(XLSX_SERVER_MAX_ROWS, 50_000)
  assert.equal(resolveXlsxChunkSize(undefined), 50_000)
  assert.equal(resolveXlsxChunkSize(''), 50_000)
})

test('resolveXlsxChunkSize honors the recommended ~≤200s belt-and-braces value', () => {
  // 10k chunks measured ~100s on staging → 20k ≈ 200s per chunk.
  assert.equal(resolveXlsxChunkSize('20000'), 20_000)
  // 50k → 3 chunks, 100k → 5 chunks at that size (verdict §6 fix #1 math).
  assert.equal(Math.ceil(50_000 / resolveXlsxChunkSize('20000')), 3)
  assert.equal(Math.ceil(100_000 / resolveXlsxChunkSize('20000')), 5)
})

test('resolveXlsxChunkSize clamps to [1, 50_000] and rejects NaN', () => {
  assert.equal(resolveXlsxChunkSize('999999'), 50_000) // server cap
  assert.equal(resolveXlsxChunkSize('0'), 1)
  assert.equal(resolveXlsxChunkSize('-5'), 1)
  // Previous inline math propagated NaN for non-numeric input; now → default.
  assert.equal(resolveXlsxChunkSize('not-a-number'), 50_000)
})

// ---------------------------------------------------------------------------
// Error-cause logging (verdict §6 evidence caveat — err.cause was masked)
// ---------------------------------------------------------------------------

test('formatErrorWithCause surfaces the undici cause code masked by err.message', () => {
  // Reproduces the exact masking scenario from the verdict: fetch throws
  // TypeError("fetch failed") with the real reason only on err.cause.
  const cause = new Error('Headers Timeout Error')
  cause.code = 'UND_ERR_HEADERS_TIMEOUT'
  const err = new TypeError('fetch failed', { cause })
  const out = formatErrorWithCause(err)
  assert.match(out, /fetch failed/)
  assert.match(out, /Headers Timeout Error/)
  assert.match(out, /\[code=UND_ERR_HEADERS_TIMEOUT\]/)
})

test('formatErrorWithCause without a cause prints just the message', () => {
  assert.equal(formatErrorWithCause(new Error('plain failure')), 'plain failure')
})

test('formatErrorWithCause walks nested cause chains and non-Error causes', () => {
  const err = new Error('layer-1', {
    cause: new Error('layer-2', { cause: 'string-cause' }),
  })
  const out = formatErrorWithCause(err)
  assert.equal(out, 'layer-1 ← caused by: layer-2 ← caused by: string-cause')
})

test('formatErrorWithCause terminates on cyclic cause chains', () => {
  const a = new Error('a')
  const b = new Error('b')
  a.cause = b
  b.cause = a
  const out = formatErrorWithCause(a)
  assert.match(out, /cause chain truncated/)
})

// N1: a non-Error plain-object cause hits JSON.stringify. A CIRCULAR plain object
// makes JSON.stringify throw — formatErrorWithCause must not itself blow up.
test('formatErrorWithCause survives a circular plain-object cause (no throw)', () => {
  const circular = { tag: 'circular-cause' }
  circular.self = circular
  const err = new Error('outer', { cause: circular })
  let out
  assert.doesNotThrow(() => {
    out = formatErrorWithCause(err)
  })
  assert.match(out, /outer/)
  // some readable placeholder for the unstringifiable cause (not a crash)
  assert.match(out, /unserializable|\[object/i)
})

// N4: the undici-load wrap error must attach the underlying error as `cause`
// (Error cause option), not just splice its message into the text.
test('wrapUndiciLoadError attaches the original error as { cause }', () => {
  const original = new Error('ERR_MODULE_NOT_FOUND: undici')
  const wrapped = wrapUndiciLoadError(original)
  assert.ok(wrapped instanceof Error)
  assert.equal(wrapped.cause, original)
  assert.match(wrapped.message, /undici/)
  assert.match(wrapped.message, /pnpm install/)
  // and it round-trips through the cause formatter
  assert.match(formatErrorWithCause(wrapped), /ERR_MODULE_NOT_FOUND/)
})
