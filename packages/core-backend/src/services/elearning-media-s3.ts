import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3'

import {
  assertElearningMediaByteRange,
  assertElearningMediaListLimit,
  assertElearningMediaStorageKey,
  ELEARNING_MEDIA_RANGE_MAX_BYTES,
  ELEARNING_MEDIA_STORAGE_PREFIX,
  nonnegativeAgeMs,
  type ElearningMediaBlobPage,
  type ElearningMediaBlobRef,
  type KeyAddressedElearningObjectStore,
  type KeyAddressedElearningRangeObjectStore,
} from './elearning-media-storage'

export interface ElearningMediaS3Config {
  bucket: string
  region: string
  endpoint?: string
  forcePathStyle: boolean
}

export interface ElearningMediaS3CommandSender {
  send(command: unknown): Promise<unknown>
}

function readNonblank(env: NodeJS.ProcessEnv, key: string): string | null {
  const value = env[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/**
 * Complete bucket+region is required. Optional endpoint must be HTTPS (no HTTP fallback).
 * Path-style is exact-literal 'true' only.
 */
export function readElearningMediaS3Config(
  env: NodeJS.ProcessEnv = process.env,
): ElearningMediaS3Config | null {
  const bucket = readNonblank(env, 'ELEARNING_MEDIA_S3_BUCKET')
  const region = readNonblank(env, 'ELEARNING_MEDIA_S3_REGION')
  if (!bucket || !region) return null
  const endpoint = readNonblank(env, 'ELEARNING_MEDIA_S3_ENDPOINT')
  if (endpoint) {
    let parsed: URL
    try {
      parsed = new URL(endpoint)
    } catch {
      throw new RangeError('elearning media S3 endpoint is invalid')
    }
    if (parsed.protocol !== 'https:') {
      throw new RangeError('elearning media S3 endpoint must use HTTPS')
    }
  }
  return {
    bucket,
    region,
    ...(endpoint ? { endpoint } : {}),
    forcePathStyle: env.ELEARNING_MEDIA_S3_FORCE_PATH_STYLE === 'true',
  }
}

const ELEARNING_MEDIA_S3_BODY_UNAVAILABLE = 'elearning media S3 response body unavailable'

function throwS3BodyUnavailable(): never {
  throw new Error(ELEARNING_MEDIA_S3_BODY_UNAVAILABLE)
}

function isS3BodyUnavailable(err: unknown): boolean {
  return err instanceof Error && err.message === ELEARNING_MEDIA_S3_BODY_UNAVAILABLE
}

async function responseBodyToBuffer(body: unknown): Promise<Buffer> {
  const candidate = body as { transformToByteArray?: unknown } | null | undefined
  if (!candidate || typeof candidate.transformToByteArray !== 'function') {
    throwS3BodyUnavailable()
  }
  try {
    const bytes = await candidate.transformToByteArray()
    if (!(bytes instanceof Uint8Array)) {
      throwS3BodyUnavailable()
    }
    return Buffer.from(bytes)
  } catch (err) {
    if (isS3BodyUnavailable(err)) throw err
    throwS3BodyUnavailable()
  }
}

/** Range bodies are consumed as async byte chunks. transformToByteArray is never invoked. */
async function boundedS3RangeBodyToBuffer(body: unknown, maxBytes: number): Promise<Buffer> {
  if (body == null || typeof body !== 'object') {
    throwS3BodyUnavailable()
  }
  const getIterator = (body as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator]
  if (typeof getIterator !== 'function') {
    throwS3BodyUnavailable()
  }
  let iterator: AsyncIterator<unknown>
  try {
    iterator = (getIterator as (this: unknown) => AsyncIterator<unknown>).call(body)
  } catch {
    throwS3BodyUnavailable()
  }
  if (iterator == null || typeof iterator.next !== 'function') {
    throwS3BodyUnavailable()
  }
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const step = await iterator.next()
      if (step.done) break
      const chunk = step.value
      if (!(chunk instanceof Uint8Array)) {
        throwS3BodyUnavailable()
      }
      const chunkLen = chunk.byteLength
      if (!Number.isSafeInteger(chunkLen) || chunkLen < 0 || chunkLen > maxBytes - total) {
        throwS3BodyUnavailable()
      }
      total += chunkLen
      chunks.push(chunk)
    }
  } catch (err) {
    try {
      await iterator.return?.()
    } catch {
      // ignore abort failures; the values-free unavailable error is authoritative
    }
    if (isS3BodyUnavailable(err)) throw err
    throwS3BodyUnavailable()
  }
  return Buffer.concat(chunks, total)
}

export class ElearningMediaS3Provider implements KeyAddressedElearningObjectStore, KeyAddressedElearningRangeObjectStore {
  constructor(
    private readonly config: ElearningMediaS3Config,
    private readonly client: ElearningMediaS3CommandSender = new S3Client({
      region: config.region,
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      forcePathStyle: config.forcePathStyle,
    } satisfies S3ClientConfig) as unknown as ElearningMediaS3CommandSender,
  ) {}

