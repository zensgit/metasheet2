import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { describe, expect, test } from 'vitest'

import { isElearningMediaSurfaceEnabled } from '../../src/elearning/feature-flags'
import {
  bootElearningMediaRuntime,
  resolveElearningMediaStorage,
} from '../../src/services/elearning-media-runtime'
import type { ElearningMediaDb } from '../../src/services/elearning-media-quota'

const logger = { info: () => {}, warn: () => {}, error: () => {} }

const LOOKALIKES: Array<string | undefined> = [
  undefined, '', 'false', 'FALSE', '0', '1', 'yes', 'on', 'TRUE', 'True', ' true', 'true ',
]

function fakeDb(): ElearningMediaDb {
  return {
    query: async () => ({ rows: [], rowCount: 0 }),
    transaction: async (handler) => handler({ query: async () => ({ rows: [], rowCount: 0 }) }),
  }
}

describe('elearning media runtime boot', () => {
  test('master+MEDIA must both be exact true; lookalikes register nothing', async () => {
    expect(isElearningMediaSurfaceEnabled({} as NodeJS.ProcessEnv)).toBe(false)
    for (const value of LOOKALIKES) {
      expect(isElearningMediaSurfaceEnabled({
        ELEARNING_ENABLED: value,
        ELEARNING_MEDIA_ENABLED: 'true',
      } as NodeJS.ProcessEnv)).toBe(false)
      expect(isElearningMediaSurfaceEnabled({
        ELEARNING_ENABLED: 'true',
        ELEARNING_MEDIA_ENABLED: value,
      } as NodeJS.ProcessEnv)).toBe(false)
    }
    expect(await bootElearningMediaRuntime({
      db: fakeDb(),
      logger,
      env: { ELEARNING_ENABLED: 'true' } as NodeJS.ProcessEnv,
    })).toBeNull()
    expect(await bootElearningMediaRuntime({
      db: fakeDb(),
      logger,
      env: { ELEARNING_MEDIA_ENABLED: 'true' } as NodeJS.ProcessEnv,
    })).toBeNull()
  })

  test('production without complete S3 config is s3-required and never local-fs', () => {
    const prod = resolveElearningMediaStorage({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)
    expect(prod.kind).toBe('s3-required')
    expect(prod.store).toBeNull()
    const withDir = resolveElearningMediaStorage({
      NODE_ENV: 'production',
      ELEARNING_MEDIA_STORAGE_DIR: '/tmp/should-not-be-used',
    } as NodeJS.ProcessEnv)
    expect(withDir.kind).toBe('s3-required')
  })

  test('dev uses dedicated ELEARNING_MEDIA_STORAGE_DIR', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'elearn-media-rt-'))
    const local = resolveElearningMediaStorage({ ELEARNING_MEDIA_STORAGE_DIR: dir } as NodeJS.ProcessEnv)
    expect(local.kind).toBe('local-fs')
    expect(local.kind === 'local-fs' && local.rootDir).toBe(dir)
  })

  test('production with complete S3 config resolves object-store', () => {
    const sender = { send: async () => ({ Body: { transformToByteArray: async () => new Uint8Array() } }) }
    const resolved = resolveElearningMediaStorage({
      NODE_ENV: 'production',
      ELEARNING_MEDIA_S3_BUCKET: 'bucket',
      ELEARNING_MEDIA_S3_REGION: 'us-east-1',
    } as NodeJS.ProcessEnv, sender)
    expect(resolved.kind).toBe('object-store')
  })

  test('flag ON + unusable local root → boot THROWS (fail-closed)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'elearn-media-rt-'))
    const fileNotDir = path.join(dir, 'a-regular-file')
    writeFileSync(fileNotDir, 'not a directory')
    await expect(bootElearningMediaRuntime({
      db: fakeDb(),
      logger,
      env: {
        ELEARNING_ENABLED: 'true',
        ELEARNING_MEDIA_ENABLED: 'true',
        ELEARNING_MEDIA_STORAGE_DIR: path.join(fileNotDir, 'nested'),
      } as NodeJS.ProcessEnv,
    })).rejects.toThrow()
  })

  test('flag ON production incomplete S3 mounts with s3-required fail-close', async () => {
    const runtime = await bootElearningMediaRuntime({
      db: fakeDb(),
      logger,
      env: {
        ELEARNING_ENABLED: 'true',
        ELEARNING_MEDIA_ENABLED: 'true',
        NODE_ENV: 'production',
      } as NodeJS.ProcessEnv,
    })
    expect(runtime).not.toBeNull()
    expect(runtime!.storage.kind).toBe('s3-required')
    expect(runtime!.router).toBeTruthy()
  })
})
