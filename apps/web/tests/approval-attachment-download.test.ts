import { describe, expect, it, vi } from 'vitest'

import { fetchApprovalAttachmentBlob } from '../src/approvals/attachmentDownload'

describe('fetchApprovalAttachmentBlob', () => {
  it('uses the authenticated API fetch seam and returns the response bytes', async () => {
    const blob = new Blob(['%PDF-authenticated'], { type: 'application/pdf' })
    const fetcher = vi.fn(async () => ({
      ok: true,
      status: 200,
      blob: async () => blob,
    } as Response))

    const result = await fetchApprovalAttachmentBlob({
      downloadUrl: '/api/approval/attachments/att_1/download',
      fileName: 'contract.pdf',
    }, fetcher)

    expect(fetcher).toHaveBeenCalledWith('/api/approval/attachments/att_1/download')
    expect(result).toBeInstanceOf(Blob)
    expect(result.size).toBe(blob.size)
    expect(result.type).toBe('application/pdf')
  })

  it('refuses raw or cross-origin storage URLs before any network call', async () => {
    const fetcher = vi.fn(async () => new Response('never'))
    await expect(fetchApprovalAttachmentBlob({
      downloadUrl: 'https://bucket.example.com/raw/key.pdf',
      fileName: 'x.pdf',
    }, fetcher)).rejects.toThrow('approval_attachment_download_url_invalid')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('fails closed on an authenticated API error', async () => {
    await expect(fetchApprovalAttachmentBlob({
      downloadUrl: '/api/approval/attachments/att_1/download',
      fileName: 'contract.pdf',
    }, async () => new Response(null, { status: 401 }))).rejects.toThrow('approval_attachment_download_failed_401')
  })
})
