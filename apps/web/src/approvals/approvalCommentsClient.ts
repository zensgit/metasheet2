/**
 * S3b (approval comments tab): the SECOND implementation of `CommentsApiClient` (S3a's shared
 * seam — `shared/comments/api-client.ts`), mapping the kit's 7-method contract onto the S2
 * `/api/approvals/:id/comments*` endpoints (`packages/core-backend/src/routes/approval-comments.ts`
 * + `services/approval-comment-service.ts`, PR #5087).
 *
 * WIRING CONTRACT NOTES (see the PR body for the fully cross-referenced version):
 *
 *  - `CommentsApiClient.updateComment`/`deleteComment`/`resolveComment`/`addReaction`/
 *    `removeReaction` all take ONLY a `commentId` — no target/instanceId, because multitable's own
 *    `/api/comments/:id` family is comment-id-addressable alone. S2's PATCH/DELETE routes are
 *    `/api/approvals/:id/comments/:commentId` — instance-scoped. Rather than widening the shared
 *    interface (a landmine: "never make CommentsApiClient methods optional" — that pushes guards
 *    into the shared composable and touches multitable behavior), this client captures the CURRENT
 *    instance id via a `getInstanceId` closure supplied at construction. `listComments`/
 *    `createComment` DO receive a `CommentsTarget` (containerId/targetId, both the instance id per
 *    the wrapper's scope-tuple contract) — but this client deliberately uses ONLY the closure for
 *    every URL, including those two, never `params.containerId`: during a route param change
 *    (下一条 → / deep link) the two sources could transiently disagree, and a request built from a
 *    stale `params.containerId` would write into the WRONG approval instance. One source of truth.
 *
 *  - Capabilities S2 does not expose (reactions, resolve) are surfaced as ABSENT, never stubbed
 *    with fabricated success: `resolveComment`/`addReaction`/`removeReaction` throw
 *    `ApprovalCommentsUnsupportedOperationError`. The wrapper additionally gates the UI so these
 *    are unreachable (`:can-resolve="false"`, `:enable-reactions="false"`) — the throw is the
 *    fail-closed floor underneath that UI gate, not a substitute for it (see
 *    `approval-comments-client.spec.ts`, which asserts BOTH halves).
 *
 *  - Ordering: S2 returns comments oldest-first (`created_at ASC, id ASC`); the shared composable
 *    `unshift`s a newly-created comment onto the front of its local array. This client REVERSES
 *    each fully-paginated list to newest-first before returning, so the initial hydrated list and
 *    the post-create local state agree on order.
 *
 *  - Pagination: `listComments` takes no paging params on the shared interface, so this client
 *    loops (`limit=200`, `offset += 200`) until a page returns fewer than `limit` rows or
 *    `APPROVAL_COMMENT_LIST_MAX_PAGES` (10 → 2000 comments) is reached. Hitting the cap sets the
 *    `truncated` ref (an EXTRA property on the returned client, beyond the 7-method floor — see
 *    the interface's own doc: "a floor, not a ceiling") so the wrapper can show a truncation
 *    notice instead of silently dropping the tail. Reset at the START of every `listComments`
 *    call so a stale notice never survives a later, short load.
 *
 *  - Author display names: S2's `ApprovalCommentView` carries NO `authorName` at all (unlike
 *    multitable's comment rows, which are directory-enriched server-side). This client leaves
 *    `authorName` unset on every mapped comment — the values-free identity guard (resolved name or
 *    a `成员 N` ordinal, NEVER the raw id) is applied by the WRAPPER
 *    (`views/approval/ApprovalCommentsPanel.vue`), per the member-display-identity census gate
 *    (`approval-member-identity-coverage-enumeration.spec.ts`'s "GATE FOR THE NEXT SLICE" note).
 *    This file has no dependency on the directory resolver and must stay that way — the guard is
 *    approval-specific UI policy, not a transport concern.
 */
import type { Ref } from 'vue'
import { ref } from 'vue'
import { apiFetch } from '../utils/api'
import { approvalRequestError } from './api'
import type { CommentsApiClient, CommentsTarget } from '../shared/comments/api-client'
import type { MultitableComment } from '../shared/comments/types'

export interface ApprovalCommentMentionCandidate {
  id: string
  name: string
  email: string
}

