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
  assertElearningMediaListLimit,
  assertElearningMediaStorageKey,
  ELEARNING_MEDIA_STORAGE_PREFIX,
  nonnegativeAgeMs,
  type ElearningMediaBlobPage,
  type ElearningMediaBlobRef,
  type KeyAddressedElearningObjectStore,
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

async function responseBodyToBuffer(body: unknown): Promise<Buffer> {
  const candidate = body as { transformToByteArray?: () => Promise<Uint8Array> } | null | undefined
  if (!candidate || typeof candidate.transformToByteArray !== 'function') {
    throw new Error('elearning media S3 response body unavailable')
  }
  return Buffer.from(await candidate.transformToByteArray())
}

export class ElearningMediaS3Provider implements KeyAddressedElearningObjectStore {
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
