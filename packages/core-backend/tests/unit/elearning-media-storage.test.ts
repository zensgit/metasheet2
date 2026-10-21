import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

import {
  assertElearningMediaByteRange,
  assertElearningMediaListLimit,
  deriveElearningMediaStorageKey,
  ELEARNING_MEDIA_RANGE_MAX_BYTES,
  ELEARNING_MEDIA_STORAGE_PREFIX,
  LocalFsElearningMediaStore,
  nonnegativeAgeMs,
  ObjectStoreElearningMediaStore,
} from '../../src/services/elearning-media-storage'

const root = mkdtempSync(path.join(tmpdir(), 'elearn-media-'))
const store = new LocalFsElearningMediaStore(root)

describe('elearning media storage', () => {
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('derives server keys under the dedicated prefix and never interpolates a user filename', () => {
    const key = deriveElearningMediaStorageKey(() => new Date(Date.UTC(2026, 7, 24)))
    expect(key).toMatch(/^elearning-media\/2026-08\/[0-9a-f-]{36}\.mp4$/)
    expect(key.startsWith(ELEARNING_MEDIA_STORAGE_PREFIX)).toBe(true)
    expect(key).not.toMatch(/lesson|evil|\.\./)
  })

  it('contains puts inside the dedicated root and refuses traversal/NUL/foreign prefixes', async () => {
    const key = deriveElearningMediaStorageKey()
    await store.put(key, Buffer.from('mp4'))
    expect((await store.get(key)).toString()).toBe('mp4')
    await expect(store.put(key, Buffer.from('x'))).rejects.toThrow()
    expect(await store.delete(key)).toBe(true)
    expect(await store.delete(key)).toBe(false)
    for (const bad of [
      '../escape.mp4',
      '../../etc/passwd',
      '/abs/path.mp4',
      'a\0b',
      'uploads/user.mp4',
      'elearning-media/../secret.mp4',
    ]) {
      await expect(store.get(bad)).rejects.toThrow(/refused|outside/)
    }
  })

  it('object-store adapter refuses keys outside the elearning prefix before the provider is called', async () => {
    let calls = 0
    const adapter = new ObjectStoreElearningMediaStore({
      uploadByKey: async () => { calls += 1 },
      downloadByKey: async () => { calls += 1; return Buffer.alloc(0) },
      deleteByKey: async () => { calls += 1 },
      downloadRangeByKey: async () => { calls += 1; return Buffer.alloc(0) },
    })
    await expect(adapter.put('other/x.mp4', Buffer.from('x'))).rejects.toThrow(/outside/)
    expect(calls).toBe(0)
  })

  it('hasBlob is true for files, false on ENOENT, refuses foreign keys, and rethrows other errors', async () => {
    const key = `${ELEARNING_MEDIA_STORAGE_PREFIX}2026-08/has-blob.mp4`
    expect(await store.hasBlob(key)).toBe(false)
    await store.put(key, Buffer.from('blob'))
    expect(await store.hasBlob(key)).toBe(true)
    await expect(store.hasBlob('uploads/user.mp4')).rejects.toThrow(/refused|outside/)
    const nested = `${key}/nested`
    await expect(store.hasBlob(nested)).rejects.toThrow()
    await store.delete(key)
  })

  it('listPage enumerates only the dedicated prefix in deterministic order with a hard page bound', async () => {
    mkdirSync(path.join(root, 'other'), { recursive: true })
    writeFileSync(path.join(root, 'other', 'secret.mp4'), 'nope')
    writeFileSync(path.join(root, 'not-media.mp4'), 'nope')
    const keys = [
      `${ELEARNING_MEDIA_STORAGE_PREFIX}2026-08/ccc.mp4`,
      `${ELEARNING_MEDIA_STORAGE_PREFIX}2026-08/aaa.mp4`,
      `${ELEARNING_MEDIA_STORAGE_PREFIX}2026-08/bbb.mp4`,
    ]
    for (const key of keys) await store.put(key, Buffer.from('x'))
    const now = new Date('2026-08-24T00:00:00.000Z')
    const first = await store.listPage(undefined, 2, now)
    expect(first.blobs).toHaveLength(2)
    expect(first.blobs.map((blob) => blob.key)).toEqual([
      `${ELEARNING_MEDIA_STORAGE_PREFIX}2026-08/aaa.mp4`,
      `${ELEARNING_MEDIA_STORAGE_PREFIX}2026-08/bbb.mp4`,
    ])
    expect(first.nextCursor).toBe(`${ELEARNING_MEDIA_STORAGE_PREFIX}2026-08/bbb.mp4`)
    for (const blob of first.blobs) {
      expect(Number.isSafeInteger(blob.ageMs)).toBe(true)
      expect(blob.ageMs).toBeGreaterThanOrEqual(0)
      expect(blob.key.startsWith(ELEARNING_MEDIA_STORAGE_PREFIX)).toBe(true)
    }
    const second = await store.listPage(first.nextCursor, 2, now)
    expect(second.blobs.map((blob) => blob.key)).toEqual([
      `${ELEARNING_MEDIA_STORAGE_PREFIX}2026-08/ccc.mp4`,
    ])
    expect(second.nextCursor).toBeUndefined()
    const past = await store.listPage(undefined, 10, new Date(0))
    expect(past.blobs.every((blob) => blob.ageMs === 0)).toBe(true)
    expect(past.blobs.every((blob) => !blob.key.includes('secret') && !blob.key.includes('not-media'))).toBe(true)
    await expect(store.listPage('elearning-media/../secret.mp4', 10)).rejects.toThrow(/refused|outside/)
    for (const key of keys) await store.delete(key)
  })

  it('nonnegativeAgeMs returns a nonnegative safe integer for fractional mtime and rejects invalid clocks values-free', () => {
    const now = new Date('2026-08-24T00:00:00.000Z')
    const nowMs = now.getTime()
    expect(nonnegativeAgeMs(nowMs - 1500.7, now)).toBe(1500)
    expect(nonnegativeAgeMs(nowMs - 0.1, now)).toBe(0)
    expect(nonnegativeAgeMs(nowMs + 10.9, now)).toBe(0)
    expect(Number.isSafeInteger(nonnegativeAgeMs(nowMs - 1.9, now))).toBe(true)
    const secret = 'mtime=9999999999 clock=secret-host'
    for (const invalidNow of [new Date(Number.NaN), {} as Date]) {
      let thrown: unknown
      try {
        nonnegativeAgeMs(nowMs, invalidNow)
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(RangeError)
      expect((thrown as Error).message).toBe('elearning media age clock is invalid')
      expect(String(thrown)).not.toContain(secret)
      expect(String(thrown)).not.toContain(String(nowMs))
    }
    for (const invalidMtime of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      let thrown: unknown
      try {
        nonnegativeAgeMs(invalidMtime, now)
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(RangeError)
      expect((thrown as Error).message).toBe('elearning media last-modified time is invalid')
      expect(String(thrown)).not.toContain('NaN')
      expect(String(thrown)).not.toContain('Infinity')
      expect(String(thrown)).not.toContain(secret)
    }
  })

  it('rejects list limits that are not safe integers in 1..1000', async () => {
    for (const bad of [0, -1, 1001, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => assertElearningMediaListLimit(bad)).toThrow(/out of range/)
      await expect(store.listPage(undefined, bad)).rejects.toThrow(/out of range/)
    }
    expect(assertElearningMediaListLimit(1)).toBe(1)
    expect(assertElearningMediaListLimit(1000)).toBe(1000)
  })

  it('range-reads inclusive middle, open-end-equivalent, one-byte, and EOF-short slices without whole-file get', async () => {
    const key = `${ELEARNING_MEDIA_STORAGE_PREFIX}2026-08/range-bytes.mp4`
    const payload = Buffer.from('0123456789')
    await store.put(key, payload)
    expect(await store.getRange(key, 3, 6)).toEqual(Buffer.from('3456'))
    expect(await store.getRange(key, 7, payload.length - 1)).toEqual(Buffer.from('789'))
    expect(await store.getRange(key, 4, 4)).toEqual(Buffer.from('4'))
    expect(await store.getRange(key, 8, 20)).toEqual(Buffer.from('89'))
    expect((await store.get(key)).equals(payload)).toBe(true)
    await store.delete(key)
  })

  it('rejects invalid byte ranges and traversal before I/O', async () => {
    const missing = `${ELEARNING_MEDIA_STORAGE_PREFIX}2026-08/range-missing.mp4`
    const secret = 'range=AKIASECRET999/host=secret-host/path=../../etc/passwd'
    for (const [start, end] of [
      [-1, 0],
      [0, -1],
      [2, 1],
      [1.5, 2],
      [Number.NaN, 1],
      [0, Number.POSITIVE_INFINITY],
      [Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER + 2],
    ] as Array<[number, number]>) {
      let thrown: unknown
      try {
        assertElearningMediaByteRange(start, end)
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(RangeError)
      expect((thrown as Error).message).toBe('elearning media byte range is invalid — refused')
      expect(String(thrown)).not.toContain(secret)
      await expect(store.getRange(missing, start, end)).rejects.toThrow(/invalid|refused/)
    }
    expect(assertElearningMediaByteRange(0, 0)).toEqual({ start: 0, end: 0 })
    expect(assertElearningMediaByteRange(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)).toEqual({
      start: Number.MAX_SAFE_INTEGER,
      end: Number.MAX_SAFE_INTEGER,
    })
    for (const bad of [
      '../escape.mp4',
      '../../etc/passwd',
      '/abs/path.mp4',
      'a\0b',
      'uploads/user.mp4',
      'elearning-media/../secret.mp4',
    ]) {
      await expect(store.getRange(bad, 0, 0)).rejects.toThrow(/refused|outside/)
    }
  })

  it('accepts an exact-max inclusive span and still returns EOF-short bytes', async () => {
    const key = `${ELEARNING_MEDIA_STORAGE_PREFIX}2026-08/range-max.mp4`
    const payload = Buffer.from('0123456789')
    await store.put(key, payload)
    const maxEnd = ELEARNING_MEDIA_RANGE_MAX_BYTES - 1
    expect(assertElearningMediaByteRange(0, maxEnd)).toEqual({ start: 0, end: maxEnd })
    expect(assertElearningMediaByteRange(100, 100 + maxEnd)).toEqual({ start: 100, end: 100 + maxEnd })
    const seen: Array<{ start: number; end: number }> = []
    const adapter = new ObjectStoreElearningMediaStore({
      uploadByKey: async () => undefined,
      downloadByKey: async () => Buffer.alloc(0),
      deleteByKey: async () => undefined,
      downloadRangeByKey: async (_storageKey, start, end) => {
        seen.push({ start, end })
        return Buffer.from('x')
      },
    })
    expect(await adapter.getRange(key, 0, maxEnd)).toEqual(Buffer.from('x'))
    expect(seen).toEqual([{ start: 0, end: maxEnd }])
    const alloc = vi.spyOn(Buffer, 'alloc')
    try {
      expect(await store.getRange(key, 0, maxEnd)).toEqual(payload)
      expect(alloc).toHaveBeenCalledWith(ELEARNING_MEDIA_RANGE_MAX_BYTES)
      expect(alloc.mock.calls.every((call) => {
        const size = call[0]
        return typeof size !== 'number' || size <= ELEARNING_MEDIA_RANGE_MAX_BYTES
      })).toBe(true)
    } finally {
      alloc.mockRestore()
      await store.delete(key)
    }
  })

  it('rejects spans above the fixed range cap before I/O or allocation', async () => {
    const missing = `${ELEARNING_MEDIA_STORAGE_PREFIX}2026-08/range-cap-missing.mp4`
    const secret = 'range=AKIASECRET999/host=secret-host/path=../../etc/passwd'
    const oversize = [
      [0, ELEARNING_MEDIA_RANGE_MAX_BYTES],
      [1, ELEARNING_MEDIA_RANGE_MAX_BYTES + 1],
      [0, Number.MAX_SAFE_INTEGER],
      [Number.MAX_SAFE_INTEGER - ELEARNING_MEDIA_RANGE_MAX_BYTES, Number.MAX_SAFE_INTEGER],
    ] as Array<[number, number]>
    let adapterCalls = 0
    const adapter = new ObjectStoreElearningMediaStore({
      uploadByKey: async () => { adapterCalls += 1 },
      downloadByKey: async () => { adapterCalls += 1; return Buffer.alloc(0) },
      deleteByKey: async () => { adapterCalls += 1 },
      downloadRangeByKey: async () => { adapterCalls += 1; return Buffer.alloc(0) },
    })
    const alloc = vi.spyOn(Buffer, 'alloc')
    try {
      for (const [start, end] of oversize) {
        alloc.mockClear()
        let thrown: unknown
        try {
          assertElearningMediaByteRange(start, end)
        } catch (error) {
          thrown = error
        }
        expect(thrown).toBeInstanceOf(RangeError)
        expect((thrown as Error).message).toBe('elearning media byte range is invalid — refused')
        expect(String(thrown)).not.toContain(secret)
        expect(String(thrown)).not.toContain(String(start))
        expect(String(thrown)).not.toContain(String(end))
        await expect(store.getRange(missing, start, end)).rejects.toThrow(/invalid|refused/)
        await expect(adapter.getRange(missing, start, end)).rejects.toThrow(/invalid|refused/)
        expect(alloc.mock.calls.some((call) => {
          const size = call[0]
          return typeof size === 'number' && size > ELEARNING_MEDIA_RANGE_MAX_BYTES
        })).toBe(false)
      }
    } finally {
      alloc.mockRestore()
    }
    expect(adapterCalls).toBe(0)
  })

  it('object-store adapter range-reads through the provider after key and bound checks', async () => {
    let calls = 0
    const seen: Array<{ key: string; start: number; end: number }> = []
    const adapter = new ObjectStoreElearningMediaStore({
      uploadByKey: async () => { calls += 1 },
      downloadByKey: async () => { calls += 1; return Buffer.alloc(0) },
      deleteByKey: async () => { calls += 1 },
      downloadRangeByKey: async (key, start, end) => {
        calls += 1
        seen.push({ key, start, end })
        return Buffer.from('ab')
      },
    })
    const key = `${ELEARNING_MEDIA_STORAGE_PREFIX}2026-08/adapter-range.mp4`
    expect(await adapter.getRange(key, 3, 6)).toEqual(Buffer.from('ab'))
    expect(seen).toEqual([{ key, start: 3, end: 6 }])
    expect(calls).toBe(1)
    await expect(adapter.getRange('other/x.mp4', 0, 1)).rejects.toThrow(/outside/)
    await expect(adapter.getRange(key, 2, 1)).rejects.toThrow(/invalid|refused/)
    expect(calls).toBe(1)
  })

  it('object-store adapter independently refuses provider range bodies longer than the requested span or cap — values-free', async () => {
    const key = `${ELEARNING_MEDIA_STORAGE_PREFIX}2026-08/adapter-oversize.mp4`
    const secret = 'range=AKIASECRET999/host=secret-host/path=../../etc/passwd'
    let spanCalls = 0
    const overSpan = new ObjectStoreElearningMediaStore({
      uploadByKey: async () => undefined,
      downloadByKey: async () => Buffer.alloc(0),
      deleteByKey: async () => undefined,
      downloadRangeByKey: async () => {
        spanCalls += 1
        return Buffer.from([1, 2, 3])
      },
    })
    let thrown: unknown
    try {
      await overSpan.getRange(key, 4, 4)
    } catch (error) {
      thrown = error
    }
    expect(spanCalls).toBe(1)
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toBe('elearning media range body unavailable')
    expect(String(thrown)).not.toContain(secret)
    expect(String(thrown)).not.toContain(key)
    expect(String(thrown)).not.toContain('AKIA')

    let capCalls = 0
    const overCap = new ObjectStoreElearningMediaStore({
      uploadByKey: async () => undefined,
      downloadByKey: async () => Buffer.alloc(0),
      deleteByKey: async () => undefined,
      downloadRangeByKey: async () => {
        capCalls += 1
        return Buffer.alloc(ELEARNING_MEDIA_RANGE_MAX_BYTES + 1)
      },
    })
    let capThrown: unknown
    try {
      await overCap.getRange(key, 0, ELEARNING_MEDIA_RANGE_MAX_BYTES - 1)
    } catch (error) {
      capThrown = error
    }
    expect(capCalls).toBe(1)
    expect(capThrown).toBeInstanceOf(Error)
    expect((capThrown as Error).message).toBe('elearning media range body unavailable')
    expect(String(capThrown)).not.toContain(secret)
    expect(String(capThrown)).not.toContain(key)
    expect(String(capThrown)).not.toContain(String(ELEARNING_MEDIA_RANGE_MAX_BYTES))
  })
})
