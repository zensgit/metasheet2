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
  APPROVAL_STORAGE_PREFIX,
  type KeyAddressedObjectStore,
  type ListableObjectStore,
} from './approval-attachment-storage'

export interface ApprovalAttachmentS3Config {
  bucket: string
  region: string
  endpoint?: string
  forcePathStyle: boolean
}

export interface S3CommandSender {
  send(command: unknown): Promise<unknown>
}

export interface ApprovalAttachmentS3ListPage {
  blobs: Array<{ key: string; ageMs: number }>
  nextCursor?: string
}

export const APPROVAL_ATTACHMENT_S3_MAX_PAGE_SIZE = 1_000

function readNonblank(env: NodeJS.ProcessEnv, key: string): string | null {
  const value = env[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/** Complete bucket+region configuration is required; partial configuration fails closed. */
export function readApprovalAttachmentS3Config(
  env: NodeJS.ProcessEnv = process.env,
): ApprovalAttachmentS3Config | null {
  const bucket = readNonblank(env, 'APPROVAL_ATTACHMENT_S3_BUCKET')
  const region = readNonblank(env, 'APPROVAL_ATTACHMENT_S3_REGION')
  if (!bucket || !region) return null
  const endpoint = readNonblank(env, 'APPROVAL_ATTACHMENT_S3_ENDPOINT')
  if (endpoint) {
    let parsed: URL
    try {
      parsed = new URL(endpoint)
    } catch {
      // Values-free: never echo the raw endpoint (may carry secrets / hostpaths) into the throw.
      throw new RangeError('approval attachment S3 endpoint is invalid')
    }
    const allowHttp = String(env.APPROVAL_ATTACHMENT_S3_ALLOW_HTTP ?? '').trim().toLowerCase() === 'true'
    if (parsed.protocol !== 'https:' && !(allowHttp && parsed.protocol === 'http:')) {
      throw new RangeError('approval attachment S3 endpoint must use HTTPS')
    }
  }
  return {
    bucket,
    region,
    ...(endpoint ? { endpoint } : {}),
    forcePathStyle: String(env.APPROVAL_ATTACHMENT_S3_FORCE_PATH_STYLE ?? '').trim().toLowerCase() === 'true',
  }
}

function assertApprovalKey(storageKey: string): void {
  if (!storageKey.startsWith(APPROVAL_STORAGE_PREFIX) || storageKey.includes('..') || storageKey.includes('\\')) {
    throw new RangeError('object key outside approval attachment scope')
  }
}

async function responseBodyToBuffer(body: unknown): Promise<Buffer> {
  const candidate = body as { transformToByteArray?: () => Promise<Uint8Array> } | null | undefined
  if (!candidate || typeof candidate.transformToByteArray !== 'function') {
    throw new Error('approval attachment S3 response body unavailable')
  }
  return Buffer.from(await candidate.transformToByteArray())
}

/** Built-in production S3-compatible provider; all operations are key-addressed and prefix-scoped. */
export class ApprovalAttachmentS3Provider implements KeyAddressedObjectStore, ListableObjectStore {
  constructor(
    private readonly config: ApprovalAttachmentS3Config,
    private readonly client: S3CommandSender = new S3Client({
      region: config.region,
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      forcePathStyle: config.forcePathStyle,
    } satisfies S3ClientConfig) as unknown as S3CommandSender,
  ) {}

  async uploadByKey(storageKey: string, content: Buffer, contentType?: string): Promise<void> {
    assertApprovalKey(storageKey)
    await this.client.send(new PutObjectCommand({
      Bucket: this.config.bucket,
      Key: storageKey,
      Body: content,
      ...(contentType ? { ContentType: contentType } : {}),
      IfNoneMatch: '*',
    }))
  }

  async downloadByKey(storageKey: string): Promise<Buffer> {
    assertApprovalKey(storageKey)
    const response = await this.client.send(new GetObjectCommand({
      Bucket: this.config.bucket,
      Key: storageKey,
    })) as { Body?: unknown }
    return responseBodyToBuffer(response.Body)
  }

  async deleteByKey(storageKey: string): Promise<void> {
    assertApprovalKey(storageKey)
    await this.client.send(new DeleteObjectCommand({
      Bucket: this.config.bucket,
      Key: storageKey,
    }))
  }

  /** One bounded S3 LIST request. The continuation token stays opaque to callers. */
  async listApprovalBlobsPage(
    cursor: string | undefined,
    limit: number,
    now: () => number = Date.now,
  ): Promise<ApprovalAttachmentS3ListPage> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > APPROVAL_ATTACHMENT_S3_MAX_PAGE_SIZE) {
      throw new RangeError(`approval attachment S3 page size must be in [1, ${APPROVAL_ATTACHMENT_S3_MAX_PAGE_SIZE}]`)
    }
    const response = await this.client.send(new ListObjectsV2Command({
      Bucket: this.config.bucket,
      Prefix: APPROVAL_STORAGE_PREFIX,
      MaxKeys: limit,
      ...(cursor ? { ContinuationToken: cursor } : {}),
    })) as {
      Contents?: Array<{ Key?: string; LastModified?: Date }>
      IsTruncated?: boolean
      NextContinuationToken?: string
    }
    const blobs: Array<{ key: string; ageMs: number }> = []
    for (const object of response.Contents ?? []) {
      if (!object.Key || !object.LastModified) continue
      assertApprovalKey(object.Key)
      blobs.push({ key: object.Key, ageMs: Math.max(0, now() - object.LastModified.getTime()) })
    }
    if (response.IsTruncated && !response.NextContinuationToken) {
      throw new Error('approval attachment S3 listing truncated without continuation token')
    }
    return {
      blobs,
      ...(response.IsTruncated ? { nextCursor: response.NextContinuationToken } : {}),
    }
  }

  /** Metadata-only existence check used by the bounded DB-side reconciliation page. */
  async hasApprovalBlob(storageKey: string): Promise<boolean> {
    assertApprovalKey(storageKey)
    try {
      await this.client.send(new HeadObjectCommand({
        Bucket: this.config.bucket,
        Key: storageKey,
      }))
      return true
    } catch (error) {
      const candidate = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } } | null
      const status = candidate?.$metadata?.httpStatusCode
      if (status === 404 || candidate?.name === 'NotFound' || candidate?.name === 'NoSuchKey') return false
      throw error
    }
  }

  async listApprovalBlobs(now: () => number = Date.now): Promise<Array<{ key: string; ageMs: number }>> {
    const blobs: Array<{ key: string; ageMs: number }> = []
    let continuationToken: string | undefined
    do {
      const page = await this.listApprovalBlobsPage(
        continuationToken,
        APPROVAL_ATTACHMENT_S3_MAX_PAGE_SIZE,
        now,
      )
      blobs.push(...page.blobs)
      continuationToken = page.nextCursor
    } while (continuationToken)
    return blobs
  }
}

export function createApprovalAttachmentS3Provider(
  env: NodeJS.ProcessEnv = process.env,
  sender?: S3CommandSender,
): ApprovalAttachmentS3Provider | null {
  const config = readApprovalAttachmentS3Config(env)
  return config ? new ApprovalAttachmentS3Provider(config, sender) : null
}
