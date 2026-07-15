/** Approval attachments slice ① — validation goldens (#4195: 20/10/50 + PDF/JPEG/PNG/TXT/CSV, reject-by-default). */
import { describe, expect, test } from 'vitest'

import { APPROVAL_ATTACHMENT_LIMITS, validateApprovalAttachments } from '../../src/services/approval-attachment-validation'

const F = (over: Partial<{ fileName: string; mimeType: string; sizeBytes: number }> = {}) => ({
  fileName: 'a.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 1024,
  ...over,
})

describe('approval attachment validation (v1)', () => {
  test('happy path: each v1 MIME with its extension passes; limits are the ratified 20/10/50', () => {
    expect(APPROVAL_ATTACHMENT_LIMITS).toEqual({ maxFileBytes: 20971520, maxFilesPerField: 10, maxSubmissionBytes: 52428800 })
    const r = validateApprovalAttachments([
      F(),
      F({ fileName: 'b.jpg', mimeType: 'image/jpeg' }),
      F({ fileName: 'b2.jpeg', mimeType: 'image/jpeg' }),
      F({ fileName: 'c.png', mimeType: 'image/png' }),
      F({ fileName: 'd.txt', mimeType: 'text/plain' }),
      F({ fileName: 'e.csv', mimeType: 'text/csv' }),
    ])
    expect(r).toEqual({ ok: true })
  })

  test('reject-by-default: unknown MIME, unknown extension, and extension⇄MIME mismatch each reject', () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ fileName: 'x.zip', mimeType: 'application/zip' }, 'mime_not_allowed'], // D6: archives deferred to AV
      [{ fileName: 'x.docx', mimeType: 'application/pdf' }, 'extension_not_allowed'],
      [{ fileName: 'x.png', mimeType: 'application/pdf' }, 'extension_mime_mismatch'], // .png claiming pdf
      [{ fileName: 'noext', mimeType: 'application/pdf' }, 'extension_not_allowed'],
    ]
    for (const [over, code] of cases) {
      const r = validateApprovalAttachments([F(over as never)])
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.rejected[0].code).toBe(code)
    }
  })

  test('size gates: >20MB file, >10 files, >50MB submission, non-positive size', () => {
    const big = validateApprovalAttachments([F({ sizeBytes: APPROVAL_ATTACHMENT_LIMITS.maxFileBytes + 1 })])
    expect(!big.ok && big.rejected[0].code).toBe('file_too_large')
    const many = validateApprovalAttachments(Array.from({ length: 11 }, (_, i) => F({ fileName: `f${i}.pdf` })))
    expect(!many.ok && many.rejected[0].code).toBe('too_many_files')
    const total = validateApprovalAttachments(Array.from({ length: 3 }, (_, i) => F({ fileName: `g${i}.pdf`, sizeBytes: 18 * 1024 * 1024 })))
    expect(!total.ok && total.rejected.some((x) => x.code === 'submission_too_large')).toBe(true)
    const zero = validateApprovalAttachments([F({ sizeBytes: 0 })])
    expect(!zero.ok && zero.rejected[0].code).toBe('invalid_size')
  })

  test('all-or-nothing: one bad file rejects with per-file codes while good files are not silently accepted', () => {
    const r = validateApprovalAttachments([F(), F({ fileName: 'bad.exe', mimeType: 'application/x-msdownload' })])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.rejected).toEqual([{ fileName: 'bad.exe', code: 'mime_not_allowed' }])
  })
})
