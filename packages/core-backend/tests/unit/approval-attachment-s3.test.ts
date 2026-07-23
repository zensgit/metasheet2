import { HeadObjectCommand } from '@aws-sdk/client-s3'
import { describe, expect, it } from 'vitest'

import {
  ApprovalAttachmentS3Provider,
  createApprovalAttachmentS3Provider,
  readApprovalAttachmentS3Config,
  type S3CommandSender,
} from '../../src/services/approval-attachment-s3'

describe('approval attachment built-in S3 provider', () => {
  it('requires complete bucket+region config and HTTPS unless HTTP is explicitly enabled', () => {
    expect(readApprovalAttachmentS3Config({} as NodeJS.ProcessEnv)).toBeNull()
    expect(readApprovalAttachmentS3Config({ APPROVAL_ATTACHMENT_S3_BUCKET: 'bucket' } as NodeJS.ProcessEnv)).toBeNull()
    expect(() => readApprovalAttachmentS3Config({
      APPROVAL_ATTACHMENT_S3_BUCKET: 'bucket',
      APPROVAL_ATTACHMENT_S3_REGION: 'us-east-1',
      APPROVAL_ATTACHMENT_S3_ENDPOINT: 'http://minio.internal:9000',
    } as NodeJS.ProcessEnv)).toThrow(/HTTPS/)
    expect(readApprovalAttachmentS3Config({
      APPROVAL_ATTACHMENT_S3_BUCKET: 'bucket',
      APPROVAL_ATTACHMENT_S3_REGION: 'us-east-1',
      APPROVAL_ATTACHMENT_S3_ENDPOINT: 'http://minio.internal:9000',
      APPROVAL_ATTACHMENT_S3_ALLOW_HTTP: 'true',
      APPROVAL_ATTACHMENT_S3_FORCE_PATH_STYLE: 'true',
    } as NodeJS.ProcessEnv)).toMatchObject({ bucket: 'bucket', forcePathStyle: true })
  })

  it('malformed S3 endpoint fails values-free — raw secret-looking value never appears in the throw', () => {
    const SECRET_ENDPOINT = 'not a url://AKIASECRET999/user:p@ss@evil-host/path'
    let thrown: unknown
    try {
      readApprovalAttachmentS3Config({
        APPROVAL_ATTACHMENT_S3_BUCKET: 'bucket',
        APPROVAL_ATTACHMENT_S3_REGION: 'us-east-1',
        APPROVAL_ATTACHMENT_S3_ENDPOINT: SECRET_ENDPOINT,
      } as NodeJS.ProcessEnv)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(RangeError)
    expect((thrown as Error).message).toBe('approval attachment S3 endpoint is invalid')
    expect((thrown as Error).message).not.toContain('AKIASECRET999')
    expect((thrown as Error).message).not.toContain('p@ss')
    expect((thrown as Error).message).not.toContain(SECRET_ENDPOINT)
    expect(String(thrown)).not.toContain('AKIASECRET999')
  })

  it('uses conditional put/get/delete and one bounded S3 request per listing page', async () => {
    const calls: Array<{ name: string; input: Record<string, unknown> }> = []
    let listPage = 0
    const sender: S3CommandSender = {
      send: async (command) => {
        const typed = command as { constructor: { name: string }; input: Record<string, unknown> }
        calls.push({ name: typed.constructor.name, input: typed.input })
        if (typed.constructor.name === 'GetObjectCommand') {
          return { Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) } }
        }
        if (typed.constructor.name === 'ListObjectsV2Command') {
          listPage += 1
          return listPage === 1
            ? {
                Contents: [{ Key: 'approval-attachments/2026-07/a.pdf', LastModified: new Date(900) }],
                IsTruncated: true,
                NextContinuationToken: 'next',
              }
            : { Contents: [], IsTruncated: false }
        }
        if (typed.constructor.name === 'HeadObjectCommand' && typed.input.Key === 'approval-attachments/missing') {
          throw Object.assign(new Error('not found'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } })
        }
        return {}
      },
    }
    const provider = new ApprovalAttachmentS3Provider({
      bucket: 'private-bucket',
      region: 'us-east-1',
      forcePathStyle: false,
    }, sender)
    const key = 'approval-attachments/2026-07/a.pdf'

    await provider.uploadByKey(key, Buffer.from('%PDF'), 'application/pdf')
    expect(await provider.downloadByKey(key)).toEqual(Buffer.from([1, 2, 3]))
    await provider.deleteByKey(key)
    const firstPage = await provider.listApprovalBlobsPage(undefined, 1, () => 1000)
    expect(firstPage).toEqual({ blobs: [{ key, ageMs: 100 }], nextCursor: 'next' })
    expect(calls.filter((call) => call.name === 'ListObjectsV2Command')).toHaveLength(1)
    const secondPage = await provider.listApprovalBlobsPage(firstPage.nextCursor, 1, () => 1000)
    expect(secondPage).toEqual({ blobs: [] })
    expect(await provider.hasApprovalBlob(key)).toBe(true)
    expect(await provider.hasApprovalBlob('approval-attachments/missing')).toBe(false)

    expect(calls[0]).toMatchObject({
      name: 'PutObjectCommand',
      input: { Bucket: 'private-bucket', Key: key, IfNoneMatch: '*', ContentType: 'application/pdf' },
    })
    expect(calls.filter((call) => call.name === 'ListObjectsV2Command')).toHaveLength(2)
    const listCalls = calls.filter((call) => call.name === 'ListObjectsV2Command')
    expect(listCalls[0].input).toMatchObject({ Prefix: 'approval-attachments/', MaxKeys: 1 })
    expect(listCalls[1].input).toMatchObject({ Prefix: 'approval-attachments/', MaxKeys: 1, ContinuationToken: 'next' })
    expect(calls.filter((call) => call.name === HeadObjectCommand.name)).toHaveLength(2)
  })

  it('rejects oversized pages and truncated responses without a continuation token', async () => {
    const provider = new ApprovalAttachmentS3Provider({
      bucket: 'private-bucket',
      region: 'us-east-1',
      forcePathStyle: false,
    }, { send: async () => ({ IsTruncated: true }) })
    await expect(provider.listApprovalBlobsPage(undefined, 1_001)).rejects.toThrow(/page size/)
    await expect(provider.listApprovalBlobsPage(undefined, 1)).rejects.toThrow(/continuation token/)
  })

  it('refuses keys outside the approval prefix before the SDK is called', async () => {
    let calls = 0
    const provider = new ApprovalAttachmentS3Provider({
      bucket: 'private-bucket',
      region: 'us-east-1',
      forcePathStyle: false,
    }, { send: async () => { calls += 1; return {} } })
    await expect(provider.uploadByKey('other/x.pdf', Buffer.from('x'))).rejects.toThrow(/outside/)
    await expect(provider.downloadByKey('approval-attachments/../x.pdf')).rejects.toThrow(/outside/)
    expect(calls).toBe(0)
  })

  it('constructs the production provider only from complete configuration', () => {
    const sender: S3CommandSender = { send: async () => ({}) }
    expect(createApprovalAttachmentS3Provider({ NODE_ENV: 'production' } as NodeJS.ProcessEnv, sender)).toBeNull()
    expect(createApprovalAttachmentS3Provider({
      APPROVAL_ATTACHMENT_S3_BUCKET: 'bucket',
      APPROVAL_ATTACHMENT_S3_REGION: 'us-east-1',
    } as NodeJS.ProcessEnv, sender)).toBeInstanceOf(ApprovalAttachmentS3Provider)
  })
})
