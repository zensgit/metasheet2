/** Attachment upload client — pre-validation mirror + upload client goldens (web guard lane). */
import { describe, expect, test, vi } from 'vitest'

import {
  CLIENT_ATTACHMENT_LIMITS,
  CLIENT_ATTACHMENT_RULES_VERSION,
  deleteApprovalAttachment,
  fetchApprovalAttachmentRefs,
  preValidateAttachments,
  uploadApprovalAttachment,
  uploadApprovalAttachmentsAtomic,
} from '../src/approvals/attachmentUpload'

const F = (over: Partial<{ name: string; type: string; size: number }> = {}) => ({
  name: 'a.pdf',
  type: 'application/pdf',
  size: 1024,
  ...over,
})

describe('approval attachment upload client', () => {
  test('rules-version pin: bump requires a deliberate two-sided change (server parity)', () => {
    expect(CLIENT_ATTACHMENT_RULES_VERSION).toBe('v1-20-10-50-pdf-jpeg-png-txt-csv')
    expect(CLIENT_ATTACHMENT_LIMITS).toEqual({ maxFileBytes: 20971520, maxFilesPerField: 10, maxSubmissionBytes: 52428800 })
  })

  test('mirror semantics: happy path passes; each reject leg matches the server vocabulary', () => {
    expect(preValidateAttachments([F(), F({ name: 'b.jpg', type: 'image/jpeg' })])).toEqual([])
    const legs: Array<[ReturnType<typeof F>, string]> = [
      [F({ size: CLIENT_ATTACHMENT_LIMITS.maxFileBytes + 1 }), 'file_too_large'],
      [F({ name: 'x.zip', type: 'application/zip' }), 'mime_not_allowed'],
      [F({ name: 'x.docx', type: 'application/pdf' }), 'extension_not_allowed'],
      [F({ name: 'x.png', type: 'application/pdf' }), 'extension_mime_mismatch'],
      [F({ size: 0 }), 'invalid_size'],
    ]
    for (const [f, code] of legs) {
      expect(preValidateAttachments([f])[0]?.code).toBe(code)
    }
    expect(preValidateAttachments(Array.from({ length: 11 }, (_, i) => F({ name: `f${i}.pdf` })))[0].code).toBe('too_many_files')
    expect(preValidateAttachments(Array.from({ length: 3 }, (_, i) => F({ name: `g${i}.pdf`, size: 18 * 1024 * 1024 }))).some((r) => r.code === 'submission_too_large')).toBe(true)
  })

  test('prototype-pollution guard (server parity): an Object.prototype-name MIME rejects as unknown, never throws', () => {
    // Without the Object.hasOwn guard, ALLOW['constructor'] / ALLOW['__proto__'] resolves an INHERITED
    // member and allowed.includes(ext) throws an uncaught TypeError — even though '.pdf' is allowlisted.
    for (const type of ['constructor', '__proto__']) {
      let out: ReturnType<typeof preValidateAttachments> | undefined
      expect(() => {
        out = preValidateAttachments([F({ name: 'x.pdf', type })])
      }).not.toThrow()
      expect(out).toEqual([{ fileName: 'x.pdf', code: 'mime_not_allowed' }])
    }
  })

  test('upload client: 201 returns id; 415/413/422 surface the server code; pre-reject never hits the network', async () => {
    const ok = vi.fn(async () => new Response(JSON.stringify({ id: 'att_1', sizeBytes: 3 }), { status: 201 }))
    const file = new File([new Uint8Array([1, 2, 3])], 'a.pdf', { type: 'application/pdf' })
    expect(await uploadApprovalAttachment(file, 'tpl', 'fld', ok as unknown as typeof fetch)).toEqual({ id: 'att_1', sizeBytes: 3 })
    // the body carries {templateId, fieldId} and NEVER an org id (org is server-derived)
    const sentForm = (ok.mock.calls[0][1] as RequestInit).body as FormData
    expect(sentForm.get('templateId')).toBe('tpl')
    expect(sentForm.get('fieldId')).toBe('fld')
    expect(sentForm.get('orgId')).toBeNull()
    // §5/G3: type → 415, caps → 413; infected/other may still be 422
    for (const [status, code] of [
      [415, 'mime_not_allowed'],
      [413, 'file_too_large'],
      [422, 'infected'],
    ] as const) {
      const reject = vi.fn(async () => new Response(JSON.stringify({ rejected: [{ code }] }), { status }))
      await expect(uploadApprovalAttachment(file, 'tpl', 'fld', reject as unknown as typeof fetch)).rejects.toThrow(
        new RegExp(code),
      )
    }
    const bad = new File([new Uint8Array([1])], 'x.exe', { type: 'application/x-msdownload' })
    const net = vi.fn()
    await expect(uploadApprovalAttachment(bad, 'tpl', 'fld', net as unknown as typeof fetch)).rejects.toThrow(/mime_not_allowed/)
    expect(net).not.toHaveBeenCalled() // pre-validated locally, no round trip
  })
})

