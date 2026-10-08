import { apiFetch } from '../utils/api'

export interface ApprovalAttachmentDownload {
  downloadUrl: string
  fileName: string
}
export type ApprovalAttachmentFetch = (path: string) => Promise<Response>

const PROXIED_DOWNLOAD_PATH = /^\/api\/approval\/attachments\/[^/]+\/download$/

/** Fetch attachment bytes through the authenticated API path; raw storage URLs are refused. */
export async function fetchApprovalAttachmentBlob(
  attachment: ApprovalAttachmentDownload,
  fetcher: ApprovalAttachmentFetch = (path) => apiFetch(path),
): Promise<Blob> {
  if (!PROXIED_DOWNLOAD_PATH.test(attachment.downloadUrl)) {
    throw new Error('approval_attachment_download_url_invalid')
  }
  const response = await fetcher(attachment.downloadUrl)
  if (!response.ok) throw new Error(`approval_attachment_download_failed_${response.status}`)
  return response.blob()
}
