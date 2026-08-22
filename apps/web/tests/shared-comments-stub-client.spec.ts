/**
 * S3a (comments shared FE kit extraction): proves shared/comments/composables/useMultitableComments
 * is genuinely interface-driven — it works against a minimal, hand-written CommentsApiClient stub
 * with NO multitable wire format (no spreadsheetId/rowId query strings, no MultitableApiClient,
 * no fetch mocking) and NO import from anything under `src/multitable/**`. This is the seam a
 * future approval-native storage backend implements as CommentsApiClient's second implementation
 * (multitable/api/client.ts's MultitableApiClient is the first, see multitable-comments.spec.ts /
 * multitable-client.spec.ts for that half).
 *
 * Deliberately thin: this does not re-litigate the full behavior matrix (error fallbacks, reaction
 * increment/decrement bookkeeping, upsert-preserves-reactions, …) — that is already exhaustively
 * covered against the real MultitableApiClient in multitable-comments.spec.ts, and the shared
 * composable's method bodies are unchanged (byte-identical) from that pre-move file. The one thing
 * THIS file exists to prove is the seam itself: a plain object satisfying CommentsApiClient's 7
 * methods is sufficient, nothing more is reached for internally.
 *
 * S3a fix-round (2026-08-21, gate finding P2-1): this file previously carried a second copy of
 * the RATIFIED HI-1 "zero new data paths" source-scan (design-lock multitable-w2-unified-record-
 * inspector-design-lock-20260714.md §7 S4), re-anchored here at the moved component's real path.
 * That was a second-narrower-artifact: the frozen guard's own describe block in
 * multitable-comments-panel.spec.ts names the lock, and this file's copy reproduced only the
 * (already-vacuous) static scan + string-literal positive control while dropping the
 * fetch-monkeypatch mount test, which is the half that actually matters. The fix is to repoint
 * the FROZEN spec's own readSrc at the new path instead (bookkeeping repair, not a contract
 * change — see that file's HI-1 block) rather than fork a second copy here. HI-1 coverage lives
 * ONLY in multitable-comments-panel.spec.ts now; this file stays scoped to the stub-client seam.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { useLocale } from '../src/composables/useLocale'
import { useMultitableComments } from '../src/shared/comments/composables/useMultitableComments'
import type { CommentsApiClient } from '../src/shared/comments/api-client'
import type { MultitableComment } from '../src/shared/comments/types'

function makeComment(overrides: Partial<MultitableComment> = {}): MultitableComment {
  return {
    id: 'c1',
    containerId: 'container-1',
    targetId: 'target-1',
    fieldId: null,
    mentions: [],
    authorId: 'u1',
    content: 'hello',
    resolved: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

/** A minimal stand-in for a future non-multitable (e.g. approval-native) storage backend. */
function makeStubClient(overrides: Partial<CommentsApiClient> = {}): CommentsApiClient {
  return {
    listComments: vi.fn().mockResolvedValue({ comments: [] }),
    createComment: vi.fn().mockResolvedValue({ comment: makeComment() }),
    resolveComment: vi.fn().mockResolvedValue(undefined),
    updateComment: vi.fn().mockResolvedValue({ comment: makeComment() }),
    deleteComment: vi.fn().mockResolvedValue(undefined),
    addReaction: vi.fn().mockResolvedValue(undefined),
    removeReaction: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

describe('useMultitableComments against a minimal stub CommentsApiClient (non-multitable seam)', () => {
  beforeEach(() => {
    useLocale().setLocale('en')
  })

  it('loads comments through listComments alone, with no wire-format assumptions', async () => {
    const stub = makeStubClient({
      listComments: vi.fn().mockResolvedValue({ comments: [makeComment({ id: 'c1', content: 'hi' })] }),
    })
    const state = useMultitableComments(stub)

    await state.loadComments({ containerId: 'container-1', targetId: 'target-1' })

    expect(stub.listComments).toHaveBeenCalledWith({ containerId: 'container-1', targetId: 'target-1' })
    expect(state.comments.value).toHaveLength(1)
    expect(state.comments.value[0].content).toBe('hi')
  })

  it('adds a comment through createComment and prepends it', async () => {
    const created = makeComment({ id: 'c2', content: 'new one' })
    const stub = makeStubClient({ createComment: vi.fn().mockResolvedValue({ comment: created }) })
    const state = useMultitableComments(stub)

    const result = await state.addComment({ containerId: 'container-1', targetId: 'target-1', content: 'new one' })

    expect(stub.createComment).toHaveBeenCalledWith({ containerId: 'container-1', targetId: 'target-1', content: 'new one' })
    expect(result?.id).toBe('c2')
    expect(state.comments.value[0].id).toBe('c2')
  })

  it('resolves a comment in place via resolveComment, no return payload needed', async () => {
    const stub = makeStubClient()
    const state = useMultitableComments(stub)
    state.comments.value = [makeComment({ id: 'c1', resolved: false })]

    await state.resolveComment('c1')

    expect(stub.resolveComment).toHaveBeenCalledWith('c1')
    expect(state.comments.value[0].resolved).toBe(true)
  })

  it('updates a comment through updateComment', async () => {
    const stub = makeStubClient({
      updateComment: vi.fn().mockResolvedValue({ comment: makeComment({ id: 'c1', content: 'edited' }) }),
    })
    const state = useMultitableComments(stub)
    state.comments.value = [makeComment({ id: 'c1', content: 'original' })]

    await state.updateComment('c1', { content: 'edited' })

    expect(stub.updateComment).toHaveBeenCalledWith('c1', { content: 'edited' })
    expect(state.comments.value[0].content).toBe('edited')
  })

  it('deletes a comment locally after deleteComment resolves', async () => {
    const stub = makeStubClient()
    const state = useMultitableComments(stub)
    state.comments.value = [makeComment({ id: 'c1' }), makeComment({ id: 'c2', parentId: 'c1' })]

    await state.deleteComment('c2')

    expect(stub.deleteComment).toHaveBeenCalledWith('c2')
    expect(state.comments.value.map((c) => c.id)).toEqual(['c1'])
  })

  it('adds and removes a reaction through addReaction/removeReaction, recomputed locally', async () => {
    const stub = makeStubClient()
    const state = useMultitableComments(stub)
    state.comments.value = [makeComment({ id: 'c1', reactions: [] })]

    await state.addReaction('c1', '👍')
    expect(stub.addReaction).toHaveBeenCalledWith('c1', '👍')
    expect(state.comments.value[0].reactions).toEqual([{ emoji: '👍', count: 1, reactedByMe: true }])

    await state.removeReaction('c1', '👍')
    expect(stub.removeReaction).toHaveBeenCalledWith('c1', '👍')
    expect(state.comments.value[0].reactions).toEqual([])
  })

  it('surfaces a localized error fallback when the stub rejects with no message', async () => {
    useLocale().setLocale('zh-CN')
    const stub = makeStubClient({ listComments: vi.fn().mockRejectedValue({}) })
    const state = useMultitableComments(stub)

    await state.loadComments({ containerId: 'container-1', targetId: 'target-1' })

    expect(state.error.value).toBe('加载评论失败')
  })
})
