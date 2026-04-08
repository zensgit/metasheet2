import { describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import MetaCommentsDrawer from '../src/multitable/components/MetaCommentsDrawer.vue'

async function flushUi(cycles = 4) {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

describe('MetaCommentsDrawer', () => {
  it('renders a lightweight composer and mention suggestions derived from the thread', async () => {
    const draftSpy = vi.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)

    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        {
          path: '/',
          name: 'home',
          component: defineComponent({ render: () => h('div') }),
        },
        {
          path: '/multitable/comments/inbox',
          name: 'multitable-comment-inbox',
          component: defineComponent({ render: () => h('div') }),
        },
      ],
    })

    const app = createApp(defineComponent({
      setup() {
        const draft = ref('')
        return { draft }
      },
      render() {
        return h(MetaCommentsDrawer, {
          visible: true,
          comments: [
            {
              id: 'c1',
              containerId: 'sheet_1',
              targetId: 'row_1',
              fieldId: null,
              mentions: [],
              authorId: 'user_1',
              authorName: 'Amy Wong',
              content: 'hello',
              resolved: false,
              createdAt: '2026-04-01T09:00:00.000Z',
            },
            {
              id: 'c2',
              containerId: 'sheet_1',
              targetId: 'row_1',
              fieldId: null,
              mentions: [],
              authorId: 'user_2',
              authorName: 'Ben',
              content: 'follow up',
              resolved: false,
              createdAt: '2026-04-01T10:00:00.000Z',
            },
          ],
          loading: false,
          canComment: true,
          canResolve: true,
          mentionSuggestions: [
            { id: 'user_3', label: 'Alex Chen', subtitle: 'alex@example.com' },
          ],
          draft: this.draft,
          onResolve: vi.fn(),
          onClose: vi.fn(),
          onRetry: vi.fn(),
          'onUpdate:draft': (value: string) => {
            this.draft = value
            draftSpy(value)
          },
          onSubmit: vi.fn(),
        })
      },
    }))

    app.use(router)
    await router.push('/')
    await router.isReady()
    app.mount(container)
    await flushUi()

    expect(container.textContent).toContain('Inbox')
    expect(container.textContent).toContain('Amy Wong')
    expect(container.textContent).toContain('Ben')

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement | null
    textarea!.value = '@a'
    textarea!.selectionStart = 2
    textarea!.selectionEnd = 2
    textarea!.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi()

    const suggestion = Array.from(container.querySelectorAll('.meta-comment-composer__suggestion'))
      .find((button) => button.textContent?.includes('Amy Wong')) as HTMLButtonElement | undefined
    expect(container.textContent).toContain('Alex Chen')
    suggestion?.click()
    await flushUi()

    expect(draftSpy).toHaveBeenLastCalledWith('@Amy Wong ')

    app.unmount()
    container.remove()
  })

  it('renders mention tokens with display names instead of raw ids', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        {
          path: '/',
          name: 'home',
          component: defineComponent({ render: () => h('div') }),
        },
        {
          path: '/multitable/comments/inbox',
          name: 'multitable-comment-inbox',
          component: defineComponent({ render: () => h('div') }),
        },
      ],
    })

    const app = createApp(defineComponent({
      render() {
        return h(MetaCommentsDrawer, {
          visible: true,
          comments: [
            {
              id: 'c1',
              containerId: 'sheet_1',
              targetId: 'row_1',
              fieldId: null,
              mentions: ['user_1'],
              authorId: 'user_2',
              authorName: 'Ben',
              content: 'Ping @[Amy Wong](user_1) for review',
              resolved: false,
              createdAt: '2026-04-01T09:00:00.000Z',
            },
          ],
          loading: false,
          canComment: false,
          canResolve: true,
          draft: '',
          onResolve: vi.fn(),
          onClose: vi.fn(),
          onRetry: vi.fn(),
          'onUpdate:draft': vi.fn(),
          onSubmit: vi.fn(),
        })
      },
    }))

    app.use(router)
    await router.push('/')
    await router.isReady()
    app.mount(container)
    await flushUi()

    expect(container.textContent).toContain('Ping @Amy Wong for review')
    expect(container.textContent).not.toContain('@user_1')

    app.unmount()
    container.remove()
  })

  it('keeps replies visible in field-scoped threads even when the reply itself has no field id', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        {
          path: '/',
          name: 'home',
          component: defineComponent({ render: () => h('div') }),
        },
        {
          path: '/multitable/comments/inbox',
          name: 'multitable-comment-inbox',
          component: defineComponent({ render: () => h('div') }),
        },
      ],
    })

    const app = createApp(defineComponent({
      render() {
        return h(MetaCommentsDrawer, {
          visible: true,
          comments: [
            {
              id: 'c1',
              containerId: 'sheet_1',
              targetId: 'row_1',
              fieldId: 'fld_notes',
              targetFieldId: 'fld_notes',
              mentions: [],
              authorId: 'user_1',
              authorName: 'Amy Wong',
              content: 'field root',
              resolved: false,
              createdAt: '2026-04-01T09:00:00.000Z',
            },
            {
              id: 'c2',
              containerId: 'sheet_1',
              targetId: 'row_1',
              fieldId: null,
              targetFieldId: null,
              parentId: 'c1',
              mentions: [],
              authorId: 'user_2',
              authorName: 'Ben',
              content: 'reply without field',
              resolved: false,
              createdAt: '2026-04-01T10:00:00.000Z',
            },
          ],
          loading: false,
          canComment: true,
          canResolve: true,
          targetFieldId: 'fld_notes',
          scopeLabel: 'Notes',
          draft: '',
          onResolve: vi.fn(),
          onClose: vi.fn(),
          onRetry: vi.fn(),
          'onUpdate:draft': vi.fn(),
          onSubmit: vi.fn(),
        })
      },
    }))

    app.use(router)
    await router.push('/')
    await router.isReady()
    app.mount(container)
    await flushUi()

    expect(container.textContent).toContain('field root')
    expect(container.textContent).toContain('reply without field')
    expect(container.querySelectorAll('.meta-comments-drawer__reply')).toHaveLength(1)

    app.unmount()
    container.remove()
  })

  it('shows edit/delete actions for the current user and seeds edit mode', async () => {
    const draftSpy = vi.fn()
    const editSpy = vi.fn()
    const deleteSpy = vi.fn()
    const cancelEditSpy = vi.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)

    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', name: 'home', component: defineComponent({ render: () => h('div') }) },
        { path: '/multitable/comments/inbox', name: 'multitable-comment-inbox', component: defineComponent({ render: () => h('div') }) },
      ],
    })

    const app = createApp(defineComponent({
      setup() {
        const draft = ref('Edit @Amy Wong')
        return { draft }
      },
      render() {
        return h(MetaCommentsDrawer, {
          visible: true,
          comments: [
            {
              id: 'c1',
              containerId: 'sheet_1',
              targetId: 'row_1',
              fieldId: null,
              mentions: ['user_2'],
              authorId: 'user_1',
              authorName: 'Author',
              content: 'Ping @[Amy Wong](user_2)',
              resolved: false,
              createdAt: '2026-04-01T09:00:00.000Z',
            },
          ],
          loading: false,
          canComment: true,
          canResolve: true,
          currentUserId: 'user_1',
          editingCommentId: 'c1',
          composerInitialMentions: [{ id: 'user_2', label: 'Amy Wong' }],
          draft: this.draft,
          onResolve: vi.fn(),
          onClose: vi.fn(),
          onRetry: vi.fn(),
          onEdit: editSpy,
          onDelete: deleteSpy,
          'onUpdate:draft': (value: string) => {
            this.draft = value
            draftSpy(value)
          },
          onCancelEdit: cancelEditSpy,
          onSubmit: vi.fn(),
        })
      },
    }))

    app.use(router)
    await router.push('/')
    await router.isReady()
    app.mount(container)
    await flushUi()

    expect(container.textContent).toContain('Edit')
    expect(container.textContent).toContain('Delete')
    expect(container.textContent).toContain('Editing Author')
    expect(container.textContent).toContain('Save')
    expect(container.textContent).toContain('@Amy Wong')

    const editButton = Array.from(container.querySelectorAll('.meta-comments-drawer__reply'))
      .find((button) => button.textContent?.includes('Editing...')) as HTMLButtonElement | undefined
    editButton?.click()
    await flushUi()
    expect(editSpy).toHaveBeenCalledWith('c1')

    const deleteButton = Array.from(container.querySelectorAll('.meta-comments-drawer__reply'))
      .find((button) => button.textContent?.includes('Delete')) as HTMLButtonElement | undefined
    deleteButton?.click()
    await flushUi()
    expect(deleteSpy).toHaveBeenCalledWith('c1')

    const cancelButton = container.querySelector('.meta-comments-drawer__reply-cancel') as HTMLButtonElement | null
    cancelButton?.click()
    await flushUi()
    expect(cancelEditSpy).toHaveBeenCalledTimes(1)
    expect(draftSpy).not.toHaveBeenCalled()

    app.unmount()
    container.remove()
  })

  it('hides delete for root comments that still have replies', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)

    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', name: 'home', component: defineComponent({ render: () => h('div') }) },
        { path: '/multitable/comments/inbox', name: 'multitable-comment-inbox', component: defineComponent({ render: () => h('div') }) },
      ],
    })

    const app = createApp(defineComponent({
      render() {
        return h(MetaCommentsDrawer, {
          visible: true,
          comments: [
            {
              id: 'c1',
              containerId: 'sheet_1',
              targetId: 'row_1',
              fieldId: null,
              mentions: [],
              authorId: 'user_1',
              authorName: 'Author',
              content: 'thread root',
              resolved: false,
              createdAt: '2026-04-01T09:00:00.000Z',
            },
            {
              id: 'c2',
              containerId: 'sheet_1',
              targetId: 'row_1',
              parentId: 'c1',
              fieldId: null,
              mentions: [],
              authorId: 'user_2',
              authorName: 'Other',
              content: 'reply',
              resolved: false,
              createdAt: '2026-04-01T10:00:00.000Z',
            },
          ],
          loading: false,
          canComment: true,
          canResolve: true,
          currentUserId: 'user_1',
          draft: '',
          onResolve: vi.fn(),
          onClose: vi.fn(),
          onRetry: vi.fn(),
          'onUpdate:draft': vi.fn(),
          onSubmit: vi.fn(),
        })
      },
    }))

    app.use(router)
    await router.push('/')
    await router.isReady()
    app.mount(container)
    await flushUi()

    const actionLabels = Array.from(container.querySelectorAll('.meta-comments-drawer__reply')).map((button) => button.textContent?.trim())
    expect(actionLabels).toContain('Edit')
    expect(actionLabels).toContain('Reply')
    expect(actionLabels).not.toContain('Delete')

    app.unmount()
    container.remove()
  })
})
