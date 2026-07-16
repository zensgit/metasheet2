// PLM-COLLAB Discussion read-auth line — frontend sub-slice 5, the relay READ calls.
//
// Thin wrappers over the discussion READ relay (`packages/core-backend/src/routes/
// plm-embed-discussion-read.ts`, `/api/plm-embed/discussion/...` GET routes -- read-auth
// sub-slice 2, build-then-HELD on a sibling branch against the same locked contract this module
// targets). Mirrors `plmEmbedDiscussionWrite.ts`'s style deliberately: each call carries ONE
// fresh, single-use embed token in `X-PLM-Embed-Token` (minted per read via
// `createPlmEmbedReadTokenClient`/`requestReadToken()` in `plmEmbedWriteToken.ts`), sends NO
// query params -- the relay derives the target AND a FIXED `include_resolved=true` entirely from
// the verified embed-token claims, never from anything the client sends -- and NEVER throws:
// every call resolves a discriminated result so a caller decides how to surface `{ ok: false }`.
// `suppressUnauthorizedRedirect` keeps a 401 from bouncing the token-only iframe to the login page.
//
// Response envelopes (relay contract):
//   LIST   -> { ok: true, data: { threads: DiscussionThreadSummary[], next_cursor: string | null } }
//            each summary has NO `comments` -- the list is deliberately thin, and the returned
//            threads include BOTH open AND resolved (the relay's fixed include_resolved=true).
//   DETAIL -> { ok: true, data: DiscussionThreadDetail }  (summary fields + comments[]).
import { apiFetch } from '../../utils/api'

const READ_BASE = '/api/plm-embed/discussion'

export type PlmDiscussionReadResult =
  | { ok: true; data: unknown }
  | { ok: false; status: number | null; code?: string }

async function readCall(token: string, path: string): Promise<PlmDiscussionReadResult> {
  try {
    const response = await apiFetch(path, {
      method: 'GET',
      headers: { 'X-PLM-Embed-Token': token },
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

/**
 * LIST -- GET /api/plm-embed/discussion/threads. NO query params: the relay resolves the target
 * (and a fixed include_resolved=true) entirely from the verified embed-token claims, so the
 * response always includes both open and resolved threads for the bound part.
 */
export function listDiscussionThreads(token: string): Promise<PlmDiscussionReadResult> {
  return readCall(token, `${READ_BASE}/threads`)
}

/** DETAIL -- GET /api/plm-embed/discussion/threads/:threadId -- one thread with its comments. */
export function getDiscussionThread(token: string, threadId: string): Promise<PlmDiscussionReadResult> {
  return readCall(token, `${READ_BASE}/threads/${encodeURIComponent(threadId)}`)
}