const APPROVAL_COMMENT_LIST_PAGE_SIZE = 200
/** 10 pages × 200 = 2000 comments before this client stops paging and flags `truncated`. */
const APPROVAL_COMMENT_LIST_MAX_PAGES = 10

/**
 * Thrown by the three operations S2 does not implement. Named (not a bare Error) so the wrapper
 * — and its spec — can assert on `instanceof` / `.name` rather than a message substring.
 */
export class ApprovalCommentsUnsupportedOperationError extends Error {
  constructor(operation: string) {
    super(`${operation} is not supported by the approval comments backend (S2 exposes no reaction/resolve endpoints)`)
    this.name = 'ApprovalCommentsUnsupportedOperationError'
  }
}

interface RawApprovalCommentView {
  id?: unknown
  instanceId?: unknown
  parentId?: unknown
  authorId?: unknown
  body?: unknown
  mentions?: unknown
  createdAt?: unknown
  updatedAt?: unknown
  editedAt?: unknown
  deleted?: unknown
}

/**
 * §2 field-by-field mapping (wiring contract): `ApprovalCommentView` (wire) -> `MultitableComment`
 * (kit type). `fieldId`/`targetFieldId` are ALWAYS null (S2 has no per-field comment concept, and
 * the panel's `visibleComments` filter drops everything when `targetFieldId` is set and no
 * comment carries it). `resolved` is always `false` (S2 has no resolve concept). `reactions` is
 * OMITTED entirely (undefined), never synthesized.
 */
function toMultitableComment(raw: RawApprovalCommentView, instanceId: string): MultitableComment {
  const id = typeof raw.id === 'string' ? raw.id : ''
  const parentId = typeof raw.parentId === 'string' && raw.parentId ? raw.parentId : undefined
  const mentions = Array.isArray(raw.mentions)
    ? raw.mentions.filter((m): m is string => typeof m === 'string')
    : []
  return {
    id,
    containerId: instanceId,
    targetId: instanceId,
    fieldId: null,
    targetFieldId: null,
    parentId,
    mentions,
    authorId: typeof raw.authorId === 'string' ? raw.authorId : '',
    // Deliberately unset — see this file's own header note. The wrapper fills a values-free
    // resolved-name-or-ordinal before handing comments to the shared panel.
    authorName: undefined,
    content: typeof raw.body === 'string' ? raw.body : '',
    resolved: false,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : undefined,
    deleted: raw.deleted === true,
    editedAt: typeof raw.editedAt === 'string' ? raw.editedAt : null,
  }
}

async function parseApprovalCommentEnvelope<T>(res: Response): Promise<T> {
  if (!res.ok) await approvalRequestError(res)
  const json = (await res.json()) as { ok?: boolean; data?: T }
  return (json.data ?? ({} as T))
}

/**
 * Fetches the mention-candidate roster ONCE (no `q`) — the composer filters client-side (mirrors
 * every other `MetaCommentComposer` consumer). Not part of `CommentsApiClient` (the kit interface
 * has no mention-candidates method); called directly by the wrapper on tab activation.
 */
export async function fetchApprovalCommentMentionCandidates(
  instanceId: string,
  opts: { q?: string; limit?: number } = {},
): Promise<ApprovalCommentMentionCandidate[]> {
  const qp = new URLSearchParams()
  if (opts.q) qp.set('q', opts.q)
  if (typeof opts.limit === 'number') qp.set('limit', String(opts.limit))
  const suffix = qp.toString() ? `?${qp.toString()}` : ''
  const res = await apiFetch(`/api/approvals/${encodeURIComponent(instanceId)}/comments/mention-candidates${suffix}`)
  const data = await parseApprovalCommentEnvelope<{ users?: unknown }>(res)
  const users = Array.isArray(data.users) ? data.users : []
  return users
    .filter((u): u is { id: unknown; name: unknown; email: unknown } => !!u && typeof u === 'object')
    .map((u) => ({
      id: typeof u.id === 'string' ? u.id : '',
      name: typeof u.name === 'string' ? u.name : '',
      email: typeof u.email === 'string' ? u.email : '',
    }))
    .filter((u) => u.id.length > 0)
}

export type ApprovalCommentsClient = CommentsApiClient & {
  /** Set when `listComments`'s pagination loop hit `APPROVAL_COMMENT_LIST_MAX_PAGES` before
   *  exhausting the server's reported total. Reset at the start of every `listComments` call. */
  truncated: Ref<boolean>
}

