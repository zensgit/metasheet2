import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3'
import { describe, expect, it, vi } from 'vitest'

import {
  createElearningMediaS3Provider,
  ElearningMediaS3Provider,
  readElearningMediaS3Config,
  type ElearningMediaS3CommandSender,
} from '../../src/services/elearning-media-s3'
import {
  ELEARNING_MEDIA_RANGE_MAX_BYTES,
  ELEARNING_MEDIA_STORAGE_PREFIX,
} from '../../src/services/elearning-media-storage'

const SECRET_BUCKET = 'secret-bucket-xyz'
const SECRET_HOST = 's3.leaked-host.example'
const SECRET_KEY = `${ELEARNING_MEDIA_STORAGE_PREFIX}secret-object.mp4`

function provider(send: ElearningMediaS3CommandSender['send']): ElearningMediaS3Provider {
  return new ElearningMediaS3Provider({
    bucket: SECRET_BUCKET,
    region: 'us-east-1',
    forcePathStyle: false,
  }, { send })
}

function asyncByteBody(
  chunks: Array<Uint8Array | Buffer>,
  extra?: { transformToByteArray?: () => Promise<Uint8Array> },
): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
    ...extra,
  }
}

function trackedAsyncBody(chunks: unknown[], consumed: number[]): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      for (let i = 0; i < chunks.length; i += 1) {
        consumed.push(i)
        yield chunks[i]
      }
    },
  }
}

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
    const s3 = new ElearningMediaS3Provider({
      bucket: 'private-bucket',
      region: 'us-east-1',
      forcePathStyle: false,
    }, sender)
    await expect(s3.uploadByKey('other/x.mp4', Buffer.from('x'))).rejects.toThrow(/outside/)
    expect(calls).toBe(0)
    expect(createElearningMediaS3Provider({ NODE_ENV: 'production' } as NodeJS.ProcessEnv, sender)).toBeNull()
    expect(createElearningMediaS3Provider({
      ELEARNING_MEDIA_S3_BUCKET: 'bucket',
      ELEARNING_MEDIA_S3_REGION: 'us-east-1',
    } as NodeJS.ProcessEnv, sender)).toBeInstanceOf(ElearningMediaS3Provider)
  })
})

