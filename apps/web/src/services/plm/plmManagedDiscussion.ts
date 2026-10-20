import { apiFetch, getApiBase } from '../../utils/api'
import type { PlmDiscussionReadResult } from '../integration/plmEmbedDiscussionRead'
import type { CreateThreadInput, CommentInput } from '../integration/plmEmbedDiscussionWrite'

export type ManagedDiscussionOperation =
  | { operation: 'list' }
  | { operation: 'thread'; threadId: string }
  | { operation: 'create'; body: CreateThreadInput }
  | { operation: 'comment'; threadId: string; body: CommentInput }
  | { operation: 'resolve' | 'reopen'; threadId: string; body: { comment?: string } }

async function call(token: string, path: string, body: unknown): Promise<PlmDiscussionReadResult> {
  try {
    // These credentials belong only to the current Meta origin, even before shell bootstrap.
    if (new URL(getApiBase(), window.location.origin).origin !== window.location.origin) {
      return { ok: false, status: null, code: 'PLM_MANAGED_ORIGIN_REFUSED' }
    }
    const response = await apiFetch(path, { method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-PLM-Embed-Token': token },
      body: JSON.stringify(body), suppressUnauthorizedRedirect: true })
    const payload = await response.json().catch(() => null)
    if (!response.ok || payload?.ok !== true) return { ok: false, status: response.status,
      code: typeof payload?.error?.code === 'string' ? payload.error.code : undefined }
    return { ok: true, data: payload.data }
  } catch { return { ok: false, status: null } }
}

export function discoverManagedDiscussion(token: string, parentOrigin: string): Promise<PlmDiscussionReadResult> {
  return call(token, '/api/plm/managed-login/discussion-context', { operation: 'context', parentOrigin })
}
export function managedDiscussion(token: string, sourceId: string, body: ManagedDiscussionOperation): Promise<PlmDiscussionReadResult> {
  if (!sourceId || sourceId !== sourceId.trim()) return Promise.resolve({ ok: false, status: 422, code: 'PLM_MANAGED_SOURCE_REQUIRED' })
  return call(token, '/api/plm/managed-login/sources/' + encodeURIComponent(sourceId) + '/discussion', body)
}
