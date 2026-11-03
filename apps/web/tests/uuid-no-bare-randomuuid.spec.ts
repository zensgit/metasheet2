/**
 * Non-secure-context UUID guard.
 *
 * `crypto.randomUUID` only exists in a secure context (HTTPS or localhost). A deployment reached over
 * plain HTTP by IP (intranet) has `isSecureContext === false`: `crypto.randomUUID` is undefined while
 * `crypto.getRandomValues` still works. E-learning admin/learner screens called the native API
 * directly and failed with request_failed(0) before any request left the browser.
 *
 * Two halves:
 *   1. Tripwire — no file under apps/web/src except src/utils/uuid.ts may mention the native API
 *      name; every caller goes through `randomUuid()`.
 *   2. Contract of `randomUuid()` itself — native pass-through, getRandomValues-built RFC 4122 v4
 *      fallback, explicit error (never Math.random) when neither exists.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/utils/api', () => ({
  apiFetch: vi.fn(),
}))

import { randomUuid, UuidUnavailableError } from '../src/utils/uuid'
import { createElearningContentRequestIdTracker } from '../src/services/elearningContent'

const SRC_ROOT = resolve(__dirname, '../src')
const HELPER = 'utils/uuid.ts'
const NATIVE_NAME = ['random', 'UUID'].join('')
const SCANNED_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.vue']
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function listSourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      out.push(...listSourceFiles(full))
    } else if (SCANNED_EXTENSIONS.some((ext) => name.endsWith(ext))) {
      out.push(full)
    }
  }
  return out
}

// Captured before any stub: the stubs below replace globalThis.crypto, so reading it lazily would
// recurse into the stub itself.
const REAL_CRYPTO = globalThis.crypto

function realGetRandomValues<T extends ArrayBufferView>(array: T): T {
  REAL_CRYPTO.getRandomValues(array as unknown as Uint8Array)
  return array
}

describe('tripwire: no bare native UUID calls in apps/web/src', () => {
  const files = listSourceFiles(SRC_ROOT).map((full) => ({
    full,
    rel: relative(SRC_ROOT, full).split(sep).join('/'),
  }))

  it('scans a non-trivial source tree that includes the helper (scan is not blind)', () => {
    expect(files.length).toBeGreaterThan(500)
    const helper = files.find((file) => file.rel === HELPER)
    expect(helper).toBeDefined()
    expect(readFileSync(helper!.full, 'utf8')).toContain(NATIVE_NAME)
  })

  it('only src/utils/uuid.ts mentions the native API name', () => {
    const offenders = files
      .filter((file) => file.rel !== HELPER)
      .flatMap((file) => readFileSync(file.full, 'utf8')
        .split(/\r?\n/)
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => line.includes(NATIVE_NAME))
        .map(({ line, index }) => `src/${file.rel}:${index + 1}: ${line.trim()}`))
    expect(offenders).toEqual([])
  })
})

describe('randomUuid()', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('passes through the native generator when it exists (secure context)', () => {
    const getRandomValues = vi.fn(realGetRandomValues)
    vi.stubGlobal('crypto', { [NATIVE_NAME]: () => 'native-id', getRandomValues })
    expect(randomUuid()).toBe('native-id')
    expect(getRandomValues).not.toHaveBeenCalled()
  })

  it('does not swallow an error thrown by the native generator', () => {
    vi.stubGlobal('crypto', {
      [NATIVE_NAME]: () => { throw new Error('unsupported') },
      getRandomValues: realGetRandomValues,
    })
    expect(() => randomUuid()).toThrow('unsupported')
  })

  it('builds an RFC 4122 v4 UUID from getRandomValues when the native generator is absent (non-secure context)', () => {
    const getRandomValues = vi.fn(realGetRandomValues)
    vi.stubGlobal('crypto', { getRandomValues })
    const mathRandom = vi.spyOn(Math, 'random')
    const seen = new Set<string>()
    for (let index = 0; index < 1000; index += 1) {
      const value = randomUuid()
      expect(value).toMatch(UUID_V4)
      seen.add(value)
    }
    expect(seen.size).toBe(1000)
    expect(getRandomValues).toHaveBeenCalledTimes(1000)
    expect(mathRandom).not.toHaveBeenCalled()
  })

  it('forces the version and variant bits regardless of the random bytes', () => {
    vi.stubGlobal('crypto', { getRandomValues: <T extends ArrayBufferView>(array: T) => { (array as unknown as Uint8Array).fill(0xff); return array } })
    expect(randomUuid()).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff')
    vi.stubGlobal('crypto', { getRandomValues: <T extends ArrayBufferView>(array: T) => { (array as unknown as Uint8Array).fill(0x00); return array } })
    expect(randomUuid()).toBe('00000000-0000-4000-8000-000000000000')
  })

  it('throws UuidUnavailableError (never Math.random) when no Web Crypto random source exists', () => {
    const mathRandom = vi.spyOn(Math, 'random')
    vi.stubGlobal('crypto', {})
    expect(() => randomUuid()).toThrow(UuidUnavailableError)
    vi.stubGlobal('crypto', undefined)
    expect(() => randomUuid()).toThrow(UuidUnavailableError)
    expect(mathRandom).not.toHaveBeenCalled()
  })

  it('e-learning content request ids no longer fail in a non-secure context', () => {
    vi.stubGlobal('crypto', { getRandomValues: realGetRandomValues })
    const tracker = createElearningContentRequestIdTracker()
    const requestId = tracker.forPublish({ title: 'Course', items: [] })
    expect(requestId).toMatch(UUID_V4)
    expect(tracker.forPublish({ title: 'Course', items: [] })).toBe(requestId)
  })
})