describe('elearning media S3 listing and existence', () => {
  it('listMediaBlobsPage uses ListObjectsV2 with dedicated prefix, MaxKeys, and continuation token', async () => {
    const commands: unknown[] = []
    const s3 = provider(async (command) => {
      commands.push(command)
      return {
        Contents: [
          { Key: `${ELEARNING_MEDIA_STORAGE_PREFIX}2026-08/aaa.mp4`, LastModified: new Date('2026-08-23T00:00:00.000Z') },
          { Key: `${ELEARNING_MEDIA_STORAGE_PREFIX}2026-08/bbb.mp4`, LastModified: new Date('2026-08-22T00:00:00.000Z') },
        ],
        IsTruncated: true,
        NextContinuationToken: 'token-2',
      }
    })
    const now = new Date('2026-08-24T00:00:00.000Z')
    const page = await s3.listMediaBlobsPage('token-1', 2, now)
    expect(commands).toHaveLength(1)
    expect(commands[0]).toBeInstanceOf(ListObjectsV2Command)
    const input = (commands[0] as ListObjectsV2Command).input
    expect(input.Prefix).toBe(ELEARNING_MEDIA_STORAGE_PREFIX)
    expect(input.MaxKeys).toBe(2)
    expect(input.ContinuationToken).toBe('token-1')
    expect(page.blobs).toEqual([
      { key: `${ELEARNING_MEDIA_STORAGE_PREFIX}2026-08/aaa.mp4`, ageMs: 86_400_000 },
      { key: `${ELEARNING_MEDIA_STORAGE_PREFIX}2026-08/bbb.mp4`, ageMs: 172_800_000 },
    ])
    expect(page.nextCursor).toBe('token-2')
    const future = await s3.listMediaBlobsPage(undefined, 2, new Date('2026-08-01T00:00:00.000Z'))
    expect(future.blobs.every((blob) => blob.ageMs === 0)).toBe(true)

    const conservative = provider(async () => ({
      Contents: [
        { Key: `${ELEARNING_MEDIA_STORAGE_PREFIX}2026-08/aaa.mp4` },
        { Key: `${ELEARNING_MEDIA_STORAGE_PREFIX}2026-08/bbb.mp4`, LastModified: new Date(Number.NaN) },
      ],
      IsTruncated: false,
    }))
    const missingDates = await conservative.listMediaBlobsPage(undefined, 2, now)
    expect(missingDates.blobs.map((blob) => blob.ageMs)).toEqual([0, 0])
  })

  it('rejects an S3 response whose Contents exceeds the requested hard limit — values-free', async () => {
    const extraKey = `${ELEARNING_MEDIA_STORAGE_PREFIX}2026-08/extra.mp4`
    const s3 = provider(async () => ({
      Contents: [
        { Key: `${ELEARNING_MEDIA_STORAGE_PREFIX}2026-08/aaa.mp4`, LastModified: new Date() },
        { Key: extraKey, LastModified: new Date() },
      ],
      IsTruncated: false,
    }))
    let thrown: unknown
    try {
      await s3.listMediaBlobsPage(undefined, 1)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(RangeError)
    expect((thrown as Error).message).toBe('elearning media listing exceeded the requested page bound')
    expect(String(thrown)).not.toContain(SECRET_BUCKET)
    expect(String(thrown)).not.toContain(extraKey)
    expect(String(thrown)).not.toContain(SECRET_HOST)
  })

  it('rejects out-of-range limits, foreign returned keys, and truncated pages without a token — values-free', async () => {
    const s3 = provider(async () => ({
      Contents: [{ Key: 'uploads/foreign.mp4', LastModified: new Date() }],
      IsTruncated: false,
    }))
    await expect(s3.listMediaBlobsPage(undefined, 0)).rejects.toThrow(/out of range/)
    await expect(s3.listMediaBlobsPage(undefined, 1001)).rejects.toThrow(/out of range/)
    await expect(s3.listMediaBlobsPage(undefined, 1.5)).rejects.toThrow(/out of range/)
    let foreign: unknown
    try {
      await s3.listMediaBlobsPage(undefined, 10)
    } catch (error) {
      foreign = error
    }
    expect(String(foreign)).not.toContain(SECRET_BUCKET)
    expect(String(foreign)).not.toContain('uploads/foreign.mp4')
    expect(String(foreign)).not.toContain(SECRET_HOST)

    const truncated = provider(async () => ({
      Contents: [{ Key: SECRET_KEY, LastModified: new Date() }],
      IsTruncated: true,
    }))
    let incomplete: unknown
    try {
      await truncated.listMediaBlobsPage(undefined, 10)
    } catch (error) {
      incomplete = error
    }
    expect((incomplete as Error).message).toBe('elearning media listing is truncated without a continuation token')
    expect(String(incomplete)).not.toContain(SECRET_BUCKET)
    expect(String(incomplete)).not.toContain(SECRET_KEY)
  })

  it('hasMediaBlob uses HeadObject; 404/NotFound/NoSuchKey are false; other failures throw values-free', async () => {
    const commands: unknown[] = []
    const present = provider(async (command) => {
      commands.push(command)
      return {}
    })
    expect(await present.hasMediaBlob(SECRET_KEY)).toBe(true)
    expect(commands[0]).toBeInstanceOf(HeadObjectCommand)
    expect((commands[0] as HeadObjectCommand).input.Key).toBe(SECRET_KEY)

    await expect(present.hasMediaBlob('uploads/user.mp4')).rejects.toThrow(/outside/)
    expect(commands).toHaveLength(1)

    const missing = provider(async () => {
      const err = new Error(`missing ${SECRET_KEY} in ${SECRET_BUCKET} at ${SECRET_HOST}`)
      ;(err as { name: string; $metadata: { httpStatusCode: number } }).name = 'NotFound'
      ;(err as { $metadata: { httpStatusCode: number } }).$metadata = { httpStatusCode: 404 }
      throw err
    })
    expect(await missing.hasMediaBlob(SECRET_KEY)).toBe(false)
    const noSuchKey = provider(async () => {
      throw Object.assign(new Error('no such'), { name: 'NoSuchKey' })
    })
    expect(await noSuchKey.hasMediaBlob(SECRET_KEY)).toBe(false)

    const denied = provider(async () => {
      throw Object.assign(new Error(`AccessDenied ${SECRET_BUCKET} ${SECRET_HOST} ${SECRET_KEY}`), { name: 'AccessDenied' })
    })
    let thrown: unknown
    try {
      await denied.hasMediaBlob(SECRET_KEY)
    } catch (error) {
      thrown = error
    }
    expect((thrown as Error).message).toBe('elearning media blob existence check failed')
    expect(String(thrown)).not.toContain(SECRET_BUCKET)
    expect(String(thrown)).not.toContain(SECRET_KEY)
    expect(String(thrown)).not.toContain(SECRET_HOST)
  })

  it('preserves put/get/delete command construction', async () => {
    const commands: unknown[] = []
    const s3 = provider(async (command) => {
      commands.push(command)
      return { Body: { transformToByteArray: async () => new Uint8Array([1, 2]) } }
    })
    await s3.uploadByKey(SECRET_KEY, Buffer.from('x'), 'video/mp4')
    expect(commands[0]).toBeInstanceOf(PutObjectCommand)
    await s3.downloadByKey(SECRET_KEY)
    await s3.deleteByKey(SECRET_KEY)
    expect(commands).toHaveLength(3)
  })

  it('downloadRangeByKey emits GetObject Range bytes=start-end and converts exact/multi-chunk/short bodies', async () => {
    const commands: unknown[] = []
    let transformCalls = 0
    const s3 = provider(async (command) => {
      commands.push(command)
      const range = (command as GetObjectCommand).input.Range
      if (range === 'bytes=3-6') {
        return {
          Body: asyncByteBody(
            [new Uint8Array([3, 4, 5, 6])],
            {
              transformToByteArray: async () => {
                transformCalls += 1
                return new Uint8Array([9, 9, 9, 9])
              },
            },
          ),
        }
      }
      if (range === 'bytes=7-9') {
        return { Body: asyncByteBody([Buffer.from([7]), new Uint8Array([8])]) }
      }
      if (range === 'bytes=4-4') {
        return { Body: asyncByteBody([new Uint8Array([4])]) }
      }
      return { Body: asyncByteBody([]) }
    })
    expect(await s3.downloadRangeByKey(SECRET_KEY, 3, 6)).toEqual(Buffer.from([3, 4, 5, 6]))
    expect(commands).toHaveLength(1)
    expect(commands[0]).toBeInstanceOf(GetObjectCommand)
    const input = (commands[0] as GetObjectCommand).input
    expect(input.Key).toBe(SECRET_KEY)
    expect(input.Range).toBe('bytes=3-6')
    expect(transformCalls).toBe(0)
    expect(await s3.downloadRangeByKey(SECRET_KEY, 7, 9)).toEqual(Buffer.from([7, 8]))
    expect((commands[1] as GetObjectCommand).input.Range).toBe('bytes=7-9')
    expect(await s3.downloadRangeByKey(SECRET_KEY, 4, 4)).toEqual(Buffer.from([4]))
    expect((commands[2] as GetObjectCommand).input.Range).toBe('bytes=4-4')
  })

  it('downloadRangeByKey refuses invalid bounds and foreign keys before I/O or allocation', async () => {
    let calls = 0
    const s3 = provider(async () => {
      calls += 1
      return { Body: asyncByteBody([new Uint8Array([1])]) }
    })
    const alloc = vi.spyOn(Buffer, 'alloc')
    const concat = vi.spyOn(Buffer, 'concat')
    try {
      await expect(s3.downloadRangeByKey(SECRET_KEY, 2, 1)).rejects.toThrow(/invalid|refused/)
      await expect(s3.downloadRangeByKey(SECRET_KEY, -1, 0)).rejects.toThrow(/invalid|refused/)
      await expect(s3.downloadRangeByKey(SECRET_KEY, 0, Number.NaN)).rejects.toThrow(/invalid|refused/)
      await expect(s3.downloadRangeByKey(SECRET_KEY, 0, ELEARNING_MEDIA_RANGE_MAX_BYTES)).rejects.toThrow(/invalid|refused/)
      await expect(s3.downloadRangeByKey(SECRET_KEY, 0, Number.MAX_SAFE_INTEGER)).rejects.toThrow(/invalid|refused/)
      await expect(s3.downloadRangeByKey('uploads/user.mp4', 0, 1)).rejects.toThrow(/outside/)
      expect(calls).toBe(0)
      expect(alloc.mock.calls.some((call) => {
        const size = call[0]
        return typeof size === 'number' && size > ELEARNING_MEDIA_RANGE_MAX_BYTES
      })).toBe(false)
      expect(concat.mock.calls.some((call) => {
        const listed = call[0]
        const total = Array.isArray(listed)
          ? listed.reduce((sum, chunk) => sum + (chunk?.byteLength ?? 0), 0)
          : 0
        const explicit = call[1]
        return total > ELEARNING_MEDIA_RANGE_MAX_BYTES
          || (typeof explicit === 'number' && explicit > ELEARNING_MEDIA_RANGE_MAX_BYTES)
      })).toBe(false)
    } finally {
      alloc.mockRestore()
      concat.mockRestore()
    }
  })

  it('downloadRangeByKey accepts an exact-max inclusive span', async () => {
    const commands: unknown[] = []
    const s3 = provider(async (command) => {
      commands.push(command)
      return { Body: asyncByteBody([new Uint8Array([1])]) }
    })
    expect(await s3.downloadRangeByKey(SECRET_KEY, 0, ELEARNING_MEDIA_RANGE_MAX_BYTES - 1)).toEqual(Buffer.from([1]))
    expect(commands).toHaveLength(1)
    expect((commands[0] as GetObjectCommand).input.Range).toBe(`bytes=0-${ELEARNING_MEDIA_RANGE_MAX_BYTES - 1}`)
  })

  it('downloadRangeByKey refuses an oversized streaming body at the crossing and does not consume later chunks — values-free', async () => {
    const consumed: number[] = []
    const concat = vi.spyOn(Buffer, 'concat')
    const oversized = provider(async () => ({
      Body: trackedAsyncBody(
        [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5]), new Uint8Array([6, 7, 8, 9])],
        consumed,
      ),
    }))
    let thrown: unknown
    try {
      await oversized.downloadRangeByKey(SECRET_KEY, 3, 6)
    } catch (error) {
      thrown = error
    } finally {
      concat.mockRestore()
    }
    expect((thrown as Error).message).toBe('elearning media S3 response body unavailable')
    expect(String(thrown)).not.toContain(SECRET_BUCKET)
    expect(String(thrown)).not.toContain(SECRET_KEY)
    expect(String(thrown)).not.toContain(SECRET_HOST)
    expect(String(thrown)).not.toContain('bytes=3-6')
    expect(consumed).toEqual([0, 1])
    expect(concat).not.toHaveBeenCalled()
  })

  it('downloadRangeByKey refuses a transformToByteArray-only body without invoking it — values-free', async () => {
    let transformCalls = 0
    const transformOnly = provider(async () => ({
      Body: {
        transformToByteArray: async () => {
          transformCalls += 1
          return new Uint8Array(ELEARNING_MEDIA_RANGE_MAX_BYTES + 1)
        },
      },
    }))
    let thrown: unknown
    try {
      await transformOnly.downloadRangeByKey(SECRET_KEY, 4, 4)
    } catch (error) {
      thrown = error
    }
    expect((thrown as Error).message).toBe('elearning media S3 response body unavailable')
    expect(transformCalls).toBe(0)
    expect(String(thrown)).not.toContain(SECRET_BUCKET)
    expect(String(thrown)).not.toContain(SECRET_KEY)
    expect(String(thrown)).not.toContain(SECRET_HOST)
  })

  it('downloadRangeByKey refuses unavailable and malformed streaming bodies values-free', async () => {
    const unavailable = provider(async () => ({}))
    const malformedChunk = provider(async () => ({
      Body: trackedAsyncBody([new Uint8Array([1]), 'not-bytes', new Uint8Array([2])], []),
    }))
    const exploding = provider(async () => ({
      Body: {
        async *[Symbol.asyncIterator]() {
          throw new Error(`body leaked ${SECRET_BUCKET} ${SECRET_HOST} ${SECRET_KEY}`)
        },
      },
    }))
    for (const s3 of [unavailable, malformedChunk, exploding]) {
      let thrown: unknown
      try {
        await s3.downloadRangeByKey(SECRET_KEY, 0, 1)
      } catch (error) {
        thrown = error
      }
      expect((thrown as Error).message).toBe('elearning media S3 response body unavailable')
      expect(String(thrown)).not.toContain(SECRET_BUCKET)
      expect(String(thrown)).not.toContain(SECRET_KEY)
      expect(String(thrown)).not.toContain(SECRET_HOST)
    }
  })
})
