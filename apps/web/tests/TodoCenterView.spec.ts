import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, ref, type App as VueApp, type Component } from 'vue'
import { TOKEN_KEYS } from '../src/composables/authPrincipal'

// B-2 phase 2 (todo-center-design-lock v2.14 §4 front-end half) — the 待办中心 page.
//
// Two things this suite exists to pin, in order of how likely they are to regress silently:
//
//   1. GROUPING COMES FROM `sources`, NOT FROM `items`. A source reporting `unavailable`
//      contributes zero items by construction (`pending-source-registry.ts`'s fail-closed catch),
//      so an items-driven render would make that source's group vanish — byte-identical to "this
//      source was checked and had nothing" (`ok` + 0 items). Lock §5 判据 B's negative control
//      names exactly this pair as required to render differently. The `unavailable`/`empty-ok`
//      pair below is the direct test of that; the mutation-guard test drives the point home by
//      constructing a response an items-only reducer would collapse.
//
//   2. 判据 E (代数守卫): a logout or a principal swap must void a `getTodoItems()` read still in
//      flight for the departing principal. Copied WHOLE from `ApprovalTodoBadge.vue`'s mechanism
//      (two independent generation bumps — see that file and `approvalNavTodoBadge.spec.ts`'s E1/E2
//      for why neither bump alone covers both transitions) and driven through the REAL
//      `authPrincipal.ts` module, not a mock, as those tests do.
//   3. REALTIME (B-2 step 8): `todo:counts-updated` triggers the SAME generation-guarded
//      `refresh()` mount and 判据 E already use — the push carries no items (`{ count, sources }`),
//      so there is no cheaper reaction. `useTodoCountsRealtime` is mocked at module level exactly
//      like `approvalNavTodoBadge.spec.ts` mocks it for the badge — the composable's own normalizer
//      and socket lifecycle are exercised for real in `apps/web/tests/todoCountsRealtime.spec.ts`,
//      not here. The sign-out half of 判据 E for the push path (`acceptPushes`) mirrors the badge's
//      own E3 test.
const getTodoItemsSpy = vi.fn()
vi.mock('../src/todo/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/todo/api')>()
  return {
    ...actual,
    getTodoItems: (...args: unknown[]) => getTodoItemsSpy(...args),
  }
})

type CountsCallback = (payload: { count: number; sources: Record<string, string> }) => void

let capturedOnCountsUpdated: CountsCallback | null = null
vi.mock('../src/todo/useTodoCountsRealtime', () => ({
  useTodoCountsRealtime: (options: { onCountsUpdated: CountsCallback }) => {
    capturedOnCountsUpdated = options.onCountsUpdated
    return { reconnect: vi.fn(), disconnect: vi.fn() }
  },
}))

const mocks = vi.hoisted(() => ({ isZh: true }))

vi.mock('../src/composables/useLocale', () => ({
  useLocale: () => ({
    locale: ref(mocks.isZh ? 'zh-CN' : 'en'),
    isZh: ref(mocks.isZh),
    setLocale: vi.fn(),
  }),
}))

async function flushUi(cycles = 4): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