/**
 * Constructs the approval `CommentsApiClient`. `getInstanceId` is a closure, not a fixed string,
 * so a single client instance stays correct across a route-param-only navigation (下一条 →)
 * without needing to be re-created — see this file's own header note on why every URL uses ONLY
 * this closure, never a target argument.
 */
export function createApprovalCommentsClient(getInstanceId: () => string): ApprovalCommentsClient {
  const truncated = ref(false)

  return {
    truncated,

    async listComments(_params: CommentsTarget): Promise<{ comments: MultitableComment[] }> {
      const instanceId = getInstanceId()
      truncated.value = false
      const collected: MultitableComment[] = []
      let offset = 0
      for (let page = 0; page < APPROVAL_COMMENT_LIST_MAX_PAGES; page += 1) {
        const res = await apiFetch(
          `/api/approvals/${encodeURIComponent(instanceId)}/comments?limit=${APPROVAL_COMMENT_LIST_PAGE_SIZE}&offset=${offset}`,
        )
        const data = await parseApprovalCommentEnvelope<{ comments?: unknown; page?: { total?: unknown } }>(res)
        const rawComments = Array.isArray(data.comments) ? (data.comments as RawApprovalCommentView[]) : []
        for (const raw of rawComments) collected.push(toMultitableComment(raw, instanceId))
        const total = typeof data.page?.total === 'number' ? data.page!.total : collected.length
        // Terminate on a short/empty page (never rely on `total` alone — it can move under
        // concurrent creates) OR once we've collected at least as many rows as the server
        // reported at fetch time.
        if (rawComments.length < APPROVAL_COMMENT_LIST_PAGE_SIZE || collected.length >= total) break
        offset += APPROVAL_COMMENT_LIST_PAGE_SIZE
        if (page === APPROVAL_COMMENT_LIST_MAX_PAGES - 1) truncated.value = true
      }
      // S2 is oldest-first; the shared composable unshifts new comments onto the front — reverse
      // here so the hydrated list and post-create local state agree (see header note).
      collected.reverse()
      return { comments: collected }
    },

    async createComment(
      input: CommentsTarget & { content: string; parentId?: string; mentions?: string[] },
    ): Promise<{ comment: MultitableComment }> {
      const instanceId = getInstanceId()
      const res = await apiFetch(`/api/approvals/${encodeURIComponent(instanceId)}/comments`, {
        method: 'POST',
        body: JSON.stringify({
          body: input.content,
          parentId: input.parentId,
          mentions: input.mentions,
        }),
      })
      const data = await parseApprovalCommentEnvelope<{ comment?: RawApprovalCommentView }>(res)
      return { comment: toMultitableComment(data.comment ?? {}, instanceId) }
    },

    async updateComment(
      commentId: string,
      input: { content: string; mentions?: string[] },
    ): Promise<{ comment: MultitableComment }> {
      const instanceId = getInstanceId()
      const res = await apiFetch(
        `/api/approvals/${encodeURIComponent(instanceId)}/comments/${encodeURIComponent(commentId)}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ body: input.content, mentions: input.mentions }),
        },
      )
      const data = await parseApprovalCommentEnvelope<{ comment?: RawApprovalCommentView }>(res)
      return { comment: toMultitableComment(data.comment ?? {}, instanceId) }
    },

    async deleteComment(commentId: string): Promise<void> {
      const instanceId = getInstanceId()
      const res = await apiFetch(
        `/api/approvals/${encodeURIComponent(instanceId)}/comments/${encodeURIComponent(commentId)}`,
        { method: 'DELETE' },
      )
      // The 200 body IS the tombstone (§1 of the wiring contract), but this method's return type
      // is `Promise<void>` per the shared interface — the wrapper re-lists after a successful
      // delete (approach (a) in the wiring contract) rather than threading the tombstone through
      // here, so the composable's own `deletingIds`/error bookkeeping stays untouched.
      await parseApprovalCommentEnvelope<{ comment?: RawApprovalCommentView }>(res)
    },

    async resolveComment(): Promise<void> {
      throw new ApprovalCommentsUnsupportedOperationError('resolveComment')
    },

    async addReaction(): Promise<void> {
      throw new ApprovalCommentsUnsupportedOperationError('addReaction')
    },

    async removeReaction(): Promise<void> {
      throw new ApprovalCommentsUnsupportedOperationError('removeReaction')
    },
  }
}
