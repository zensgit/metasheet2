/**
 * S3b — mounted coverage for `views/approval/ApprovalCommentsPanel.vue`, the wrapper mounting the
 * S3a shared comments kit against the S2 approval-comments backend.
 *
 * Mocks `approvalCommentsClient` (the transport) and `directoryResolve` (the identity resolver)
 * directly — the real `MetaCommentsPanel`/`useMultitableComments`/labels are all EXERCISED for
 * real, so this is genuine integration coverage of the wrapper's own wiring, not a shallow stub.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, ref as vueRef, type App } from 'vue'
import { useLocale } from '../src/composables/useLocale'
import type { MultitableComment } from '../src/shared/comments/types'

async function flushUi(cycles = 6): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

// ---------------------------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------------------------
const listCommentsMock = vi.fn()
const createCommentMock = vi.fn()
const updateCommentMock = vi.fn()
const deleteCommentMock = vi.fn()
const resolveCommentMock = vi.fn()
const addReactionMock = vi.fn()
const removeReactionMock = vi.fn()
const mentionCandidatesMock = vi.fn()

vi.mock('../src/approvals/approvalCommentsClient', () => ({
  createApprovalCommentsClient: () => ({
    truncated: { value: false },
    listComments: (...args: unknown[]) => listCommentsMock(...args),
    createComment: (...args: unknown[]) => createCommentMock(...args),
    updateComment: (...args: unknown[]) => updateCommentMock(...args),
    deleteComment: (...args: unknown[]) => deleteCommentMock(...args),
    resolveComment: (...args: unknown[]) => resolveCommentMock(...args),
    addReaction: (...args: unknown[]) => addReactionMock(...args),
    removeReaction: (...args: unknown[]) => removeReactionMock(...args),
  }),
  fetchApprovalCommentMentionCandidates: (...args: unknown[]) => mentionCandidatesMock(...args),
}))

const resolvedNames = new Map<string, string | null>()
vi.mock('../src/approvals/directoryResolve', () => ({
  ensureUserNamesResolved: vi.fn(),
  getResolvedUserName: (id: string | null | undefined) => (id ? resolvedNames.get(id) ?? null : null),
}))

import ApprovalCommentsPanel from '../src/views/approval/ApprovalCommentsPanel.vue'
import MetaCommentsPanel from '../src/shared/comments/components/MetaCommentsPanel.vue'

const mounts: Array<{ app: App<Element>; container: HTMLDivElement }> = []
function mount(component: any, props: Record<string, unknown>): HTMLDivElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp({ render: () => h(component, props) })
  app.mount(container)
  mounts.push({ app, container })
  return container
}

function comment(overrides: Partial<MultitableComment> & { id: string; authorId: string }): MultitableComment {
  return {
    containerId: 'apv_1',
    targetId: 'apv_1',
    fieldId: null,
    targetFieldId: null,
    mentions: [],
    content: 'a comment',
    resolved: false,
    createdAt: '2026-08-22T09:00:00.000Z',
    ...overrides,
  } as MultitableComment
}

beforeEach(() => {
  useLocale().setLocale('en')
  listCommentsMock.mockReset().mockResolvedValue({ comments: [] })
  createCommentMock.mockReset()
  updateCommentMock.mockReset()
  deleteCommentMock.mockReset()
  resolveCommentMock.mockReset()
  addReactionMock.mockReset()
  removeReactionMock.mockReset()
  mentionCandidatesMock.mockReset().mockResolvedValue([])
  resolvedNames.clear()
})

afterEach(async () => {
  while (mounts.length) {
    const m = mounts.pop()!
    m.app.unmount()
    m.container.remove()
  }
  useLocale().setLocale('en')
  vi.restoreAllMocks()
})

describe('enableReactions gate mechanism (raw kit, positive control)', () => {
  it('reactions render when enableReactions=true (default) and do NOT render when false', async () => {
    const props = {
      comments: [comment({ id: 'c1', authorId: 'u1', reactions: [{ emoji: '👍', count: 1, reactedByMe: false }] })],
      loading: false,
      canComment: true,
      canResolve: false,
      draft: '',
    }
    const onContainer = mount(MetaCommentsPanel, { ...props, enableReactions: true })
    await flushUi()
    expect(onContainer.querySelector('[data-test="comment-reactions"]')).toBeTruthy()

    const offContainer = mount(MetaCommentsPanel, { ...props, enableReactions: false })
    await flushUi()
    expect(offContainer.querySelector('[data-test="comment-reactions"]')).toBeNull()
  })
})

describe('ApprovalCommentsPanel — capability absence (hardcoded, never fabricated)', () => {
  it('never renders the reactions block (S2 has no reaction endpoints)', async () => {
    listCommentsMock.mockResolvedValue({
      comments: [comment({ id: 'c1', authorId: 'u1' })],
    })
    const container = mount(ApprovalCommentsPanel, { instanceId: 'apv_1', currentUserId: 'u1' })
    await flushUi()

    expect(container.querySelector('[data-test="comment-reactions"]')).toBeNull()
    expect(container.querySelector('[data-test="reaction-add"]')).toBeNull()
  })

  it('never renders a resolve button (S2 has no resolve concept)', async () => {
    listCommentsMock.mockResolvedValue({
      comments: [comment({ id: 'c1', authorId: 'u1' })],
    })
    const container = mount(ApprovalCommentsPanel, { instanceId: 'apv_1', currentUserId: 'u1' })
    await flushUi()

    expect(container.querySelector('.meta-comments-drawer__resolve')).toBeNull()
  })
})

describe('ApprovalCommentsPanel — tombstone rendering', () => {
  it('a deleted comment shows the placeholder, offers no Edit/Delete, but Reply stays offered — even for the viewer\'s own comment', async () => {
    listCommentsMock.mockResolvedValue({
      comments: [comment({ id: 'c_deleted', authorId: 'u1', deleted: true, content: '' })],
    })
    const container = mount(ApprovalCommentsPanel, { instanceId: 'apv_1', currentUserId: 'u1' })
    await flushUi()

    expect(container.textContent).toContain('This comment was deleted')
    const buttons = Array.from(container.querySelectorAll('button')).map((b) => b.textContent?.trim())
    expect(buttons).not.toContain('Edit')
    expect(buttons).not.toContain('Delete')
    expect(buttons).toContain('Reply')
  })
})

describe('ApprovalCommentsPanel — one-level threading only', () => {
  it('a reply-to-a-reply fixture (defensive against a data-layer anomaly) never renders — the kit template only reads one level of repliesByParentId', async () => {
    listCommentsMock.mockResolvedValue({
      comments: [
        comment({ id: 'c_root', authorId: 'u1', content: 'root content marker' }),
        comment({ id: 'c_reply', authorId: 'u2', parentId: 'c_root', content: 'reply content marker' }),
        comment({ id: 'c_reply_of_reply', authorId: 'u3', parentId: 'c_reply', content: 'DEEP_NESTED_MARKER_SHOULD_NOT_RENDER' }),
      ],
    })
    const container = mount(ApprovalCommentsPanel, { instanceId: 'apv_1', currentUserId: 'u1' })
    await flushUi()

    expect(container.textContent).toContain('root content marker')
    expect(container.textContent).toContain('reply content marker')
    expect(container.textContent).not.toContain('DEEP_NESTED_MARKER_SHOULD_NOT_RENDER')
  })
})

describe('ApprovalCommentsPanel — member-display-identity guard', () => {
  it('never renders a raw author id; an unresolved author gets a values-free 成员 N ordinal, a resolved one gets its real name', async () => {
    resolvedNames.set('raw_id_resolved_marker_9911', 'Alice Resolved')
    // 'raw_id_unresolved_marker_7788' is intentionally absent from resolvedNames -> null.
    listCommentsMock.mockResolvedValue({
      comments: [
        comment({ id: 'c1', authorId: 'raw_id_resolved_marker_9911', content: 'first' }),
        comment({ id: 'c2', authorId: 'raw_id_unresolved_marker_7788', content: 'second' }),
      ],
    })
    const container = mount(ApprovalCommentsPanel, { instanceId: 'apv_1', currentUserId: 'someone_else' })
    await flushUi()

    expect(container.textContent).not.toContain('raw_id_resolved_marker_9911')
    expect(container.textContent).not.toContain('raw_id_unresolved_marker_7788')
    expect(container.textContent).toContain('Alice Resolved')
    expect(container.textContent).toContain('成员 2')
  })
})

describe('ApprovalCommentsPanel — mention candidates fetched once per instance', () => {
  it('fetches mention candidates exactly once on mount, with no `q`', async () => {
    mount(ApprovalCommentsPanel, { instanceId: 'apv_1', currentUserId: 'u1' })
    await flushUi()

    expect(mentionCandidatesMock).toHaveBeenCalledTimes(1)
    expect(mentionCandidatesMock).toHaveBeenCalledWith('apv_1')
  })

  it('re-fetches comments and mention candidates when instanceId changes', async () => {
    listCommentsMock.mockResolvedValue({ comments: [] })
    const container = document.createElement('div')
    document.body.appendChild(container)
    // A real Vue ref (not a plain mutated object) so the root's render function has an actual
    // tracked reactive dependency — mutating a plain object referenced by a closure does NOT
    // trigger Vue to re-render and re-resolve the child's props.
    const instanceId = vueRef('apv_1')
    const app = createApp({
      render: () => h(ApprovalCommentsPanel, { instanceId: instanceId.value, currentUserId: 'u1' }),
    })
    app.mount(container)
    mounts.push({ app, container })
    await flushUi()
    expect(listCommentsMock).toHaveBeenCalledTimes(1)

    instanceId.value = 'apv_2'
    await flushUi()
    expect(listCommentsMock).toHaveBeenCalledTimes(2)
    expect(mentionCandidatesMock).toHaveBeenCalledTimes(2)
    expect(mentionCandidatesMock).toHaveBeenLastCalledWith('apv_2')
  })
})

describe('ApprovalCommentsPanel — delete flow re-hydrates the tombstone (approach (a))', () => {
  it('after a successful delete, re-lists so the tombstone (not a stripped row) is what is shown', async () => {
    listCommentsMock
      .mockResolvedValueOnce({ comments: [comment({ id: 'c1', authorId: 'u1', content: 'before delete' })] })
      .mockResolvedValueOnce({ comments: [comment({ id: 'c1', authorId: 'u1', deleted: true, content: '' })] })
    deleteCommentMock.mockResolvedValue(undefined)
    const container = mount(ApprovalCommentsPanel, { instanceId: 'apv_1', currentUserId: 'u1' })
    await flushUi()

    const deleteBtn = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((b) => b.textContent?.trim() === 'Delete')
    expect(deleteBtn).toBeTruthy()
    deleteBtn!.click()
    await flushUi()

    expect(deleteCommentMock).toHaveBeenCalledWith('c1')
    expect(listCommentsMock).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain('This comment was deleted')
  })
})

describe('ApprovalCommentsPanel — member-display-identity guard covers the MENTION DROPDOWN too (not just the thread list)', () => {
  // The kit's own mention-suggestion dropdown (MetaCommentComposer.vue) is a SEPARATE render
  // surface from the thread list, only mounted once the composer's `showSuggestions` computed
  // goes true (draft ends in `@...`). It has TWO of its own raw-id fallback paths the earlier
  // "never renders a raw author id" test above never exercises (it never opens the dropdown):
  //   - kit :378 `defaultMentionSuggestions`'s candidate label: falls back to the raw
  //     `candidate.userId` when `displayName` is blank/whitespace.
  //   - kit :385 `defaultMentionSuggestions`'s author-derived `subtitle`: renders the raw
  //     `comment.authorId` WHENEVER `authorName` is set and differs from `authorId` — which is
  //     ALWAYS true here, because this wrapper's own identity guard always sets a resolved-or-
  //     ordinal `authorName`. Setting authorName (the fix for :384/the thread list) is exactly
  //     what ARMS :385's fallback for the mention dropdown. The wrapper must therefore supply its
  //     OWN `:mention-suggestions` (id-keyed dedup priority over the kit's own
  //     defaultMentionSuggestions — see MetaCommentsPanel.vue's `mentionSuggestions` computed)
  //     rather than relying on `:mention-candidates` + the kit's internal derivation alone.
  it('opening the @mention dropdown never shows a raw author id or a raw candidate id — a blank-named candidate gets a 成员 N ordinal, an unresolved author gets one too', async () => {
    mentionCandidatesMock.mockResolvedValue([
      { id: 'raw_candidate_id_marker_5521', name: '   ', email: 'blank-name@x.io' },
      { id: 'raw_candidate_id_marker_6633', name: 'Real Candidate Name', email: '' },
    ])
    listCommentsMock.mockResolvedValue({
      comments: [comment({ id: 'c1', authorId: 'raw_author_id_marker_4471', content: 'root' })],
    })
    const container = mount(ApprovalCommentsPanel, { instanceId: 'apv_1', currentUserId: 'someone_else' })
    await flushUi()

    const textarea = container.querySelector('textarea')!
    textarea.value = '@'
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()

    const dropdown = container.querySelector('[role="listbox"]')
    expect(dropdown, 'the mention dropdown did not open — the test would pass vacuously without this').toBeTruthy()
    const dropdownText = dropdown!.textContent ?? ''

    expect(dropdownText).not.toContain('raw_author_id_marker_4471')
    expect(dropdownText).not.toContain('raw_candidate_id_marker_5521')
    // The blank-name candidate gets an ordinal (position among mention CANDIDATES, 1-indexed).
    expect(dropdownText).toContain('成员 1')
    expect(dropdownText).toContain('Real Candidate Name')
  })
})
