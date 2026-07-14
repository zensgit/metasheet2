// PLM-COLLAB Discussion Phase-3 write-UI — the relay write calls (Cut 3).
//
// Thin wrappers over the merged relay routes (`packages/core-backend/src/routes/
// plm-embed-discussion.ts`, `/api/plm-embed/discussion/...`). Each call carries ONE fresh,
// single-use embed token in `X-PLM-Embed-Token` (minted per write via the child token protocol,
// `plmEmbedWriteToken.ts`) -- the relay verifies it, exchanges it once for a discussion-session
// credential server-side, and performs exactly one write. The token is passed in per call and is
// NEVER stored here.
//
// Every function resolves to a discriminated result and NEVER throws (mirrors the read service):
// a caller decides how to surface `{ ok: false }`. `suppressUnauthorizedRedirect` keeps a 401 from
// bouncing the token-only iframe to the login page.
import { apiFetch } from '../../utils/api'

const WRITE_BASE = '/api/plm-embed/discussion'

export type PlmDiscussionWriteResult =
  | { ok: true; data: unknown }
  | { ok: false; status: number | null; code?: string }

export interface CreateThreadInput {
  target_type: 'item' | 'item_version' | 'file' | 'eco' | 'pdm_relationship'
  target_id: string
  body: string
  title?: string
  mentioned_user_ids?: number[]
  anchor?: Record<string, unknown> | null
}

export interface CommentInput {
  body: string
  parent_comment_id?: string
  mentioned_user_ids?: number[]
  anchor?: Record<string, unknown> | null
}

export interface TransitionInput {
  comment?: string
  mentioned_user_ids?: number[]
}

async function writeCall(token: string, path: string, body: unknown): Promise<PlmDiscussionWriteResult> {
  try {
    const response = await apiFetch(path, {
      method: 'POST',
      headers: { 'X-PLM-Embed-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      suppressUnauthorizedRedirect: true,
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok || !payload || payload.ok !== true) {
      const code = payload && typeof payload.error?.code === 'string' ? payload.error.code : undefined
      return { ok: false, status: typeof response.status === 'number' ? response.status : null, code }
    }
    return { ok: true, data: payload.data ?? null }
  } catch {
    // network failure / abort: fail closed, never throw at the caller.
    return { ok: false, status: null }
  }
}

export function createDiscussionThread(token: string, input: CreateThreadInput): Promise<PlmDiscussionWriteResult> {
  return writeCall(token, `${WRITE_BASE}/threads`, input)
}

export function addDiscussionComment(token: string, threadId: string, input: CommentInput): Promise<PlmDiscussionWriteResult> {
  return writeCall(token, `${WRITE_BASE}/threads/${encodeURIComponent(threadId)}/comments`, input)
}

export function resolveDiscussionThread(token: string, threadId: string, input: TransitionInput = {}): Promise<PlmDiscussionWriteResult> {
  return writeCall(token, `${WRITE_BASE}/threads/${encodeURIComponent(threadId)}/resolve`, input)
}

export function reopenDiscussionThread(token: string, threadId: string, input: TransitionInput = {}): Promise<PlmDiscussionWriteResult> {
  return writeCall(token, `${WRITE_BASE}/threads/${encodeURIComponent(threadId)}/reopen`, input)
}
