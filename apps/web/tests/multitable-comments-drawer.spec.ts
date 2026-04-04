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
    suggestion?.click()
    await flushUi()

    expect(draftSpy).toHaveBeenLastCalledWith('@Amy Wong ')

    app.unmount()
    container.remove()
  })
})
