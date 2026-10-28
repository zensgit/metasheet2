import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App as VueApp } from 'vue'
import { routerKey } from 'vue-router'
import { resolveAdminRouteRedirect } from '../src/router/adminAccess'
import { appRoutes } from '../src/router/appRoutes'
import { normalizeApprovalByUserEnvelope } from '../src/approvals/api'
import {
  userLookupEmptyText,
  userLookupKindHint,
  userLookupKindLabel,
  userLookupRowLabel,
  userLookupTotalPages,
} from '../src/approvals/userLookup'
import { useLocale } from '../src/composables/useLocale'

// 按人查单（管理员）— ApprovalUserLookupView over GET /api/approvals/admin/by-user.
//
// WHAT IS MOCKED: only the transport (`../src/utils/api`'s `apiGet`), the capability read, and the
// picker. The view runs the REAL `listApprovalsByUser` + `normalizeApprovalByUserEnvelope`, so the
// request path and query asserted here are the ones that go on the wire.

const apiGetSpy = vi.fn()
vi.mock('../src/utils/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/api')>()
  return {
    ...actual,
    getApiBase: () => 'http://example.test',
    apiGet: (...args: unknown[]) => apiGetSpy(...args),
  }
})

const resolveCapabilitySpy = vi.fn()
vi.mock('../src/approvals/adminCapability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/approvals/adminCapability')>()
  return { ...actual, resolveApprovalAdminCapability: (...args: unknown[]) => resolveCapabilitySpy(...args) }
})

// The real picker is covered by approvalUserPicker.spec.ts (including its includeInactive mode);
// here the stub exposes the prop the page binds so the page's choice of directory is pinned.
vi.mock('../src/approvals/components/ApprovalUserPicker.vue', async () => {
  const { defineComponent: dc, h: vh } = await import('vue')
  return {
    default: dc({
      name: 'ApprovalUserPicker',
      props: {
        modelValue: { type: [String, Array], default: null },
        placeholder: { type: String, default: '' },
        includeInactive: { type: Boolean, default: false },
      },
      emits: ['update:modelValue'],
      render() {
        return vh('input', {
          'data-testid': (this.$attrs as Record<string, string>)['data-testid'],
          'data-include-inactive': String(this.includeInactive),
          placeholder: this.placeholder,
          value: (this.modelValue as string | null) ?? '',
          onInput: (event: Event) => {
            const value = (event.target as HTMLInputElement).value
            this.$emit('update:modelValue', value.length > 0 ? value : null)
          },
        })
      },
    }),
  }
})

const routerPushSpy = vi.fn()

function passthrough(name: string, tag = 'div') {
  return defineComponent({
    name,
    render() {
      return h(tag, { 'data-testid': (this.$attrs as Record<string, string>)['data-testid'] }, this.$slots.default?.())
    },
  })
}

const ElButton = defineComponent({
  name: 'ElButton',
  props: { type: String, loading: Boolean, disabled: Boolean, link: Boolean },
  emits: ['click'],
  render() {
    return h('button', {
      type: 'button',
      disabled: this.disabled || this.loading,
      'data-button-type': this.type,
      onClick: (event: Event) => this.$emit('click', event),
    }, this.$slots.default?.())
  },
})

const ElAlert = defineComponent({
  name: 'ElAlert',
  props: { title: String, description: String, type: String, showIcon: Boolean, closable: Boolean },
  render() {
    return h('div', {
      'data-testid': (this.$attrs as Record<string, string>)['data-testid'],
      'data-alert-type': this.type,
    }, [this.title, this.description].filter(Boolean).join(' '))
  },
})

async function flushUi(cycles = 6): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function row(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    requestNo: `AP-${id}`,
    title: `审批 ${id}`,
    status: 'pending',
    templateId: 'tpl-1',
    requester: { id: 'u-req', name: '申请人' },
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-02T00:00:00.000Z',
    ...overrides,
  }
}

function page(kind: string, items: unknown[], total = items.length, pageNo = 1, pageSize = 20) {
  return { ok: true, data: { kind, items, total, page: pageNo, pageSize } }
}