/**
 * §4.3 delete + §8 batched ref resolution clients. These are thin, but two properties are
 * load-bearing and asserted here: DELETE treats the values-free 404 as success (the server cannot
 * tell the client WHY, and every reason means "not a staged upload you can still submit"), and the
 * refs client never round-trips for an empty id list.
 */
describe('approval attachment delete + refs clients', () => {
  test('delete: 204 resolves; the values-free 404 ALSO resolves; any other status throws', async () => {
    const ok = vi.fn(async () => new Response(null, { status: 204 }))
    await expect(deleteApprovalAttachment('att_1', ok)).resolves.toBeUndefined()
    expect(ok.mock.calls[0][0]).toBe('/api/approval/attachments/att_1')
    expect((ok.mock.calls[0][1] as RequestInit).method).toBe('DELETE')
    // 404 = not yours / already bound / already gone — indistinguishable by contract, all "not staged"
    const gone = vi.fn(async () => new Response(JSON.stringify({ error: 'not_found' }), { status: 404 }))
    await expect(deleteApprovalAttachment('att_1', gone)).resolves.toBeUndefined()
    // a real failure must NOT be swallowed — the caller keeps the entry and can retry
    for (const status of [401, 403, 500, 503]) {
      const bad = vi.fn(async () => new Response(null, { status }))
      await expect(deleteApprovalAttachment('att_1', bad)).rejects.toThrow(new RegExp(String(status)))
    }
  })

  test('delete: the id is URL-encoded into the path (never interpolated raw)', async () => {
    const spy = vi.fn(async () => new Response(null, { status: 204 }))
    await deleteApprovalAttachment('att/../evil', spy)
    expect(spy.mock.calls[0][0]).toBe('/api/approval/attachments/att%2F..%2Fevil')
  })

  test('refs: stale-check omits instanceId; bound-metadata includes it; empty ids never hit the network', async () => {
    const stale = vi.fn(async () => new Response(JSON.stringify({ attachments: [{ id: 'a', stale: true }] }), { status: 200 }))
    expect(await fetchApprovalAttachmentRefs(['a'], undefined, stale)).toEqual([{ id: 'a', stale: true }])
    expect(JSON.parse((stale.mock.calls[0][1] as RequestInit).body as string)).toEqual({ ids: ['a'] })

    const bound = vi.fn(async () => new Response(JSON.stringify({
      attachments: [{ id: 'a', tombstone: false, fileName: 'a.pdf', downloadUrl: '/api/approval/attachments/a/download' }],
    }), { status: 200 }))
    expect(await fetchApprovalAttachmentRefs(['a'], 'apv_1', bound)).toEqual([
      { id: 'a', tombstone: false, fileName: 'a.pdf', downloadUrl: '/api/approval/attachments/a/download' },
    ])
    expect(JSON.parse((bound.mock.calls[0][1] as RequestInit).body as string)).toEqual({ ids: ['a'], instanceId: 'apv_1' })

    const never = vi.fn()
    expect(await fetchApprovalAttachmentRefs([], undefined, never)).toEqual([])
    expect(never).not.toHaveBeenCalled()
  })

  test('refs: non-ok, malformed 200, and partial 200 all fail closed (never silently degrade)', async () => {
    const err = vi.fn(async () => new Response(null, { status: 404 }))
    await expect(fetchApprovalAttachmentRefs(['a'], 'apv_1', err)).rejects.toThrow(/404/)
    const junk = vi.fn(async () => new Response('not json', { status: 200 }))
    await expect(fetchApprovalAttachmentRefs(['a'], undefined, junk)).rejects.toThrow(/malformed_response/)
    const missingArray = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }))
    await expect(fetchApprovalAttachmentRefs(['a'], undefined, missingArray)).rejects.toThrow(/malformed_response/)
    // Partial: server returned 200 but omitted one of the requested ids.
    const partial = vi.fn(async () => new Response(JSON.stringify({ attachments: [{ id: 'a', stale: false }] }), { status: 200 }))
    await expect(fetchApprovalAttachmentRefs(['a', 'b'], undefined, partial)).rejects.toThrow(/partial_response/)
  })
})

