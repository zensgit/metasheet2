/**
 * 请假撤销入口(阶段 B2)—— 待办中心对撤销轮的呈现(撤销锁增补 P-11 (a)(b),落待办中心锁 §3 PendingItem;
 * owner 2026-09-29 18:3x 「Shown + subtype label (Recommended)」):
 *  - 撤销轮项按 `workflowKey === 'approval.cancel-round'` 显示子类型标(中英文案),从不按标题前缀判断;
 *  - 链接就是服务端给的 `href`(原请假深链 `/attendance?section=attendance-overview-requests&requestId=<id>`),
 *    原样交给 router-link;不合规的 href 仍按既有规则渲染为不可点,但子类型标照样显示。
 * Mocks follow TodoCenterView.spec.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, ref, type App as VueApp, type Component } from 'vue'

const getTodoItemsSpy = vi.fn()
vi.mock('../src/todo/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/todo/api')>()
  return { ...actual, getTodoItems: (...args: unknown[]) => getTodoItemsSpy(...args) }
})
vi.mock('../src/todo/useTodoCountsRealtime', () => ({
  useTodoCountsRealtime: () => ({ reconnect: vi.fn(), disconnect: vi.fn() }),
}))
const mocks = vi.hoisted(() => ({ isZh: true }))
vi.mock('../src/composables/useLocale', () => ({
  useLocale: () => ({ locale: ref(mocks.isZh ? 'zh-CN' : 'en'), isZh: ref(mocks.isZh), setLocale: vi.fn() }),
}))

async function flushUi(cycles = 4): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

const LEAVE_HREF = '/attendance?section=attendance-overview-requests&requestId=req-1'
function todoItem(overrides: Record<string, unknown>) {
  return { source: 'approval', title: 'x', updatedAt: '2026-09-29T00:00:00.000Z', actionable: true, ...overrides }
}

let app: VueApp<Element> | null = null
let container: HTMLDivElement | null = null

async function mountView(): Promise<HTMLElement> {
  const { default: TodoCenterView } = await import('../src/todo/views/TodoCenterView.vue')
  container = document.createElement('div')
  document.body.appendChild(container)
  app = createApp(TodoCenterView as Component)
  app.component('router-link', {
    props: ['to'],
    render() {
      return h('a', { href: this.$props.to, 'data-router-link-to': this.$props.to }, this.$slots.default ? this.$slots.default() : [])
    },
  })
  app.mount(container)
  await flushUi()
  return container
}

beforeEach(() => {
  mocks.isZh = true
  getTodoItemsSpy.mockReset()
})

afterEach(() => {
  if (app) app.unmount()
  container?.remove()
  app = null
  container = null
  vi.restoreAllMocks()
})

describe('todo center — cancel-round items (P-11 (a)(b))', () => {
  it('a cancel round carries the sub-type label and links to the server href (the original leave) untouched', async () => {
    getTodoItemsSpy.mockResolvedValue({
      items: [
        todoItem({ id: 'cr_1', title: '撤销「考勤审批 · 请假」', href: LEAVE_HREF, workflowKey: 'approval.cancel-round' }),
        todoItem({ id: 'apv_1', title: '出差报销', href: '/approvals/apv_1', workflowKey: 'expense' }),
      ],
      sources: { approval: 'ok' },
    })
    const root = await mountView()
    const links = [...root.querySelectorAll<HTMLElement>('[data-testid="todo-center-item"]')]
    expect(links.map((a) => a.dataset.routerLinkTo)).toEqual([LEAVE_HREF, '/approvals/apv_1'])
    const label = links[0].querySelector<HTMLElement>('[data-testid="todo-center-item-subtype"]')
    expect(label?.dataset.subtype).toBe('cancel-round')
    expect(label?.textContent).toBe('撤销申请')
    expect(links[1].querySelector('[data-testid="todo-center-item-subtype"]')).toBeNull()
  })

  it('the label is keyed on workflowKey only: a title that looks like a cancellation, or no key at all, gets none', async () => {
    getTodoItemsSpy.mockResolvedValue({
      items: [
        todoItem({ id: 'a', title: '撤销「出差报销」', href: '/approvals/a', workflowKey: 'expense' }),
        todoItem({ id: 'b', title: '撤销「考勤审批 · 请假」', href: '/approvals/b' }),
        todoItem({ id: 'c', title: '撤销「考勤审批 · 请假」', href: '/approvals/c', workflowKey: null }),
      ],
      sources: { approval: 'ok' },
    })
    const root = await mountView()
    expect(root.querySelectorAll('[data-testid="todo-center-item"]')).toHaveLength(3)
    expect(root.querySelector('[data-testid="todo-center-item-subtype"]')).toBeNull()
  })

  it('English copy; an inert (non-relative href) cancel-round row still shows its label', async () => {
    mocks.isZh = false
    vi.spyOn(console, 'error').mockImplementation(() => {})
    getTodoItemsSpy.mockResolvedValue({
      items: [
        todoItem({ id: 'cr_1', href: LEAVE_HREF, workflowKey: 'approval.cancel-round' }),
        todoItem({ id: 'cr_2', href: 'https://elsewhere.example/x', workflowKey: 'approval.cancel-round' }),
      ],
      sources: { approval: 'ok' },
    })
    const root = await mountView()
    const labels = [...root.querySelectorAll<HTMLElement>('[data-testid="todo-center-item-subtype"]')]
    expect(labels.map((l) => l.textContent)).toEqual(['Cancellation request', 'Cancellation request'])
    expect(root.querySelector('[data-testid="todo-center-item-unlinkable"] [data-testid="todo-center-item-subtype"]')).not.toBeNull()
  })
})
