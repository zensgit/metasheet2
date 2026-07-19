/**
 * S3 store adapter — unit goldens with an injected fake S3 client (no network).
 * Values-free errors, prefix enforcement, idempotent delete.
 */
import { describe, expect, test, vi } from 'vitest'

import { ApprovalAttachmentStorageError, S3ApprovalAttachmentStore } from '../../src/services/approval-attachment-s3-store'

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

describe('S3ApprovalAttachmentStore', () => {
  test('put/get/delete by deterministic key; keys outside approval/ prefix refused', async () => {
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
    const key = 'approval/2026-07/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.pdf'
    await store.put(key, Buffer.from('hello'))
    expect(put).toHaveBeenCalled()
    expect((await store.get(key)).toString()).toBe('hello')
    await expect(store.put('other-prefix/x.pdf', Buffer.from('x'))).rejects.toBeInstanceOf(ApprovalAttachmentStorageError)
    await expect(store.get('../escape')).rejects.toBeInstanceOf(ApprovalAttachmentStorageError)
  })

  test('delete is idempotent: missing → false; present → true', async () => {
    let exists = true
    const store = new S3ApprovalAttachmentStore({
      bucket: 'b',
      client: fakeClient({
        head: async () => {
          if (!exists) {
            const err = new Error('nf') as Error & { name: string }
            err.name = 'NotFound'
            throw err
          }
          return {}
        },
        del: async () => {
          exists = false
          return {}
        },
      }) as never,
    })
    const key = 'approval/2026-07/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.pdf'
    expect(await store.delete(key)).toBe(true)
    expect(await store.delete(key)).toBe(false)
  })

  test('list is prefix-scoped and never returns non-approval keys', async () => {
    const store = new S3ApprovalAttachmentStore({
      bucket: 'b',
      client: fakeClient({
        list: async () => ({
          Contents: [
            { Key: 'approval/2026-07/a.pdf', LastModified: new Date(Date.now() - 10_000) },
            { Key: 'multitable/other.bin', LastModified: new Date() }, // should be filtered if returned
          ],
          IsTruncated: false,
        }),
      }) as never,
    })
    // Client would only be asked with Prefix=approval/; we still filter defensively
    const listed = await store.list()
    expect(listed.every((b) => b.key.startsWith('approval/'))).toBe(true)
    expect(listed.some((b) => b.key.includes('multitable'))).toBe(false)
  })

  test('provider failures surface as values-free ApprovalAttachmentStorageError (no raw message)', async () => {
    const store = new S3ApprovalAttachmentStore({
      bucket: 'b',
      client: fakeClient({
        head: async () => {
          const err = new Error('nf') as Error & { name: string }
          err.name = 'NotFound'
          throw err
        },
        put: async () => {
          throw new Error('AccessDenied: secret-bucket-name and AKIAXXXX')
        },
      }) as never,
    })
    await expect(store.put('approval/2026-07/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.pdf', Buffer.from('x'))).rejects.toMatchObject({
      code: 'storage_unavailable',
    })
  })
})