// ─────────────────────────────────────────────────────────────────────────────
// Route admin gate
// ─────────────────────────────────────────────────────────────────────────────
describe('按人查单 route admin gate', () => {
  const flags = {
    loadProductFeatures: vi.fn().mockResolvedValue(undefined),
    resolveHomePath: () => '/home',
  } as unknown as Parameters<typeof resolveAdminRouteRedirect>[2]

  function lookupRoute() {
    return appRoutes.find((route) => route.path === '/approvals/user-lookup')
  }

  it('the route exists with the same meta as 批量转交 (requiresAdmin, no extra permissions)', () => {
    const route = lookupRoute()
    const batch = appRoutes.find((candidate) => candidate.path === '/approvals/batch-transfer')
    expect(route).toBeTruthy()
    expect(route!.name).toBe('approval-user-lookup')
    expect(route!.meta).toEqual({ title: 'Look Up by Person', titleZh: '按人查单', requiresAuth: true, requiresAdmin: true })
    expect(route!.meta?.permissions).toBeUndefined()
    expect(batch!.meta?.permissions).toBeUndefined()
  })

  it('a non-admin is redirected away by the shared admin route guard', async () => {
    const redirect = await resolveAdminRouteRedirect(
      { meta: lookupRoute()!.meta } as Parameters<typeof resolveAdminRouteRedirect>[0],
      { hasAdminAccess: () => false },
      flags,
    )
    expect(redirect).toBe('/home')
  })

  it('an admin is let through by that same guard (positive control)', async () => {
    const redirect = await resolveAdminRouteRedirect(
      { meta: lookupRoute()!.meta } as Parameters<typeof resolveAdminRouteRedirect>[0],
      { hasAdminAccess: () => true },
      flags,
    )
    expect(redirect).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────────────────
describe('按人查单 helpers', () => {
  it('labels the three kinds in both locales', () => {
    expect(['pending', 'decided', 'involved'].map((kind) => userLookupKindLabel(kind as never, true)))
      .toEqual(['当前待审批', '已审批', '参与过'])
    expect(['pending', 'decided', 'involved'].map((kind) => userLookupKindLabel(kind as never, false)))
      .toEqual(['Pending', 'Decided', 'Involved'])
    expect(userLookupKindHint('involved', true)).toContain('经角色分派且未处理过的不计入')
  })

  it('row label falls back title → request number → ordinal, never the id', () => {
    expect(userLookupRowLabel({ title: '采购', requestNo: 'AP-1' }, 0, true)).toBe('采购')
    expect(userLookupRowLabel({ title: '  ', requestNo: 'AP-1' }, 0, true)).toBe('AP-1')
    expect(userLookupRowLabel({ title: null, requestNo: null }, 2, true)).toBe('审批 3')
    expect(userLookupRowLabel({ title: null, requestNo: null }, 0, false)).toBe('Approval 1')
  })

  it('total pages is at least one', () => {
    expect(userLookupTotalPages(0, 20)).toBe(1)
    expect(userLookupTotalPages(20, 20)).toBe(1)
    expect(userLookupTotalPages(21, 20)).toBe(2)
    expect(userLookupTotalPages(45, 20)).toBe(3)
    expect(userLookupTotalPages(Number.NaN, 20)).toBe(1)
  })

  it('empty copy is per kind', () => {
    expect(userLookupEmptyText('pending', true)).toBe('此人当前没有待审批的单据。')
    expect(userLookupEmptyText('decided', true)).toBe('没有此人做过审批决定的单据。')
    expect(userLookupEmptyText('involved', true)).toBe('没有此人参与过的单据。')
  })

  it('the envelope reader keeps the slim row and refuses anything that is not a page', () => {
    expect(normalizeApprovalByUserEnvelope(page('decided', [row('a1', { extra: 'dropped' })], 1), 'decided')).toEqual({
      kind: 'decided',
      items: [{
        id: 'a1',
        requestNo: 'AP-a1',
        title: '审批 a1',
        status: 'pending',
        templateId: 'tpl-1',
        requester: { id: 'u-req', name: '申请人' },
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-02T00:00:00.000Z',
      }],
      total: 1,
      page: 1,
      pageSize: 20,
    })
    expect(() => normalizeApprovalByUserEnvelope({ data: [], total: 0 }, 'pending')).toThrow()
    expect(() => normalizeApprovalByUserEnvelope(null, 'pending')).toThrow()
    expect(() => normalizeApprovalByUserEnvelope(page('decided', []), 'pending')).toThrow()
    expect(() => normalizeApprovalByUserEnvelope({ ok: true, data: { kind: 'pending', items: [], total: 'x', page: 1, pageSize: 20 } }, 'pending')).toThrow()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Mounted page
// ─────────────────────────────────────────────────────────────────────────────
describe('ApprovalUserLookupView', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    useLocale().setLocale('zh-CN')
    apiGetSpy.mockReset()
    routerPushSpy.mockReset()
    resolveCapabilitySpy.mockReset().mockResolvedValue('granted')
  })

  afterEach(() => {
    app?.unmount()
    container?.remove()
    app = null
    container = null
  })

  async function mountView(): Promise<HTMLElement> {
    const { default: View } = await import('../src/views/approval/ApprovalUserLookupView.vue')
    container = document.createElement('div')
    document.body.appendChild(container)
    app = createApp(View)
    app.component('ElButton', ElButton)
    app.component('ElAlert', ElAlert)
    app.component('ElIcon', passthrough('ElIcon', 'i'))
    app.provide(routerKey, { push: routerPushSpy, back: vi.fn() })
    app.mount(container)
    await flushUi()
    return container
  }

  function q<T extends HTMLElement>(root: HTMLElement, testId: string): T {
    return root.querySelector(`[data-testid="${testId}"]`) as T
  }

  async function pickUser(root: HTMLElement, value: string): Promise<void> {
    const input = q<HTMLInputElement>(root, 'user-lookup-picker')
    input.value = value
    input.dispatchEvent(new Event('input'))
    await flushUi()
  }

  async function click(root: HTMLElement, testId: string): Promise<void> {
    q<HTMLButtonElement>(root, testId).click()
    await flushUi()
  }

  it('renders nothing actionable while the capability is pending', async () => {
    resolveCapabilitySpy.mockReturnValue(new Promise(() => {}))
    const root = await mountView()
    expect(q(root, 'user-lookup-capability-pending')).toBeTruthy()
    expect(q(root, 'user-lookup-picker')).toBeNull()
    expect(apiGetSpy).not.toHaveBeenCalled()
  })

  it('denied: an explicit insufficient-privilege state, no picker, no read', async () => {
    resolveCapabilitySpy.mockResolvedValue('denied')
    const root = await mountView()
    expect(q(root, 'user-lookup-forbidden')).toBeTruthy()
    expect(q(root, 'user-lookup-picker')).toBeNull()
    expect(apiGetSpy).not.toHaveBeenCalled()
  })

  it('unavailable: says it could not confirm, never "you are not an administrator"', async () => {
    resolveCapabilitySpy.mockResolvedValue('unavailable')
    const root = await mountView()
    expect(q(root, 'user-lookup-capability-unavailable')?.textContent).toContain('这不代表权限不足')
    expect(q(root, 'user-lookup-forbidden')).toBeNull()
    expect(q(root, 'user-lookup-picker')).toBeNull()
  })

  it('granted: the picker searches the administrator directory (deactivated accounts included)', async () => {
    const root = await mountView()
    expect(q(root, 'user-lookup-picker').getAttribute('data-include-inactive')).toBe('true')
    expect(q<HTMLButtonElement>(root, 'user-lookup-search').disabled).toBe(true)
  })

  it('queries the pinned path and query for the picked person and renders the rows', async () => {
    apiGetSpy.mockResolvedValue(page('pending', [
      row('a1'),
      row('a2', { title: null, requestNo: null, status: 'approved', requester: { id: null, name: null } }),
    ]))
    const root = await mountView()
    await pickUser(root, 'u_departed')
    await click(root, 'user-lookup-search')

    expect(apiGetSpy).toHaveBeenCalledTimes(1)
    expect(apiGetSpy).toHaveBeenCalledWith('/api/approvals/admin/by-user?userId=u_departed&kind=pending&page=1&pageSize=20')
    expect(q(root, 'user-lookup-total').textContent).toBe('共 2 条')
    expect(q(root, 'user-lookup-open-a1').textContent?.trim()).toBe('审批 a1')
    // Values-free fallback: an ordinal, never the instance id.
    expect(q(root, 'user-lookup-open-a2').textContent?.trim()).toBe('审批 2')
    expect(q(root, 'user-lookup-status-a1').textContent).toBe('待处理')
    expect(q(root, 'user-lookup-status-a2').textContent).toBe('已通过')
    expect(q(root, 'user-lookup-empty')).toBeNull()
  })

  it('switching the kind re-queries page 1 for the same person', async () => {
    apiGetSpy.mockResolvedValueOnce(page('pending', [row('a1')]))
    apiGetSpy.mockResolvedValueOnce(page('decided', [row('d1')]))
    const root = await mountView()
    await pickUser(root, 'u_departed')
    await click(root, 'user-lookup-search')
    await click(root, 'user-lookup-kind-decided')

    expect(apiGetSpy).toHaveBeenLastCalledWith('/api/approvals/admin/by-user?userId=u_departed&kind=decided&page=1&pageSize=20')
    expect(q(root, 'user-lookup-row-d1')).toBeTruthy()
    expect(q(root, 'user-lookup-row-a1')).toBeNull()
    expect(q(root, 'user-lookup-kind-decided').getAttribute('aria-checked')).toBe('true')
    expect(q(root, 'user-lookup-kind-hint').textContent).toContain('同意、拒绝、退回或办理提交')
  })

  it('an empty successful answer says so; a failed read never does', async () => {
    apiGetSpy.mockResolvedValueOnce(page('involved', [], 0))
    const root = await mountView()
    await click(root, 'user-lookup-kind-involved')
    await pickUser(root, 'u_departed')
    await click(root, 'user-lookup-search')
    expect(q(root, 'user-lookup-empty').textContent?.trim()).toBe('没有此人参与过的单据。')

    apiGetSpy.mockRejectedValueOnce(new Error('API error: 500'))
    await click(root, 'user-lookup-search')
    expect(q(root, 'user-lookup-error')).toBeTruthy()
    expect(q(root, 'user-lookup-empty')).toBeNull()
    expect(q(root, 'user-lookup-total')).toBeNull()
  })

  it('a malformed answer is a failed read, not an empty one', async () => {
    apiGetSpy.mockResolvedValueOnce({ data: [], total: 0 })
    const root = await mountView()
    await pickUser(root, 'u_departed')
    await click(root, 'user-lookup-search')
    expect(q(root, 'user-lookup-error')).toBeTruthy()
    expect(q(root, 'user-lookup-empty')).toBeNull()
  })

  it('pages through a large result with the server total', async () => {
    apiGetSpy.mockResolvedValueOnce(page('pending', [row('p1')], 45, 1, 20))
    apiGetSpy.mockResolvedValueOnce(page('pending', [row('p2')], 45, 2, 20))
    const root = await mountView()
    await pickUser(root, 'u_departed')
    await click(root, 'user-lookup-search')
    expect(q(root, 'user-lookup-page').textContent).toBe('第 1 / 3 页')
    expect(q<HTMLButtonElement>(root, 'user-lookup-prev').disabled).toBe(true)

    await click(root, 'user-lookup-next')
    expect(apiGetSpy).toHaveBeenLastCalledWith('/api/approvals/admin/by-user?userId=u_departed&kind=pending&page=2&pageSize=20')
    expect(q(root, 'user-lookup-page').textContent).toBe('第 2 / 3 页')
    expect(q(root, 'user-lookup-row-p2')).toBeTruthy()
  })

  it('drops an answer that arrives after the person was changed', async () => {
    let resolveFirst: (value: unknown) => void = () => {}
    apiGetSpy.mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve }))
    const root = await mountView()
    await pickUser(root, 'u_first')
    await click(root, 'user-lookup-search')
    await pickUser(root, 'u_second')

    resolveFirst(page('pending', [row('stale')]))
    await flushUi()
    expect(q(root, 'user-lookup-row-stale')).toBeNull()
    expect(q(root, 'user-lookup-total')).toBeNull()
  })

  it('opening a row goes to the ordinary detail page', async () => {
    apiGetSpy.mockResolvedValue(page('pending', [row('a1')]))
    const root = await mountView()
    await pickUser(root, 'u_departed')
    await click(root, 'user-lookup-search')
    await click(root, 'user-lookup-open-a1')
    expect(routerPushSpy).toHaveBeenCalledWith({ name: 'approval-detail', params: { id: 'a1' } })
  })

  it('follows the shell locale', async () => {
    useLocale().setLocale('en')
    const root = await mountView()
    expect(root.textContent).toContain('Look Up by Person')
    expect(q(root, 'user-lookup-kind-pending').textContent?.trim()).toBe('Pending')
    expect(root.textContent).not.toContain('按人查单')
  })
})
