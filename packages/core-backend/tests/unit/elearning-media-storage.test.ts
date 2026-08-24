import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import {
  createElearningMediaS3Provider,
  ElearningMediaS3Provider,
  readElearningMediaS3Config,
  type ElearningMediaS3CommandSender,
} from '../../src/services/elearning-media-s3'
import {
  deriveElearningMediaStorageKey,
  ELEARNING_MEDIA_STORAGE_PREFIX,
  LocalFsElearningMediaStore,
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
})

describe('elearning media S3 config', () => {
  it('requires complete bucket+region; optional endpoint is HTTPS-only; path-style is exact true', () => {
    expect(readElearningMediaS3Config({} as NodeJS.ProcessEnv)).toBeNull()
    expect(readElearningMediaS3Config({
      ELEARNING_MEDIA_S3_BUCKET: 'bucket',
    } as NodeJS.ProcessEnv)).toBeNull()
    expect(() => readElearningMediaS3Config({
      ELEARNING_MEDIA_S3_BUCKET: 'bucket',
      ELEARNING_MEDIA_S3_REGION: 'us-east-1',
      ELEARNING_MEDIA_S3_ENDPOINT: 'http://127.0.0.1:9000',
    } as NodeJS.ProcessEnv)).toThrow(/HTTPS/)
    expect(readElearningMediaS3Config({
      ELEARNING_MEDIA_S3_BUCKET: 'bucket',
      ELEARNING_MEDIA_S3_REGION: 'us-east-1',
      ELEARNING_MEDIA_S3_ENDPOINT: 'https://s3.example.invalid',
      ELEARNING_MEDIA_S3_FORCE_PATH_STYLE: 'true',
    } as NodeJS.ProcessEnv)).toMatchObject({ bucket: 'bucket', forcePathStyle: true })
    expect(readElearningMediaS3Config({
      ELEARNING_MEDIA_S3_BUCKET: 'bucket',
      ELEARNING_MEDIA_S3_REGION: 'us-east-1',
      ELEARNING_MEDIA_S3_FORCE_PATH_STYLE: 'TRUE',
    } as NodeJS.ProcessEnv)).toMatchObject({ forcePathStyle: false })
  })

  it('malformed endpoint fails values-free', () => {
    const SECRET_ENDPOINT = 'not a url://AKIASECRET999/user:p@ss@evil-host/path'
    let thrown: unknown
    try {
      readElearningMediaS3Config({
        ELEARNING_MEDIA_S3_BUCKET: 'bucket',
        ELEARNING_MEDIA_S3_REGION: 'us-east-1',
        ELEARNING_MEDIA_S3_ENDPOINT: SECRET_ENDPOINT,
      } as NodeJS.ProcessEnv)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(RangeError)
    expect((thrown as Error).message).toBe('elearning media S3 endpoint is invalid')
    expect((thrown as Error).message).not.toContain('AKIASECRET999')
    expect(String(thrown)).not.toContain(SECRET_ENDPOINT)
  })

  it('refuses keys outside the prefix before the SDK is called', async () => {
    let calls = 0
    const sender: ElearningMediaS3CommandSender = { send: async () => { calls += 1; return {} } }
    const provider = new ElearningMediaS3Provider({
      bucket: 'private-bucket',
      region: 'us-east-1',
      forcePathStyle: false,
    }, sender)
    await expect(provider.uploadByKey('other/x.mp4', Buffer.from('x'))).rejects.toThrow(/outside/)
    expect(calls).toBe(0)
    expect(createElearningMediaS3Provider({ NODE_ENV: 'production' } as NodeJS.ProcessEnv, sender)).toBeNull()
    expect(createElearningMediaS3Provider({
      ELEARNING_MEDIA_S3_BUCKET: 'bucket',
      ELEARNING_MEDIA_S3_REGION: 'us-east-1',
    } as NodeJS.ProcessEnv, sender)).toBeInstanceOf(ElearningMediaS3Provider)
  })
})
