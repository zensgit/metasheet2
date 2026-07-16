/** Attachment upload client — pre-validation mirror + upload client goldens (web guard lane). */
import { describe, expect, test, vi } from 'vitest'

import {
  CLIENT_ATTACHMENT_LIMITS,
  CLIENT_ATTACHMENT_RULES_VERSION,
  preValidateAttachments,
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

  test('upload client: 201 returns id; 422 surfaces the server code; pre-reject never hits the network', async () => {
    const ok = vi.fn(async () => new Response(JSON.stringify({ id: 'att_1', sizeBytes: 3 }), { status: 201 }))
    const file = new File([new Uint8Array([1, 2, 3])], 'a.pdf', { type: 'application/pdf' })
    expect(await uploadApprovalAttachment(file, 'fld', 'org', ok as unknown as typeof fetch)).toEqual({ id: 'att_1', sizeBytes: 3 })
    const r422 = vi.fn(async () => new Response(JSON.stringify({ rejected: [{ code: 'mime_not_allowed' }] }), { status: 422 }))
    await expect(uploadApprovalAttachment(file, 'fld', 'org', r422 as unknown as typeof fetch)).rejects.toThrow(/mime_not_allowed/)
    const bad = new File([new Uint8Array([1])], 'x.exe', { type: 'application/x-msdownload' })
    const net = vi.fn()
    await expect(uploadApprovalAttachment(bad, 'fld', 'org', net as unknown as typeof fetch)).rejects.toThrow(/mime_not_allowed/)
    expect(net).not.toHaveBeenCalled() // pre-validated locally, no round trip
  })
})
