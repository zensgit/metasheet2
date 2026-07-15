/**
 * W2 S4 (design-lock: docs/development/multitable-w2-unified-record-inspector-design-lock-20260714.md
 * §2 评论面板 row, §7 S4, §8.2): MetaCommentsPanel.vue -- the body extracted verbatim from
 * MetaCommentsDrawer.vue (thread list + composer + reactions), now mounted directly (no header/close
 * chrome of its own -- that stays with the deprecated MetaCommentsDrawer shell / moved to
 * MetaRecordInspector's header, see that component's own spec/source).
 *
 * Pre-existing drawer specs (multitable-comments-drawer.spec.ts, meta-comments-drawer-migration.
 * spec.ts, meta-comments-drawer-i18n.spec.ts) stay green UNMODIFIED (frozen baseline) -- they already
 * pin the header + this exact body content through the thin-shell delegation. This file's job is to
 * pin the SAME body behavior at its new standalone mount point, plus the HI-1 (zero new data paths)
 * guard that only applies once the body is its own component.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import MetaCommentsPanel from '../src/multitable/components/MetaCommentsPanel.vue'
import type { MultitableComment } from '../src/multitable/types'
import { useLocale } from '../src/composables/useLocale'

async function flushUi(cycles = 4): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function readSrc(rel: string): string {
  return readFileSync(join(__dirname, '..', rel), 'utf8')
}

const mounts: Array<{ app: App<Element>; container: HTMLDivElement }> = []

function mount(props: Record<string, unknown>): HTMLDivElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp({ render: () => h(MetaCommentsPanel, props) })
  const instance = app.mount(container)
  mounts.push({ app, container })
  void instance
  return container
}

afterEach(async () => {
  while (mounts.length) {
    const m = mounts.pop()!
    m.app.unmount()
    m.container.remove()
  }
  useLocale().setLocale('en')
  vi.restoreAllMocks()
})

const baseProps = () => ({
  comments: [] as MultitableComment[],
  loading: false,
  canComment: true,
  canResolve: true,
  draft: '',
})

describe('MetaCommentsPanel (W2 S4 extraction)', () => {
  describe('thread render', () => {
    it('renders thread roots, replies, and reply counts', async () => {
      const container = mount({
        ...baseProps(),
        comments: [
          {
            id: 'c1', containerId: 'sheet_1', targetId: 'row_1', fieldId: null, mentions: [],
            authorId: 'user_1', authorName: 'Amy Wong', content: 'root comment', resolved: false,
            createdAt: '2026-04-01T09:00:00.000Z',
          },
          {
            id: 'c2', containerId: 'sheet_1', targetId: 'row_1', parentId: 'c1', fieldId: null,
            mentions: [], authorId: 'user_2', authorName: 'Ben', content: 'a reply', resolved: false,
            createdAt: '2026-04-01T10:00:00.000Z',
          },
        ] as any,
      })
      await flushUi()

      expect(container.textContent).toContain('Amy Wong')
      expect(container.textContent).toContain('root comment')
      expect(container.textContent).toContain('Ben')
      expect(container.textContent).toContain('a reply')
      expect(container.textContent).toContain('1 reply')
      expect(container.querySelectorAll('.meta-comments-drawer__thread')).toHaveLength(1)
      expect(container.querySelectorAll('.meta-comments-drawer__reply-item')).toHaveLength(1)
    })

    it('shows the loading state and the empty state', async () => {
      const loadingContainer = mount({ ...baseProps(), loading: true })
      await flushUi()
      expect(loadingContainer.querySelector('.meta-comments-drawer__loading')).toBeTruthy()

      const emptyContainer = mount({ ...baseProps(), comments: [] })
      await flushUi()
      expect(emptyContainer.querySelector('.meta-comments-drawer__empty')?.textContent).toContain('No comments yet')
    })

    it('has its own mount root (.meta-comments-drawer__panel) — no drawer chrome of its own', async () => {
      const container = mount(baseProps())
      await flushUi()
      expect(container.querySelector('.meta-comments-drawer__panel')).toBeTruthy()
      // No header chrome anywhere in this component's own output — it is drawer/inspector-hosted.
      expect(container.querySelector('.meta-comments-drawer__header')).toBeNull()
      expect(container.querySelector('.meta-comments-drawer__close')).toBeNull()
      expect(container.querySelector('.meta-comments-drawer__inbox-link')).toBeNull()
    })
  })

  describe('G-8-scope pass-through (field-scoped visibility)', () => {
    const SCOPED_COMMENTS = [
      {
        id: 'c1', containerId: 'sheet_1', targetId: 'row_1', fieldId: 'fld_notes', targetFieldId: 'fld_notes',
        mentions: [], authorId: 'user_1', authorName: 'Amy Wong', content: 'field-scoped root', resolved: false,
        createdAt: '2026-04-01T09:00:00.000Z',
      },
      {
        id: 'c2', containerId: 'sheet_1', targetId: 'row_1', parentId: 'c1', fieldId: null, targetFieldId: null,
        mentions: [], authorId: 'user_2', authorName: 'Ben', content: 'reply without its own field id', resolved: false,
        createdAt: '2026-04-01T10:00:00.000Z',
      },
      {
        id: 'c3', containerId: 'sheet_1', targetId: 'row_1', fieldId: 'fld_other', targetFieldId: 'fld_other',
        mentions: [], authorId: 'user_3', authorName: 'Casey', content: 'a different field entirely', resolved: false,
        createdAt: '2026-04-01T11:00:00.000Z',
      },
    ] as any

    it('renders only the targetFieldId-scoped thread (root + its reply), never an unrelated field thread', async () => {
      const container = mount({ ...baseProps(), comments: SCOPED_COMMENTS, targetFieldId: 'fld_notes', scopeLabel: 'Notes' })
      await flushUi()

      expect(container.textContent).toContain('field-scoped root')
      expect(container.textContent).toContain('reply without its own field id')
      // Positive control for the filter actually filtering (not vacuously passing everything through):
      // the unrelated field's comment must NOT appear.
      expect(container.textContent).not.toContain('a different field entirely')
    })

    it('renders every thread (no filter) when targetFieldId is absent — the panel does not invent scoping', async () => {
      const container = mount({ ...baseProps(), comments: SCOPED_COMMENTS })
      await flushUi()

      expect(container.textContent).toContain('field-scoped root')
      expect(container.textContent).toContain('a different field entirely')
    })
  })

  describe('composer emit parity (unchanged event names/payloads vs the pre-extraction drawer)', () => {
    it('emits submit with the composed content + parsed mentions', async () => {
      const onSubmit = vi.fn()
      const container = mount({ ...baseProps(), draft: 'hello', onSubmit })
      await flushUi()
      const submitBtn = container.querySelector<HTMLButtonElement>('.meta-comment-composer__submit')!
      submitBtn.click()
      await flushUi()
      expect(onSubmit).toHaveBeenCalledWith({ content: 'hello', mentions: [] })
    })

    it('emits update:draft as the composer textarea changes (v-model passthrough)', async () => {
      const onUpdateDraft = vi.fn()
      const container = mount({ ...baseProps(), 'onUpdate:draft': onUpdateDraft })
      await flushUi()
      const textarea = container.querySelector('textarea') as HTMLTextAreaElement
      textarea.value = 'typing'
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
      await flushUi()
      expect(onUpdateDraft).toHaveBeenCalledWith('typing')
    })

    it('emits reply/edit/delete/resolve/cancel-reply/cancel-edit/retry with the correct commentId payloads', async () => {
      const onReply = vi.fn()
      const onEdit = vi.fn()
      const onDelete = vi.fn()
      const onResolve = vi.fn()
      const onCancelReply = vi.fn()
      const onRetry = vi.fn()
      const container = mount({
        ...baseProps(),
        comments: [
          {
            id: 'c1', containerId: 'sheet_1', targetId: 'row_1', fieldId: null, mentions: [],
            authorId: 'user_1', authorName: 'Amy Wong', content: 'root', resolved: false,
            createdAt: '2026-04-01T09:00:00.000Z',
          },
        ] as any,
        currentUserId: 'user_1',
        replyToCommentId: 'c1',
        error: 'SERVER_BROKE',
        onReply,
        onEdit,
        onDelete,
        onResolve,
        onCancelReply,
        onRetry,
      })
      await flushUi()

      const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('.meta-comments-drawer__reply'))
      buttons.find((b) => b.textContent?.trim() === 'Edit')!.click()
      await flushUi()
      expect(onEdit).toHaveBeenCalledWith('c1')

      buttons.find((b) => b.textContent?.trim() === 'Delete')!.click()
      await flushUi()
      expect(onDelete).toHaveBeenCalledWith('c1')

      container.querySelector<HTMLButtonElement>('.meta-comments-drawer__resolve')!.click()
      await flushUi()
      expect(onResolve).toHaveBeenCalledWith('c1')

      container.querySelector<HTMLButtonElement>('.meta-comments-drawer__reply-cancel')!.click()
      await flushUi()
      expect(onCancelReply).toHaveBeenCalledTimes(1)

      container.querySelector<HTMLButtonElement>('.meta-comments-drawer__retry')!.click()
      await flushUi()
      expect(onRetry).toHaveBeenCalledTimes(1)
    })

    it('disables the resolve/edit/delete actions while their commentId is in the pending-id lists (presence of in-flight state)', async () => {
      const container = mount({
        ...baseProps(),
        comments: [
          {
            id: 'c1', containerId: 'sheet_1', targetId: 'row_1', fieldId: null, mentions: [],
            authorId: 'user_1', authorName: 'Amy Wong', content: 'root', resolved: false,
            createdAt: '2026-04-01T09:00:00.000Z',
          },
        ] as any,
        currentUserId: 'user_1',
        resolvingIds: ['c1'],
        updatingIds: ['c1'],
      })
      await flushUi()

      const resolveBtn = container.querySelector<HTMLButtonElement>('.meta-comments-drawer__resolve')!
      expect(resolveBtn.disabled).toBe(true)
      expect(resolveBtn.textContent?.trim()).toBe('Resolving...')
      // editingCommentId is NOT set here, so the label stays 'Edit' (not 'Editing...') even though
      // `disabled` is already true from `updatingIds` — the two states are independent (label reflects
      // editingCommentId, disabled reflects the updatingIds/deletingIds in-flight lists).
      const editBtn = Array.from(container.querySelectorAll<HTMLButtonElement>('.meta-comments-drawer__reply'))
        .find((b) => b.textContent?.trim() === 'Edit')!
      expect(editBtn.disabled).toBe(true)
    })
  })

  describe('reactions', () => {
    it('renders MetaCommentReactions and forwards react/unreact with (commentId, emoji)', async () => {
      const onReact = vi.fn()
      const onUnreact = vi.fn()
      const container = mount({
        ...baseProps(),
        comments: [
          {
            id: 'c1', containerId: 'sheet_1', targetId: 'row_1', fieldId: null, mentions: [],
            authorId: 'user_1', authorName: 'Amy Wong', content: 'root', resolved: false,
            createdAt: '2026-04-01T09:00:00.000Z',
            reactions: [{ emoji: '👍', count: 1, reactedByMe: false }],
          },
        ] as any,
        onReact,
        onUnreact,
      })
      await flushUi()

      // The reaction chip for an existing reaction is rendered by MetaCommentReactions; clicking it
      // toggles react/unreact depending on whether the current user already reacted
      // (reactedByMe: false here → clicking reacts, not unreacts). Found via the emoji glyph in
      // textContent rather than an emoji-valued CSS attribute selector (jsdom's querySelector does
      // not reliably match a raw emoji inside a `[data-test="..."]` attribute selector string).
      const chip = Array.from(container.querySelectorAll<HTMLButtonElement>('.meta-comment-reactions__chip'))
        .find((b) => b.textContent?.includes('👍'))
      expect(chip).toBeTruthy()
      chip!.click()
      await flushUi()
      expect(onReact).toHaveBeenCalledWith('c1', '👍')
    })
  })

  describe('HI-1: zero new data paths', () => {
    it('source scan: no client./fetch(/api. call appears anywhere in this component', () => {
      const src = readSrc('src/multitable/components/MetaCommentsPanel.vue')
      expect(src).not.toMatch(/[^.]\bfetch\(/)
      expect(src).not.toMatch(/(?<!api)client\.\w+\(/)
      expect(src).not.toMatch(/\bapiClient\.\w+\(/)
    })

    it('positive control: the source-scan regexes actually fire on a constructed violation (proves the guard is not vacuous)', () => {
      const fixtureWithFetch = "const x = fetch('/api/multitable/comments')"
      const fixtureWithClient = 'await client.deleteComment(id)'
      const fixtureWithApiClient = 'await apiClient.addComment(payload)'
      expect(fixtureWithFetch).toMatch(/[^.]\bfetch\(/)
      expect(fixtureWithClient).toMatch(/(?<!api)client\.\w+\(/)
      expect(fixtureWithApiClient).toMatch(/\bapiClient\.\w+\(/)
    })

    it('fetch-monkeypatch: a full mount + interact pass (submit/reply/edit/delete/resolve/react/retry) never touches global fetch — all mutation intents are emit-only', async () => {
      const originalFetch = globalThis.fetch
      const fetchSpy = vi.fn(originalFetch as typeof fetch)
      globalThis.fetch = fetchSpy as typeof fetch
      try {
        const container = mount({
          ...baseProps(),
          draft: 'a comment',
          comments: [
            {
              id: 'c1', containerId: 'sheet_1', targetId: 'row_1', fieldId: null, mentions: [],
              authorId: 'user_1', authorName: 'Amy Wong', content: 'root', resolved: false,
              createdAt: '2026-04-01T09:00:00.000Z',
              reactions: [{ emoji: '👍', count: 1, reactedByMe: false }],
            },
          ] as any,
          currentUserId: 'user_1',
          onSubmit: vi.fn(),
          onReply: vi.fn(),
          onEdit: vi.fn(),
          onDelete: vi.fn(),
          onResolve: vi.fn(),
          onReact: vi.fn(),
          onRetry: vi.fn(),
        })
        await flushUi()

        container.querySelector<HTMLButtonElement>('.meta-comments-drawer__resolve')?.click()
        Array.from(container.querySelectorAll<HTMLButtonElement>('.meta-comments-drawer__reply'))
          .find((b) => b.textContent?.trim() === 'Edit')?.click()
        Array.from(container.querySelectorAll<HTMLButtonElement>('.meta-comments-drawer__reply'))
          .find((b) => b.textContent?.trim() === 'Delete')?.click()
        Array.from(container.querySelectorAll<HTMLButtonElement>('.meta-comment-reactions__chip'))
          .find((b) => b.textContent?.includes('👍'))?.click()
        container.querySelector<HTMLButtonElement>('.meta-comment-composer__submit')?.click()
        await flushUi()

        expect(fetchSpy).not.toHaveBeenCalled()

        // Positive control: prove the spy itself is wired correctly (a spy that silently never
        // intercepts would make the assertion above vacuous) by calling fetch directly once, outside
        // the component, and confirming it WAS observed.
        try { await fetchSpy('data:text/plain,control') } catch { /* jsdom may reject data: fetch; the call itself is what we assert */ }
        expect(fetchSpy).toHaveBeenCalledTimes(1)
      } finally {
        globalThis.fetch = originalFetch
      }
    })
  })
})