  async uploadByKey(storageKey: string, content: Buffer, contentType?: string): Promise<void> {
    assertElearningMediaStorageKey(storageKey)
    await this.client.send(new PutObjectCommand({
      Bucket: this.config.bucket,
      Key: storageKey,
      Body: content,
      ...(contentType ? { ContentType: contentType } : {}),
      IfNoneMatch: '*',
    }))
  }

  async downloadByKey(storageKey: string): Promise<Buffer> {
    assertElearningMediaStorageKey(storageKey)
    const response = await this.client.send(new GetObjectCommand({
      Bucket: this.config.bucket,
      Key: storageKey,
    })) as { Body?: unknown }
    return responseBodyToBuffer(response.Body)
  }

  async downloadRangeByKey(storageKey: string, start: number, end: number): Promise<Buffer> {
    const range = assertElearningMediaByteRange(start, end)
    assertElearningMediaStorageKey(storageKey)
    const span = range.end - range.start + 1
    const maxBytes = Math.min(span, ELEARNING_MEDIA_RANGE_MAX_BYTES)
    const response = await this.client.send(new GetObjectCommand({
      Bucket: this.config.bucket,
      Key: storageKey,
      Range: `bytes=${range.start}-${range.end}`,
    })) as { Body?: unknown }
    return boundedS3RangeBodyToBuffer(response.Body, maxBytes)
  }

  async deleteByKey(storageKey: string): Promise<void> {
    assertElearningMediaStorageKey(storageKey)
    await this.client.send(new DeleteObjectCommand({
      Bucket: this.config.bucket,
      Key: storageKey,
    }))
  }

  async hasMediaBlob(storageKey: string): Promise<boolean> {
    assertElearningMediaStorageKey(storageKey)
    try {
      await this.client.send(new HeadObjectCommand({
        Bucket: this.config.bucket,
        Key: storageKey,
      }))
      return true
    } catch (err) {
      if (isS3MissingObject(err)) return false
      throw new Error('elearning media blob existence check failed')
    }
  }

  async listMediaBlobsPage(
    cursor: string | undefined,
    limit: number,
    now: Date = new Date(),
  ): Promise<ElearningMediaBlobPage> {
    assertElearningMediaListLimit(limit)
    const continuationToken = normalizeS3ContinuationToken(cursor)
    let response: S3ListObjectsV2Response
    try {
      response = await this.client.send(new ListObjectsV2Command({
        Bucket: this.config.bucket,
        Prefix: ELEARNING_MEDIA_STORAGE_PREFIX,
        MaxKeys: limit,
        ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
      })) as S3ListObjectsV2Response
    } catch {
      throw new Error('elearning media listing failed')
    }
    const contents = Array.isArray(response.Contents) ? response.Contents : []
    if (contents.length > limit) {
      throw new RangeError('elearning media listing exceeded the requested page bound')
    }
    const blobs: ElearningMediaBlobRef[] = []
    for (const object of contents) {
      const key = object.Key
      if (typeof key !== 'string') {
        throw new RangeError('storage key is outside the elearning media scope — refused')
      }
      if (key.endsWith('/')) continue
      assertElearningMediaStorageKey(key)
      const lastModified = object.LastModified
      const ageMs = lastModified instanceof Date && !Number.isNaN(lastModified.getTime())
        ? nonnegativeAgeMs(lastModified.getTime(), now)
        : nonnegativeAgeMs(now.getTime(), now)
      blobs.push({ key, ageMs })
    }
    if (response.IsTruncated) {
      const nextCursor = response.NextContinuationToken
      if (typeof nextCursor !== 'string' || nextCursor === '') {
        throw new Error('elearning media listing is truncated without a continuation token')
      }
      return { blobs, nextCursor }
    }
    return { blobs }
  }
}

export function createElearningMediaS3Provider(
  env: NodeJS.ProcessEnv = process.env,
  sender?: ElearningMediaS3CommandSender,
): ElearningMediaS3Provider | null {
  const config = readElearningMediaS3Config(env)
  return config
    ? new ElearningMediaS3Provider(config, sender)
    : null
}

interface S3ListObjectsV2Response {
  Contents?: Array<{ Key?: string; LastModified?: Date }>
  IsTruncated?: boolean
  NextContinuationToken?: string
}

function normalizeS3ContinuationToken(cursor: string | undefined): string | undefined {
  if (cursor === undefined || cursor === '') return undefined
  return cursor
}

function isS3MissingObject(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const rec = err as {
    name?: unknown
    Code?: unknown
    code?: unknown
    $metadata?: { httpStatusCode?: unknown }
  }
  if (rec.$metadata?.httpStatusCode === 404) return true
  for (const field of [rec.name, rec.Code, rec.code]) {
    if (field === 'NotFound' || field === 'NoSuchKey') return true
  }
  return false
}
