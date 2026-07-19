/**
 * S3-compatible object-store adapter for approval attachments (design-lock O3 / §7).
 *
 * Implements `ApprovalAttachmentStore` (+ optional `list` for the prefix-scoped reconciler) with
 * deterministic server keys and cross-process get/delete by key. Credentials, endpoints, bucket
 * names, object keys, filenames, and raw provider errors are NEVER logged from this module.
 *
 * Production with `APPROVAL_ATTACHMENTS_ENABLED=true` MUST use this (or another non-local)
 * provider — local FS is refuse-closed in production (503). Dev/test may use LocalFs.
 */
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3'

import type { ApprovalAttachmentStore, ApprovalAttachmentStoreListable } from './approval-attachment-storage'
import type { ReconcilerBlob } from './approval-attachment-reconciler'

/** Values-free error — never carries provider message, key, or credentials. */
export class ApprovalAttachmentStorageError extends Error {
  readonly code: string
  constructor(code: string) {
    super(code)
    this.name = 'ApprovalAttachmentStorageError'
    this.code = code
  }
}

export interface S3ApprovalAttachmentStoreConfig {
  bucket: string
  region?: string
  /** Optional S3-compatible endpoint (MinIO, etc.). Never logged. */
  endpoint?: string
  forcePathStyle?: boolean
  /** Prefix every approval object lives under — reconciler is confined to this partition. */
  keyPrefix?: string
  /** Injected client for tests; production builds one from env. */
  client?: S3Client
  credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string }
}

const DEFAULT_PREFIX = 'approval/'

function assertSafeKey(storageKey: string, prefix: string): void {
  if (typeof storageKey !== 'string' || storageKey.trim() === '' || storageKey.includes('\0')) {
    throw new ApprovalAttachmentStorageError('invalid_storage_key')
  }
  if (storageKey.includes('..') || storageKey.startsWith('/')) {
    throw new ApprovalAttachmentStorageError('invalid_storage_key')
  }
  if (!storageKey.startsWith(prefix)) {
    throw new ApprovalAttachmentStorageError('key_outside_prefix')
  }
}

async function streamToBuffer(body: unknown): Promise<Buffer> {
  if (!body) throw new ApprovalAttachmentStorageError('empty_body')
  if (Buffer.isBuffer(body)) return body
  if (body instanceof Uint8Array) return Buffer.from(body)
  // AWS SDK v3 body is a Readable / ReadableStream-like async iterable
  if (typeof (body as { transformToByteArray?: () => Promise<Uint8Array> }).transformToByteArray === 'function') {
    const bytes = await (body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray()
    return Buffer.from(bytes)
  }
  const chunks: Buffer[] = []
  for await (const chunk of body as AsyncIterable<Uint8Array | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

/**
 * S3-compatible store. put refuses overwrite (HeadObject first — mirrors local `wx` semantics).
 * delete is idempotent (missing → false). list is prefix-scoped to approval keys only.
 */
export class S3ApprovalAttachmentStore implements ApprovalAttachmentStore, ApprovalAttachmentStoreListable {
  private readonly client: S3Client
  private readonly bucket: string
  private readonly keyPrefix: string

  constructor(config: S3ApprovalAttachmentStoreConfig) {
    if (!config.bucket || !/[!-~]/.test(config.bucket)) {
      throw new ApprovalAttachmentStorageError('misconfigured')
    }
    this.bucket = config.bucket
    this.keyPrefix = config.keyPrefix ?? DEFAULT_PREFIX
    if (config.client) {
      this.client = config.client
      return
    }
    const s3Config: S3ClientConfig = {
      region: config.region || 'us-east-1',
    }
    if (config.endpoint) {
      s3Config.endpoint = config.endpoint
      s3Config.forcePathStyle = config.forcePathStyle ?? true
    }
    if (config.credentials) {
      s3Config.credentials = config.credentials
    }
    this.client = new S3Client(s3Config)
  }

  async put(storageKey: string, content: Buffer): Promise<void> {
    assertSafeKey(storageKey, this.keyPrefix)
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: storageKey }))
      // object already exists — refuse overwrite (keys are unique by construction; collision is a bug)
      throw new ApprovalAttachmentStorageError('key_exists')
    } catch (err) {
      if (err instanceof ApprovalAttachmentStorageError) throw err
      const code = (err as { name?: string; $metadata?: { httpStatusCode?: number } })?.name
        ?? String((err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode ?? '')
      if (code !== 'NotFound' && code !== '404' && code !== 'NoSuchKey') {
        // Head failed for a non-not-found reason — treat as misconfigured/unavailable, values-free
        throw new ApprovalAttachmentStorageError('storage_unavailable')
      }
    }
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: storageKey,
          Body: content,
          ContentLength: content.length,
        }),
      )
    } catch {
      throw new ApprovalAttachmentStorageError('storage_unavailable')
    }
  }

  async get(storageKey: string): Promise<Buffer> {
    assertSafeKey(storageKey, this.keyPrefix)
    try {
      const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: storageKey }))
      return streamToBuffer(out.Body)
    } catch {
      throw new ApprovalAttachmentStorageError('not_found')
    }
  }

  async delete(storageKey: string): Promise<boolean> {
    assertSafeKey(storageKey, this.keyPrefix)
    try {
      // Probe existence so we can return false for missing (idempotent contract matches LocalFs).
      try {
        await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: storageKey }))
      } catch (err) {
        const code = (err as { name?: string })?.name
        if (code === 'NotFound' || code === 'NoSuchKey') return false
        // Some S3-compat stacks use 404 without NotFound name — treat any head failure as gone.
        return false
      }
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: storageKey }))
      return true
    } catch {
      throw new ApprovalAttachmentStorageError('storage_unavailable')
    }
  }

  /** Prefix-scoped listing for the bucket reconciler (G15). Never lists outside `keyPrefix`. */
  async list(): Promise<ReconcilerBlob[]> {
    const out: ReconcilerBlob[] = []
    let token: string | undefined
    const now = Date.now()
    try {
      do {
        const page = await this.client.send(
          new ListObjectsV2Command({
            Bucket: this.bucket,
            Prefix: this.keyPrefix,
            ContinuationToken: token,
          }),
        )
        for (const obj of page.Contents ?? []) {
          if (!obj.Key || !obj.Key.startsWith(this.keyPrefix)) continue
          const ageMs = obj.LastModified ? Math.max(0, now - obj.LastModified.getTime()) : Number.MAX_SAFE_INTEGER
          out.push({ key: obj.Key, ageMs })
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined
      } while (token)
    } catch {
      throw new ApprovalAttachmentStorageError('storage_unavailable')
    }
    return out
  }
}
