import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import { useLocale } from '../src/composables/useLocale'
import MetaCommentsDrawer from '../src/multitable/components/MetaCommentsDrawer.vue'

let app: App<Element> | null = null
let container: HTMLDivElement | null = null
let router: Router | null = null

afterEach(() => {
  app?.unmount()
  app = null
  container?.remove()
  container = null
  router = null
  useLocale().setLocale('en')
})

async function flushUi(cycles = 4): Promise<void> {
  for (let index = 0; index < cycles; index += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

const BASE_COMMENTS = [
  {
    id: 'c1',
    spreadsheetId: 'sheet_1',
    rowId: 'row_1',
    targetFieldId: null,
    mentions: [],
    authorId: 'user_1',
    authorName: 'Amy Wong',
    content: 'root comment',
    resolved: false,
    createdAt: '2026-04-01T09:00:00.000Z',
  },
  {
    id: 'c2',
    spreadsheetId: 'sheet_1',
    rowId: 'row_1',
    parentId: 'c1',
    targetFieldId: null,
    mentions: [],
    authorId: 'user_2',
    authorName: 'Ben',
    content: 'reply comment',
    resolved: false,
    createdAt: '2026-04-01T10:00:00.000Z',
  },
  {
    id: 'c3',
    spreadsheetId: 'sheet_1',
    rowId: 'row_1',
    targetFieldId: null,
    mentions: [],
    authorId: 'user_1',
    authorName: 'Amy Wong',
    content: 'delete in progress',
    resolved: false,
    createdAt: '2026-04-01T11:00:00.000Z',
  },
  {
    id: 'c4',
    spreadsheetId: 'sheet_1',
    rowId: 'row_1',
    targetFieldId: null,
    mentions: [],
    authorId: 'user_3',
    authorName: 'Casey',
    content: 'resolved item',
    resolved: true,
    createdAt: '2026-04-01T12:00:00.000Z',
  },
  {
    id: 'c5',
    spreadsheetId: 'sheet_1',
    rowId: 'row_1',
    targetFieldId: null,
    mentions: [],
    authorId: 'user_1',
    authorName: 'Amy Wong',
    content: 'plain delete',
    resolved: false,
    createdAt: '2026-04-01T13:00:00.000Z',
  },
]

async function mountDrawer(props: Record<string, unknown> = {}) {
  container = document.createElement('div')
  document.body.appendChild(container)

  router = createRouter({
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

  app = createApp({
    setup() {
      return () => h(MetaCommentsDrawer, {
        visible: true,
        comments: BASE_COMMENTS,
        loading: false,
        canComment: true,
        canResolve: true,
        draft: 'draft',
        currentUserId: 'user_1',
        onClose: vi.fn(),
        onSubmit: vi.fn(),
        onResolve: vi.fn(),
        onReply: vi.fn(),
        onEdit: vi.fn(),
        onDelete: vi.fn(),
        onRetry: vi.fn(),
        'onUpdate:draft': vi.fn(),
        ...props,
      } as Record<string, unknown>)
    },
  })
  app.use(router)
  await router.push('/')
  await router.isReady()
  app.mount(container)
  await flushUi()
  return container
}

describe('MetaCommentsDrawer i18n', () => {
  it('renders zh-CN loading header chrome', async () => {
    useLocale().setLocale('zh-CN')
    const root = await mountDrawer({ comments: [], loading: true, unreadCount: 3 })
    const text = root.textContent ?? ''

    expect(text).toContain('评论')
    expect(text).toContain('收件箱')
    expect(text).toContain('3')
    expect(text).toContain('正在加载...')
    expect(text).not.toContain('Comments')
    expect(text).not.toContain('Inbox')
  })

  it('renders zh-CN thread actions, reply counts, raw user data, and raw error body', async () => {
    useLocale().setLocale('zh-CN')
    const root = await mountDrawer({
      editingCommentId: 'c1',
      deletingIds: ['c3'],
      resolvingIds: ['c1'],
      error: 'SERVER_BROKE',
    })
    const text = root.textContent ?? ''

    expect(text).toContain('1 条回复')
    expect(text).toContain('回复')
    expect(text).toContain('正在编辑...')
    expect(text).toContain('编辑')
    expect(text).toContain('正在删除...')
    expect(text).toContain('删除')
    expect(text).toContain('正在解决...')
    expect(text).toContain('解决')
    expect(text).toContain('已解决')
    expect(text).toContain('SERVER_BROKE')
    expect(text).toContain('重试')
    expect(text).toContain('正在编辑 Amy Wong')
    expect(text).toContain('取消')
    expect(root.querySelector<HTMLTextAreaElement>('textarea')?.getAttribute('placeholder')).toBe('编辑评论…')
    expect(root.querySelector('.meta-comment-composer__submit')?.textContent?.trim()).toBe('保存')
  })

  it('renders zh-CN reply mode placeholder and banner copy', async () => {
    useLocale().setLocale('zh-CN')
    const root = await mountDrawer({ replyToCommentId: 'c1' })
    const text = root.textContent ?? ''

    expect(text).toContain('正在回复 Amy Wong')
    expect(root.querySelector<HTMLTextAreaElement>('textarea')?.getAttribute('placeholder')).toBe('回复线程…')
    expect(root.querySelector('.meta-comment-composer__submit')?.textContent?.trim()).toBe('发送')
  })

  it('localizes empty states while preserving scope labels raw', async () => {
    useLocale().setLocale('zh-CN')
    let root = await mountDrawer({ comments: [] })
    expect(root.textContent ?? '').toContain('暂无评论')
    app?.unmount()
    container?.remove()
    app = null
    container = null

    root = await mountDrawer({ comments: [], targetFieldId: 'fld_status' })
    expect(root.textContent ?? '').toContain('该字段暂无评论')
    app?.unmount()
    container?.remove()
    app = null
    container = null

    root = await mountDrawer({ comments: [], targetFieldId: 'fld_status', scopeLabel: 'Status' })
    expect(root.textContent ?? '').toContain('Status 暂无评论')
  })

  it('preserves English drawer chrome as the default locale regression', async () => {
    useLocale().setLocale('en')
    const root = await mountDrawer({ replyToCommentId: 'c1' })
    const text = root.textContent ?? ''

    expect(text).toContain('Comments')
    expect(text).toContain('Inbox')
    expect(text).toContain('Replying to Amy Wong')
    expect(text).toContain('1 reply')
    expect(root.querySelector<HTMLTextAreaElement>('textarea')?.getAttribute('placeholder')).toBe('Reply to thread…')
    expect(root.querySelector('.meta-comment-composer__submit')?.textContent?.trim()).toBe('Send')
  })
})
