/** Attachment upload client — pre-validation mirror + upload client goldens (web guard lane). */
import { describe, expect, test, vi } from 'vitest'

import {
  approvalAttachmentDownloadUrl,
  attachmentDisplayLabel,
  ATTACHMENT_TOMBSTONE_LABEL,
  ATTACHMENT_UNAVAILABLE_LABEL,
  CLIENT_ATTACHMENT_LIMITS,
  CLIENT_ATTACHMENT_RULES_VERSION,
  deleteApprovalAttachment,
  dropStaleAttachmentIds,
  isApprovalAttachmentsEnabled,
  preValidateAttachments,
  probeAttachmentRef,
  resolveAttachmentMeta,
  uploadApprovalAttachment,
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

  test('upload client: 201 returns id; 422 surfaces the server code; pre-reject never hits the network', async () => {
    const ok = vi.fn(async () => new Response(JSON.stringify({ id: 'att_1', sizeBytes: 3 }), { status: 201 }))
    const file = new File([new Uint8Array([1, 2, 3])], 'a.pdf', { type: 'application/pdf' })
    expect(await uploadApprovalAttachment(file, 'tpl', 'fld', ok as unknown as typeof fetch)).toEqual({
      id: 'att_1',
      sizeBytes: 3,
      fileName: 'a.pdf',
    })
    // the body carries {templateId, fieldId} and NEVER an org id (org is server-derived)
    const sentForm = (ok.mock.calls[0][1] as RequestInit).body as FormData
    expect(sentForm.get('templateId')).toBe('tpl')
    expect(sentForm.get('fieldId')).toBe('fld')
    expect(sentForm.get('orgId')).toBeNull()
    const r422 = vi.fn(async () => new Response(JSON.stringify({ rejected: [{ code: 'mime_not_allowed' }] }), { status: 422 }))
    await expect(uploadApprovalAttachment(file, 'tpl', 'fld', r422 as unknown as typeof fetch)).rejects.toThrow(/mime_not_allowed/)
    const bad = new File([new Uint8Array([1])], 'x.exe', { type: 'application/x-msdownload' })
    const net = vi.fn()
    await expect(uploadApprovalAttachment(bad, 'tpl', 'fld', net as unknown as typeof fetch)).rejects.toThrow(/mime_not_allowed/)
    expect(net).not.toHaveBeenCalled() // pre-validated locally, no round trip
  })

  test('flag defaults OFF; only exact true enables', () => {
    expect(isApprovalAttachmentsEnabled({} as never)).toBe(false)
    expect(isApprovalAttachmentsEnabled({ VITE_APPROVAL_ATTACHMENTS_ENABLED: 'false' })).toBe(false)
    expect(isApprovalAttachmentsEnabled({ VITE_APPROVAL_ATTACHMENTS_ENABLED: 'true' })).toBe(true)
  })

  test('download URL is lock §4 plural path — never singular /api/approval/, never storage keys', () => {
    const url = approvalAttachmentDownloadUrl('att_abc')
    expect(url).toBe('/api/approvals/attachments/att_abc/download')
    expect(url).not.toMatch(/\/api\/approval\/attachments/) // singular must not appear
    expect(url).not.toMatch(/s3|storage_key|amazonaws/)
  })

  test('delete client: 204/404 succeed; other statuses throw values-free', async () => {
    const ok = vi.fn(async () => new Response(null, { status: 204 }))
    await expect(deleteApprovalAttachment('att_1', ok as unknown as typeof fetch)).resolves.toBeUndefined()
    const gone = vi.fn(async () => new Response(null, { status: 404 }))
    await expect(deleteApprovalAttachment('att_1', gone as unknown as typeof fetch)).resolves.toBeUndefined()
    const bad = vi.fn(async () => new Response(null, { status: 500 }))
    await expect(deleteApprovalAttachment('att_1', bad as unknown as typeof fetch)).rejects.toThrow(/500/)
  })

  test('G13 tri-state: drop only stale; preserve unavailable (network positive control)', async () => {
    const probe = async (id: string) => {
      if (id === 'att_stale') return 'stale' as const
      if (id === 'att_net') return 'unavailable' as const
      return 'live' as const
    }
    const r = await dropStaleAttachmentIds(['att_live', 'att_stale', 'att_net'], probe)
    expect(r.stale).toEqual(['att_stale'])
    expect(r.unavailable).toEqual(['att_net'])
    // live list keeps both live and unavailable (never drop on transient failure)
    expect(r.live).toEqual(['att_live', 'att_net'])
  })

  test('probeAttachmentRef: 200 live; 404/410 stale; 503/network unavailable', async () => {
    expect(
      await probeAttachmentRef('a', (async () => new Response(null, { status: 200 })) as unknown as typeof fetch),
    ).toBe('live')
    expect(
      await probeAttachmentRef('a', (async () => new Response(null, { status: 404 })) as unknown as typeof fetch),
    ).toBe('stale')
    expect(
      await probeAttachmentRef('a', (async () => new Response(null, { status: 410 })) as unknown as typeof fetch),
    ).toBe('stale')
    expect(
      await probeAttachmentRef('a', (async () => new Response(null, { status: 503 })) as unknown as typeof fetch),
    ).toBe('unavailable')
    expect(
      await probeAttachmentRef('a', (async () => {
        throw new Error('network down')
      }) as unknown as typeof fetch),
    ).toBe('unavailable')
  })

  test('detail labels: tombstone vs unavailable vs live (positive control)', () => {
    expect(attachmentDisplayLabel({ id: 'a', tombstone: true }, 0)).toBe(ATTACHMENT_TOMBSTONE_LABEL)
    expect(attachmentDisplayLabel({ id: 'a', unavailable: true }, 0)).toBe(ATTACHMENT_UNAVAILABLE_LABEL)
    expect(attachmentDisplayLabel({ id: 'a', fileName: 'invoice.pdf', status: 'bound' }, 0)).toBe('invoice.pdf')
  })

  test('resolveAttachmentMeta: 200 live; 410/404 tombstone; 503/network unavailable (not tombstone)', async () => {
    const live = vi.fn(async () =>
      new Response(JSON.stringify({ id: 'att_1', fileName: 'a.pdf', tombstone: false, status: 'bound' }), {
        status: 200,
      }),
    )
    expect(await resolveAttachmentMeta('att_1', live as unknown as typeof fetch)).toMatchObject({
      id: 'att_1',
      fileName: 'a.pdf',
      tombstone: false,
    })
    const gone = vi.fn(async () => new Response(null, { status: 410 }))
    expect(await resolveAttachmentMeta('att_x', gone as unknown as typeof fetch)).toMatchObject({
      tombstone: true,
      status: 'deleted',
    })
    const missing = vi.fn(async () => new Response(null, { status: 404 }))
    expect(await resolveAttachmentMeta('att_y', missing as unknown as typeof fetch)).toMatchObject({
      tombstone: true,
      status: 'missing',
    })
    const unavailable = vi.fn(async () => new Response(null, { status: 503 }))
    const uMeta = await resolveAttachmentMeta('att_z', unavailable as unknown as typeof fetch)
    expect(uMeta.unavailable).toBe(true)
    expect(uMeta.tombstone).toBeFalsy()
    const net = vi.fn(async () => {
      throw new Error('ECONNRESET')
    })
    const nMeta = await resolveAttachmentMeta('att_n', net as unknown as typeof fetch)
    expect(nMeta.unavailable).toBe(true)
    expect(nMeta.tombstone).toBeFalsy()
  })
})