describe('todo center view', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    mocks.isZh = true
    getTodoItemsSpy.mockReset()
    getTodoItemsSpy.mockResolvedValue({ items: [], sources: {} })
    capturedOnCountsUpdated = null
    // 判据 E tests drive `getAuthPrincipalKey()` through real storage — start clean.
    for (const key of TOKEN_KEYS) localStorage.removeItem(key)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
    capturedOnCountsUpdated = null
    for (const key of TOKEN_KEYS) localStorage.removeItem(key)
    vi.clearAllMocks()
  })

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

  function groupOf(root: HTMLElement, source: string): HTMLElement | null {
    return root.querySelector(`[data-testid="todo-center-group-${source}"]`)
  }

  it('renders an ok source\'s items, each linking to its href', async () => {
    getTodoItemsSpy.mockResolvedValue({
      items: [
        { source: 'approval', id: 'inst-1', title: '请假申请', href: '/approvals/inst-1', updatedAt: '2026-09-18T00:00:00.000Z' },
      ],
      sources: { approval: 'ok' },
    })

    const root = await mountView()
    const group = groupOf(root, 'approval')
    expect(group).not.toBeNull()
    expect(group?.querySelector('[data-testid="todo-center-group-unavailable"]')).toBeNull()
    expect(group?.querySelector('[data-testid="todo-center-group-empty"]')).toBeNull()
    const link = group?.querySelector('[data-testid="todo-center-item"]')
    expect(link?.getAttribute('href')).toBe('/approvals/inst-1')
    expect(link?.textContent).toContain('请假申请')
  })

  it('renders "checked, nothing pending" for an ok source with zero items — NOT the same shape as unavailable', async () => {
    getTodoItemsSpy.mockResolvedValue({ items: [], sources: { approval: 'ok' } })

    const root = await mountView()
    const group = groupOf(root, 'approval')
    expect(group?.querySelector('[data-testid="todo-center-group-empty"]')).not.toBeNull()
    expect(group?.querySelector('[data-testid="todo-center-group-unavailable"]')).toBeNull()
  })

  it('renders "could not check" for an unavailable source — NOT the same shape as ok+0', async () => {
    getTodoItemsSpy.mockResolvedValue({ items: [], sources: { approval: 'unavailable' } })

    const root = await mountView()
    const group = groupOf(root, 'approval')
    expect(group?.querySelector('[data-testid="todo-center-group-unavailable"]')).not.toBeNull()
    expect(group?.querySelector('[data-testid="todo-center-group-empty"]')).toBeNull()
  })

  it('mutation guard: a response with an unavailable source among ok sources must still render that source\'s own unavailable group (grouping must come from `sources`, not survive as a shape derivable from `items` alone)', async () => {
    getTodoItemsSpy.mockResolvedValue({
      items: [
        { source: 'approval', id: 'inst-1', title: '请假申请', href: '/approvals/inst-1', updatedAt: '2026-09-18T00:00:00.000Z' },
      ],
      sources: { approval: 'ok', comment: 'unavailable' },
    })

    const root = await mountView()
    // The `comment` source contributes ZERO items (fail-closed) yet must still render its own
    // group, discriminably marked unavailable — deleting the `sources`-driven grouping in favor of
    // `[...new Set(items.map(i => i.source))]` makes this group vanish entirely, reddening this
    // assertion (verified by hand: cp the component aside, swap the reducer, run this test alone,
    // cp restore, cmp — the mutant drops from 2 rendered groups to 1).
    expect(groupOf(root, 'approval')).not.toBeNull()
    const commentGroup = groupOf(root, 'comment')
    expect(commentGroup).not.toBeNull()
    expect(commentGroup?.querySelector('[data-testid="todo-center-group-unavailable"]')).not.toBeNull()
  })

  it('renders a view-only pill for actionable:false, and no pill when actionable is absent or true', async () => {
    getTodoItemsSpy.mockResolvedValue({
      items: [
        { source: 'approval', id: 'view-only', title: '仅查看单', href: '/approvals/view-only', updatedAt: '2026-09-18T00:00:00.000Z', actionable: false },
        { source: 'approval', id: 'actionable', title: '可处理单', href: '/approvals/actionable', updatedAt: '2026-09-18T00:00:00.000Z', actionable: true },
        { source: 'approval', id: 'no-notion', title: '无标记单', href: '/approvals/no-notion', updatedAt: '2026-09-18T00:00:00.000Z' },
      ],
      sources: { approval: 'ok' },
    })

    const root = await mountView()
    const links = Array.from(root.querySelectorAll('[data-testid="todo-center-item"]'))
    const byHref = (href: string) => links.find((el) => el.getAttribute('href') === href)

    expect(byHref('/approvals/view-only')?.querySelector('[data-testid="todo-center-item-view-only"]')).not.toBeNull()
    expect(byHref('/approvals/actionable')?.querySelector('[data-testid="todo-center-item-view-only"]')).toBeNull()
    expect(byHref('/approvals/no-notion')?.querySelector('[data-testid="todo-center-item-view-only"]')).toBeNull()
  })

  it('renders a page-level load-failed state (distinct from any per-source unavailable group) when the read throws', async () => {
    getTodoItemsSpy.mockRejectedValue(new Error('network down'))

    const root = await mountView()
    expect(root.querySelector('[data-testid="todo-center-load-failed"]')).not.toBeNull()
    expect(root.querySelector('[data-testid^="todo-center-group-"]')).toBeNull()
  })

  // ───────────────────────────────────────────────────────────────────────────
  // 判据 E (代数守卫) — see file header. Constructed as a real race (deferred promises resolved in
  // a chosen order), not a sleep, through the REAL `authPrincipal.ts` module.
  // ───────────────────────────────────────────────────────────────────────────
  it('E1 (principal swap, session present): a stale read settling AFTER the transition must not overwrite the list the transition\'s own read fetched', async () => {
    localStorage.setItem('auth_token', 'principal-1-token')
    let resolveStale: ((value: { items: unknown[]; sources: Record<string, string> }) => void) | null = null
    const stale = new Promise((resolve) => { resolveStale = resolve as typeof resolveStale })
    getTodoItemsSpy.mockReturnValueOnce(stale)

    const root = await mountView()
    expect(getTodoItemsSpy).toHaveBeenCalledTimes(1)
    expect(groupOf(root, 'approval')).toBeNull()

    getTodoItemsSpy.mockResolvedValueOnce({
      items: [{ source: 'approval', id: 'fresh', title: '新会话待办', href: '/approvals/fresh', updatedAt: '2026-09-18T00:00:00.000Z' }],
      sources: { approval: 'ok' },
    })
    localStorage.setItem('auth_token', 'principal-2-token')
    const { notifyAuthPrincipalChange } = await import('../src/composables/authPrincipal')
    notifyAuthPrincipalChange()
    await flushUi()

    expect(getTodoItemsSpy).toHaveBeenCalledTimes(2)
    expect(groupOf(root, 'approval')?.textContent).toContain('新会话待办')

    // The FIRST (stale) read — for the principal that has left — resolves late.
    resolveStale!({
      items: [{ source: 'approval', id: 'stale', title: '旧会话待办', href: '/approvals/stale', updatedAt: '2026-09-18T00:00:00.000Z' }],
      sources: { approval: 'ok' },
    })
    await flushUi()

    // Mutation guard: deleting `refresh()`'s `if (mine !== generation) return` pair makes this red
    // (the list would flip to the stale item right here).
    expect(groupOf(root, 'approval')?.textContent).toContain('新会话待办')
    expect(groupOf(root, 'approval')?.textContent).not.toContain('旧会话待办')
  })

  it('E2 (sign-out, no session): a read still in flight at sign-out must not paint the departed principal\'s list once it resolves', async () => {
    localStorage.setItem('auth_token', 'principal-1-token')
    let resolveStale: ((value: { items: unknown[]; sources: Record<string, string> }) => void) | null = null
    const stale = new Promise((resolve) => { resolveStale = resolve as typeof resolveStale })
    getTodoItemsSpy.mockReturnValueOnce(stale)

    const root = await mountView()
    expect(getTodoItemsSpy).toHaveBeenCalledTimes(1)

    for (const key of TOKEN_KEYS) localStorage.removeItem(key)
    const { notifyAuthPrincipalChange } = await import('../src/composables/authPrincipal')
    notifyAuthPrincipalChange()
    await flushUi()
    expect(getTodoItemsSpy).toHaveBeenCalledTimes(1) // confirms no re-read was issued (no session).

    resolveStale!({
      items: [{ source: 'approval', id: 'stale', title: '旧会话待办', href: '/approvals/stale', updatedAt: '2026-09-18T00:00:00.000Z' }],
      sources: { approval: 'ok' },
    })
    await flushUi()

    // Mutation guard: deleting the LISTENER's `generation += 1` (keeping `refresh()`'s own bump)
    // makes this red — with no second read ever issued, `refresh()`'s own `mine` still matches the
    // unbumped counter when the stale promise finally settles, and the departed principal's item
    // gets painted.
    expect(groupOf(root, 'approval')).toBeNull()
    expect(root.textContent).not.toContain('旧会话待办')
    expect(getTodoItemsSpy).toHaveBeenCalledTimes(1)
  })

  // ───────────────────────────────────────────────────────────────────────────
  // REALTIME (B-2 step 8) — see file header. `useTodoCountsRealtime` is mocked; its own
  // normalizer/socket lifecycle is exercised for real in `todoCountsRealtime.spec.ts`.
  // ───────────────────────────────────────────────────────────────────────────
  it('re-runs the same generation-guarded refresh on a todo:counts-updated push, rather than judging the pushed payload directly', async () => {
    getTodoItemsSpy.mockResolvedValueOnce({ items: [], sources: { approval: 'ok' } })
    const root = await mountView()
    expect(getTodoItemsSpy).toHaveBeenCalledTimes(1)
    expect(groupOf(root, 'approval')?.querySelector('[data-testid="todo-center-group-empty"]')).not.toBeNull()

    getTodoItemsSpy.mockResolvedValueOnce({
      items: [{ source: 'approval', id: 'pushed', title: '推送到达', href: '/approvals/pushed', updatedAt: '2026-09-18T00:00:00.000Z' }],
      sources: { approval: 'ok' },
    })
    expect(capturedOnCountsUpdated).toBeTypeOf('function')
    capturedOnCountsUpdated!({ count: 1, sources: { approval: 'ok' } })
    await flushUi()

    // Mutation guard: the push payload alone carries no items — if `handleCountsUpdated` were
    // changed to paint from the payload instead of calling `refresh()`, this second read would
    // never happen and the list would stay empty.
    expect(getTodoItemsSpy).toHaveBeenCalledTimes(2)
    expect(groupOf(root, 'approval')?.textContent).toContain('推送到达')
  })

  it('a push landing on the still-open socket after a CONFIRMED sign-out must not issue a new read (mirrors the badge\'s E3)', async () => {
    localStorage.setItem('auth_token', 'principal-1-token')
    getTodoItemsSpy.mockResolvedValueOnce({ items: [], sources: { approval: 'ok' } })
    const root = await mountView()
    expect(getTodoItemsSpy).toHaveBeenCalledTimes(1)

    for (const key of TOKEN_KEYS) localStorage.removeItem(key)
    const { notifyAuthPrincipalChange } = await import('../src/composables/authPrincipal')
    notifyAuthPrincipalChange()
    await flushUi()
    // Sign-out issues no re-read of its own (`hasSession()` is false) — confirms the assertion
    // below reflects the push gate, not a coincidentally-idle refresh.
    expect(getTodoItemsSpy).toHaveBeenCalledTimes(1)
    expect(groupOf(root, 'approval')).toBeNull()

    capturedOnCountsUpdated!({ count: 9, sources: { approval: 'ok' } })
    await flushUi()

    // Mutation guard: deleting `acceptPushes` (or its `= false` assignment on confirmed sign-out)
    // makes this red — the push would trigger a THIRD `getTodoItems()` call for a departed
    // principal.
    expect(getTodoItemsSpy).toHaveBeenCalledTimes(1)
    expect(groupOf(root, 'approval')).toBeNull()
  })
})
