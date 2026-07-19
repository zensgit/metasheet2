/**
 * S3 store — put/get/delete by key; delete returns false ONLY for proven 404/NoSuchKey.
 */
import { describe, expect, test, vi } from 'vitest'

import {
  ApprovalAttachmentStorageError,
  isProvenNotFound,
  S3ApprovalAttachmentStore,
} from '../../src/services/approval-attachment-s3-store'

function fakeClient(handlers: {
  head?: () => Promise<unknown>
  put?: () => Promise<unknown>
  get?: () => Promise<{ Body: Buffer }>
  del?: () => Promise<unknown>
  list?: () => Promise<{ Contents?: Array<{ Key?: string; LastModified?: Date }>; IsTruncated?: boolean }>
}) {
  return {
    send: async (cmd: { constructor: { name: string } }) => {
      const name = cmd.constructor.name
      if (name === 'HeadObjectCommand') {
        if (handlers.head) return handlers.head()
        const err = new Error('not found') as Error & { name: string }
        err.name = 'NotFound'
        throw err
      }
      if (name === 'PutObjectCommand') return handlers.put?.() ?? {}
      if (name === 'GetObjectCommand') return handlers.get?.() ?? { Body: Buffer.from('x') }
      if (name === 'DeleteObjectCommand') return handlers.del?.() ?? {}
      if (name === 'ListObjectsV2Command') return handlers.list?.() ?? { Contents: [], IsTruncated: false }
      throw new Error(`unexpected command ${name}`)
    },
  }
}

const KEY = 'approval/2026-07/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.pdf'

describe('S3ApprovalAttachmentStore', () => {
  test('put/get by key; outside prefix refused', async () => {
    const put = vi.fn(async () => ({}))
    const store = new S3ApprovalAttachmentStore({
      bucket: 'b',
      client: fakeClient({
        put,
        get: async () => ({ Body: Buffer.from('hello') }),
        head: async () => {
          const err = new Error('nf') as Error & { name: string }
          err.name = 'NotFound'
          throw err
        },
      }) as never,
    })
    await store.put(KEY, Buffer.from('hello'))
    expect(put).toHaveBeenCalled()
    expect((await store.get(KEY)).toString()).toBe('hello')
    await expect(store.put('other/x.pdf', Buffer.from('x'))).rejects.toBeInstanceOf(ApprovalAttachmentStorageError)
  })

  test('delete: proven NotFound/NoSuchKey/404 → false; AccessDenied/500/network throw values-free', async () => {
    // 404 → false
    const missing = new S3ApprovalAttachmentStore({
      bucket: 'b',
      client: fakeClient({
        head: async () => {
          const err = new Error('nf') as Error & { name: string }
          err.name = 'NoSuchKey'
          throw err
        },
      }) as never,
    })
    expect(await missing.delete(KEY)).toBe(false)

    // http 404 metadata → false
    const missing404 = new S3ApprovalAttachmentStore({
      bucket: 'b',
      client: fakeClient({
        head: async () => {
          const err = new Error('gone') as Error & { $metadata: { httpStatusCode: number } }
          err.$metadata = { httpStatusCode: 404 }
          throw err
        },
      }) as never,
    })
    expect(await missing404.delete(KEY)).toBe(false)

    // AccessDenied → throw storage_unavailable (NOT false)
    const denied = new S3ApprovalAttachmentStore({
      bucket: 'b',
      client: fakeClient({
        head: async () => {
          const err = new Error('AccessDenied: secret-bucket') as Error & { name: string }
          err.name = 'AccessDenied'
          throw err
        },
      }) as never,
    })
    await expect(denied.delete(KEY)).rejects.toMatchObject({ code: 'storage_unavailable' })

    // 500 → throw
    const serverErr = new S3ApprovalAttachmentStore({
      bucket: 'b',
      client: fakeClient({
        head: async () => {
          const err = new Error('boom') as Error & { $metadata: { httpStatusCode: number } }
          err.$metadata = { httpStatusCode: 500 }
          throw err
        },
      }) as never,
    })
    await expect(serverErr.delete(KEY)).rejects.toMatchObject({ code: 'storage_unavailable' })

    // network-ish throw without name → throw
    const net = new S3ApprovalAttachmentStore({
      bucket: 'b',
      client: fakeClient({
        head: async () => {
          throw new Error('ECONNRESET')
        },
      }) as never,
    })
    await expect(net.delete(KEY)).rejects.toMatchObject({ code: 'storage_unavailable' })

    // present → true
    const ok = new S3ApprovalAttachmentStore({
      bucket: 'b',
      client: fakeClient({
        head: async () => ({}),
        del: async () => ({}),
      }) as never,
    })
    expect(await ok.delete(KEY)).toBe(true)
  })

  test('isProvenNotFound: only NotFound/NoSuchKey/404', () => {
    expect(isProvenNotFound({ name: 'NotFound' })).toBe(true)
    expect(isProvenNotFound({ name: 'NoSuchKey' })).toBe(true)
    expect(isProvenNotFound({ $metadata: { httpStatusCode: 404 } })).toBe(true)
    expect(isProvenNotFound({ name: 'AccessDenied' })).toBe(false)
    expect(isProvenNotFound({ $metadata: { httpStatusCode: 500 } })).toBe(false)
    expect(isProvenNotFound(new Error('timeout'))).toBe(false)
  })
})
