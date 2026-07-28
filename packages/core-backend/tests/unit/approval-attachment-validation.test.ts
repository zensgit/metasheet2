/** Approval attachments slice ① — validation goldens (#4195: 20/10/50 + PDF/JPEG/PNG/TXT/CSV, reject-by-default). */
import { describe, expect, test } from 'vitest'

import {
  APPROVAL_ATTACHMENT_LIMITS,
  httpStatusForAttachmentRejects,
  validateApprovalAttachments,
} from '../../src/services/approval-attachment-validation'

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

  test('G3 content-signature cross-check: magic bytes must agree with the declared MIME', () => {
    const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0])
    const PDF = Buffer.from('%PDF-1.7\n')
    const TEXT = Buffer.from('a,b,c\n1,2,3\n')
    // positive controls: matching content passes
    expect(validateApprovalAttachments([F({ fileName: 'c.png', mimeType: 'image/png', content: PNG })])).toEqual({ ok: true })
    expect(validateApprovalAttachments([F({ fileName: 'a.pdf', mimeType: 'application/pdf', content: PDF })])).toEqual({ ok: true })
    // txt/csv carry no binary signature — plain text is accepted
    expect(validateApprovalAttachments([F({ fileName: 'd.csv', mimeType: 'text/csv', content: TEXT })])).toEqual({ ok: true })
    // mismatches reject with content_mime_mismatch (the mime/ext still agree — only the bytes disagree)
    const mismatches: Array<Record<string, unknown>> = [
      { fileName: 'c.png', mimeType: 'image/png', content: JPEG }, // JPEG bytes declared png
      { fileName: 'a.pdf', mimeType: 'application/pdf', content: PNG }, // PNG bytes declared pdf
      { fileName: 'd.csv', mimeType: 'text/csv', content: PDF }, // a PDF renamed .csv
      { fileName: 'c.png', mimeType: 'image/png', content: TEXT }, // claimed binary, no matching signature
    ]
    for (const over of mismatches) {
      const r = validateApprovalAttachments([F(over as never)])
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.rejected[0].code).toBe('content_mime_mismatch')
    }
    // no content supplied → the content check is skipped (name/type/size validation unchanged)
    expect(validateApprovalAttachments([F({ fileName: 'c.png', mimeType: 'image/png' })])).toEqual({ ok: true })
  })

  test('HTTP semantics map: type rejects → 415; cap rejects → 413', () => {
    expect(httpStatusForAttachmentRejects([{ code: 'mime_not_allowed' }])).toBe(415)
    expect(httpStatusForAttachmentRejects([{ code: 'extension_mime_mismatch' }])).toBe(415)
    expect(httpStatusForAttachmentRejects([{ code: 'content_mime_mismatch' }])).toBe(415)
    expect(httpStatusForAttachmentRejects([{ code: 'file_too_large' }])).toBe(413)
    expect(httpStatusForAttachmentRejects([{ code: 'too_many_files' }])).toBe(413)
    expect(httpStatusForAttachmentRejects([{ code: 'submission_too_large' }])).toBe(413)
    // mixed: cap wins (size still 413 even if type is also wrong)
    expect(httpStatusForAttachmentRejects([{ code: 'mime_not_allowed' }, { code: 'file_too_large' }])).toBe(413)
    expect(httpStatusForAttachmentRejects([{ code: 'invalid_size' }])).toBe(400)
  })

  test('prototype-pollution guard: an Object.prototype-name MIME must reject as unknown, never throw', () => {
    // A plain-object `V1_ALLOWLIST[mime]` lookup with attacker-controlled `mime` would otherwise
    // resolve an INHERITED Object.prototype member (truthy, not an array) for keys like
    // 'constructor' or '__proto__' — and the subsequent `allowedExts.includes(ext)` call would
    // throw an uncaught TypeError (request-crashing DoS). Each of these must reject cleanly with
    // `mime_not_allowed` and must NOT throw, even though `x.pdf`'s extension is allowlisted.
    for (const mimeType of ['constructor', '__proto__']) {
      let r: ReturnType<typeof validateApprovalAttachments> | undefined
      expect(() => {
        r = validateApprovalAttachments([F({ fileName: 'x.pdf', mimeType })])
      }).not.toThrow()
      expect(r?.ok).toBe(false)
      if (r && !r.ok) expect(r.rejected).toEqual([{ fileName: 'x.pdf', code: 'mime_not_allowed' }])
    }
  })
})
