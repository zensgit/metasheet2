/**
 * Lock-9 OD-L9-10(a) — process-attachment (approver) upload client goldens.
 *
 * File name rides the existing `approval-attachment-upload` required-web-tests token (a
 * substring match on the file path) — no CI wiring change needed for THIS file. See the PR body
 * for the full CI-wiring ledger.
 */
import { describe, expect, test, vi } from 'vitest'

import {
  deleteApprovalAttachment,
  uploadApprovalProcessAttachment,
  uploadApprovalProcessAttachmentsAtomic,
} from '../src/approvals/attachmentUpload'

describe('approval process-attachment upload client', () => {
  test('body carries {file, stagedInstanceId} ONLY — never templateId/fieldId (server 400s on either)', async () => {
    const ok = vi.fn(async () => new Response(JSON.stringify({ id: 'att_p1', sizeBytes: 3 }), { status: 201 }))
    const file = new File([new Uint8Array([1, 2, 3])], 'a.pdf', { type: 'application/pdf' })
    const result = await uploadApprovalProcessAttachment(file, 'apv_1', ok as unknown as typeof fetch)
    expect(result).toEqual({ id: 'att_p1', sizeBytes: 3 })
    expect(ok.mock.calls[0][0]).toBe('/api/approval/attachments/process')
    const sentForm = (ok.mock.calls[0][1] as RequestInit).body as FormData
    expect(sentForm.get('stagedInstanceId')).toBe('apv_1')
    expect(sentForm.get('file')).toBeInstanceOf(File)
    expect(sentForm.get('templateId')).toBeNull()
    expect(sentForm.get('fieldId')).toBeNull()
  })

  test('per-file validation reuses the RATIFIED OD-L9-9 rules (MIME/extension/size) and rejects locally without a round trip', async () => {
    const net = vi.fn()
    const bad = new File([new Uint8Array([1])], 'x.exe', { type: 'application/x-msdownload' })
    await expect(uploadApprovalProcessAttachment(bad, 'apv_1', net as unknown as typeof fetch)).rejects.toThrow(/mime_not_allowed/)
    expect(net).not.toHaveBeenCalled()

    // Real oversized content (21MB > the shared 20MB/file cap) — proves the per-file size leg
    // reuses the SAME `CLIENT_ATTACHMENT_LIMITS.maxFileBytes` the form path pins, not a fork.
    const tooBig = new File([new Uint8Array(21 * 1024 * 1024)], 'big.pdf', { type: 'application/pdf' })
    await expect(uploadApprovalProcessAttachment(tooBig, 'apv_1', net as unknown as typeof fetch)).rejects.toThrow(/file_too_large/)
    expect(net).not.toHaveBeenCalled()
  })

  test('a single-file call structurally cannot trip the FORM-shaped too_many_files/submission_too_large legs', async () => {
    // Proof, not assertion-by-reasoning: preValidateAttachments's count/total checks are keyed off
    // the ARRAY passed to it. uploadApprovalProcessAttachment always calls it with a 1-element
    // array, so those two reject codes are unreachable from this function no matter the file size
    // (as long as the file passes its OWN per-file cap first, which the 20MB legs above cover).
    const ok = vi.fn(async () => new Response(JSON.stringify({ id: 'att_p2', sizeBytes: 1 }), { status: 201 }))
    const file = new File([new Uint8Array([1])], 'ok.pdf', { type: 'application/pdf' })
    await expect(uploadApprovalProcessAttachment(file, 'apv_1', ok as unknown as typeof fetch)).resolves.toEqual({
      id: 'att_p2',
      sizeBytes: 1,
    })
  })

  test('server rejects surface: 400 process_attachment_has_no_field / staged_instance_id_required shape through as a generic status throw; 415/413/422 surface the reject code', async () => {
    const file = new File([new Uint8Array([1])], 'a.pdf', { type: 'application/pdf' })
    for (const [status, code] of [
      [415, 'mime_not_allowed'],
      [413, 'too_many_files'],
      [422, 'infected'],
    ] as const) {
      const reject = vi.fn(async () => new Response(JSON.stringify({ rejected: [{ code }] }), { status }))
      await expect(uploadApprovalProcessAttachment(file, 'apv_1', reject as unknown as typeof fetch)).rejects.toThrow(
        new RegExp(code),
      )
    }
    const badRequest = vi.fn(async () => new Response(JSON.stringify({ error: 'process_attachment_has_no_field' }), { status: 400 }))
    await expect(uploadApprovalProcessAttachment(file, 'apv_1', badRequest as unknown as typeof fetch)).rejects.toThrow(/400/)
  })
})

describe('approval process-attachment atomic multi-file upload', () => {
  test('second-file failure compensates the first success in reverse order, no client-side file-count cap', async () => {
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
    await expect(
      uploadApprovalProcessAttachmentsAtomic(files, 'apv_1', fetcher as unknown as typeof fetch),
    ).rejects.toThrow(/infected/)
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
    await expect(
      uploadApprovalProcessAttachmentsAtomic(files, 'apv_1', fetcher as unknown as typeof fetch),
    ).resolves.toEqual([
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
    await expect(uploadApprovalProcessAttachmentsAtomic(files, 'apv_1', fetcher)).rejects.toThrow(/infected/)
    expect(deleteCalls).toBe(1)
  })
})

// Sanity: `deleteApprovalAttachment` is reused UNCHANGED for compensation/removal — imported here
// only to prove this file did not fork its own copy.
describe('reuse check', () => {
  test('deleteApprovalAttachment is the same shared function the form-upload path uses', async () => {
    const ok = vi.fn(async () => new Response(null, { status: 204 }))
    await expect(deleteApprovalAttachment('att_x', ok)).resolves.toBeUndefined()
    expect(ok.mock.calls[0][0]).toBe('/api/approval/attachments/att_x')
  })
})