describe('approval attachment multi-file atomic upload', () => {
  test('second-file failure returns no partial draft state and compensates the first success', async () => {
    const deleted: string[] = []
    let n = 0
    const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        deleted.push(String(path))
        return new Response(null, { status: 204 })
      }
      n += 1
      if (n === 1) return new Response(JSON.stringify({ id: 'att_ok_1', sizeBytes: 4 }), { status: 201 })
      return new Response(JSON.stringify({ rejected: [{ code: 'infected' }] }), { status: 422 })
    })
    const files = [
      new File([new Uint8Array([1, 2, 3, 4])], 'ok.pdf', { type: 'application/pdf' }),
      new File([new Uint8Array([5, 6, 7, 8])], 'bad.pdf', { type: 'application/pdf' }),
    ]
    await expect(uploadApprovalAttachmentsAtomic(files, 'tpl', 'fld', fetcher as unknown as typeof fetch)).rejects.toThrow(
      /infected/,
    )
    // No partial id list is returned. This successful compensation is DELETE (soft-delete + durable
    // purge intent server-side); physical blob deletion remains eventual through the GC worker.
    expect(deleted).toEqual(['/api/approval/attachments/att_ok_1'])
  })

  test('all successes return the full ordered set; no deletes issued', async () => {
    let n = 0
    const fetcher = vi.fn(async (_path: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') throw new Error('delete must not run on full success')
      n += 1
      return new Response(JSON.stringify({ id: `att_${n}`, sizeBytes: n }), { status: 201 })
    })
    const files = [
      new File([new Uint8Array([1])], 'a.pdf', { type: 'application/pdf' }),
      new File([new Uint8Array([2])], 'b.pdf', { type: 'application/pdf' }),
    ]
    await expect(uploadApprovalAttachmentsAtomic(files, 'tpl', 'fld', fetcher as unknown as typeof fetch)).resolves.toEqual([
      { id: 'att_1', sizeBytes: 1 },
      { id: 'att_2', sizeBytes: 2 },
    ])
  })

  test('a failed compensation never turns a failed selection into a partial success', async () => {
    let upload = 0
    let deleteCalls = 0
    const fetcher = vi.fn(async (_path: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        deleteCalls += 1
        return new Response(null, { status: 503 })
      }
      upload += 1
      if (upload === 1) return new Response(JSON.stringify({ id: 'att_orphan', sizeBytes: 1 }), { status: 201 })
      return new Response(JSON.stringify({ rejected: [{ code: 'infected' }] }), { status: 422 })
    })
    const files = [
      new File([new Uint8Array([1])], 'a.pdf', { type: 'application/pdf' }),
      new File([new Uint8Array([2])], 'b.pdf', { type: 'application/pdf' }),
    ]
    await expect(uploadApprovalAttachmentsAtomic(files, 'tpl', 'fld', fetcher)).rejects.toThrow(/infected/)
    expect(deleteCalls).toBe(1)
  })
})
