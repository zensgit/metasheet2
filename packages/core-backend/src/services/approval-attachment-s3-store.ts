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

/** True only for a proven missing object — never for AccessDenied / 5xx / network. */
export function isProvenNotFound(err: unknown): boolean {
  const e = err as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number }; code?: string } | null
  if (!e) return false
  const name = e.name ?? e.Code ?? e.code ?? ''
  if (name === 'NotFound' || name === 'NoSuchKey' || name === 'NotFoundError') return true
  if (e.$metadata?.httpStatusCode === 404) return true
  return false
}

/** Ratified O1 per-file cap — reject oversized GetObject bodies (defense in depth under route multer). */
export const APPROVAL_ATTACHMENT_MAX_GET_BYTES = 20 * 1024 * 1024

/**
 * Accumulate a GetObject body with a hard byte cap. Throws `storage_unavailable` (values-free)
 * if ContentLength or accumulated bytes exceed the ratified 20 MiB cap.
 *
 * **Iteration order is load-bearing for the memory guard:** whenever the body exposes
 * `Symbol.asyncIterator`, prefer bounded async chunk accumulation so a hostile oversized
 * object is rejected without buffering the whole payload first. Real AWS SDK v3 bodies
 * expose BOTH `transformToByteArray` and async iteration — calling transform first would
 * materialize the entire object and make the cap vacuous.
 *
 * `transformToByteArray` is used only when the body is NOT async-iterable (and ContentLength
 * has already been checked as a precondition).
 */
export async function streamToBufferCapped(
  body: unknown,
  maxBytes: number = APPROVAL_ATTACHMENT_MAX_GET_BYTES,
  contentLength?: number | null,
): Promise<Buffer> {
  if (typeof contentLength === 'number' && Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new ApprovalAttachmentStorageError('storage_unavailable')
  }
  if (!body) throw new ApprovalAttachmentStorageError('empty_body')
  if (Buffer.isBuffer(body)) {
    if (body.length > maxBytes) throw new ApprovalAttachmentStorageError('storage_unavailable')
    return body
  }
  if (body instanceof Uint8Array) {
    if (body.byteLength > maxBytes) throw new ApprovalAttachmentStorageError('storage_unavailable')
    return Buffer.from(body)
  }
  // Prefer bounded async iteration when available (AWS SDK Readable bodies are async-iterable).
  const asyncIterable = body as { [Symbol.asyncIterator]?: () => AsyncIterator<Uint8Array | string> }
  if (typeof asyncIterable[Symbol.asyncIterator] === 'function') {
    const chunks: Buffer[] = []
    let total = 0
    for await (const chunk of body as AsyncIterable<Uint8Array | string>) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      total += buf.length
      if (total > maxBytes) throw new ApprovalAttachmentStorageError('storage_unavailable')
      chunks.push(buf)
    }
    return Buffer.concat(chunks)
  }
  // Non-iterable fallback: transformToByteArray only when ContentLength was already checked above
  // (or is unknown — still reject if the fully-buffered result exceeds the cap).
  if (typeof (body as { transformToByteArray?: () => Promise<Uint8Array> }).transformToByteArray === 'function') {
    const bytes = await (body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray()
    if (bytes.byteLength > maxBytes) throw new ApprovalAttachmentStorageError('storage_unavailable')
    return Buffer.from(bytes)
  }
  throw new ApprovalAttachmentStorageError('storage_unavailable')
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
      return await streamToBufferCapped(out.Body, APPROVAL_ATTACHMENT_MAX_GET_BYTES, out.ContentLength)
    } catch (err) {
      if (err instanceof ApprovalAttachmentStorageError) throw err
      // Proven missing only → not_found; AccessDenied / 5xx / network → storage_unavailable
      // so callers never treat infra denial as a soft 404 oracle.
      if (isProvenNotFound(err)) throw new ApprovalAttachmentStorageError('not_found')
      throw new ApprovalAttachmentStorageError('storage_unavailable')
    }
  }

  async delete(storageKey: string): Promise<boolean> {
    assertSafeKey(storageKey, this.keyPrefix)
    // Probe existence: return false ONLY for a proven 404/NoSuchKey. AccessDenied / 5xx /
    // network / timeout MUST throw so the purge worker retries / dead-letters instead of
    // marking done and permanently leaking the blob.
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: storageKey }))
    } catch (err) {
      if (isProvenNotFound(err)) return false
      throw new ApprovalAttachmentStorageError('storage_unavailable')
    }
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: storageKey }))
      return true
    } catch (err) {
      // DeleteObject on an already-gone key is also terminal-success on some stacks.
      if (isProvenNotFound(err)) return false
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
