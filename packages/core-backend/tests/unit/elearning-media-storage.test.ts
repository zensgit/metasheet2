import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import {
  assertElearningMediaListLimit,
  deriveElearningMediaStorageKey,
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
})
