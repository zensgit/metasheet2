import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App as VueApp } from 'vue'
import { createMemoryHistory, createRouter, RouterView } from 'vue-router'
import { buildMultitableRoute } from '../src/router/multitableRoute'
import { AppRouteNames } from '../src/router/types'

const confirmPageLeaveSpy = vi.fn<[], boolean>()
type EmbedHostState = {
  currentContext: {
    baseId: string
    sheetId: string
    viewId: string
  }
  hasBlockingState: boolean
  blockingReason: 'busy' | 'unsaved-drafts' | null
  hasUnsavedDrafts: boolean
  busy: boolean
  pendingContext: {
    baseId: string
    sheetId: string
    viewId: string
    requestId?: string | number
    reason?: 'busy' | 'unsaved-drafts'
  } | null
}
let replayExternalContextResult:
  | ((payload: { status: 'applied' | 'failed'; context: { baseId: string; sheetId: string; viewId: string }; reason?: string; requestId?: string | number }) => void)
  | null = null
type NavigationResult = {
  status: 'applied' | 'deferred' | 'blocked' | 'failed' | 'superseded'
  baseId?: string
  sheetId?: string
  viewId?: string
  reason?: string
  requestId?: string | number
}
const requestExternalContextSyncSpy = vi.fn<
  [input: { baseId?: string; sheetId?: string; viewId?: string }, options?: { confirmIfBlocked?: boolean; requestId?: string | number }],
  Promise<{ status: NavigationResult['status']; context: { baseId: string; sheetId: string; viewId: string }; reason?: string }>
>()
const getEmbedHostStateSpy = vi.fn<[], EmbedHostState>()

vi.mock('../src/multitable/views/MultitableWorkbench.vue', () => ({
  default: defineComponent({
    name: 'MultitableWorkbench',
    props: {
      baseId: { type: String, default: undefined },
      sheetId: { type: String, default: undefined },
      viewId: { type: String, default: undefined },
      recordId: { type: String, default: undefined },
      mode: { type: String, default: undefined },
      role: { type: String, default: undefined },
    },
    setup(props, { expose, emit }) {
      replayExternalContextResult = (payload) => {
        emit('external-context-result', payload)
      }
      expose({
        confirmPageLeave: () => confirmPageLeaveSpy(),
        getEmbedHostState: () => getEmbedHostStateSpy(),
        requestExternalContextSync: (
          input: { baseId?: string; sheetId?: string; viewId?: string },
          options?: { confirmIfBlocked?: boolean; requestId?: string | number },
        ) =>
          requestExternalContextSyncSpy(input, options),
      })
      return () => h('div', {
        'data-workbench-base-id': props.baseId ?? '',
        'data-workbench-sheet-id': props.sheetId ?? '',
        'data-workbench-view-id': props.viewId ?? '',
      })
    },
  }),
}))

import MultitableEmbedHost from '../src/multitable/views/MultitableEmbedHost.vue'

describe('multitable embed host guards', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null
  let parentPostMessageSpy: ReturnType<typeof vi.fn>
  let originalParent: WindowProxy

  beforeEach(() => {
    confirmPageLeaveSpy.mockReset()
    confirmPageLeaveSpy.mockReturnValue(true)
    getEmbedHostStateSpy.mockReset()
    getEmbedHostStateSpy.mockReturnValue({
      currentContext: {
        baseId: 'base_ops',
        sheetId: 'sheet_orders',
        viewId: 'view_grid',
      },
      hasBlockingState: false,
      blockingReason: null,
      hasUnsavedDrafts: false,
      busy: false,
      pendingContext: null,
    })
    requestExternalContextSyncSpy.mockReset()
    requestExternalContextSyncSpy.mockImplementation(async (input) => ({
      status: 'applied',
      context: {
        baseId: input.baseId ?? '',
        sheetId: input.sheetId ?? '',
        viewId: input.viewId ?? '',
      },
    }))
    parentPostMessageSpy = vi.fn()
    originalParent = window.parent
    Object.defineProperty(window, 'parent', {
      configurable: true,
      value: { postMessage: parentPostMessageSpy },
    })
  })

  afterEach(() => {
    if (app) app.unmount()
    app = null
    if (container?.parentNode) container.parentNode.removeChild(container)
    container = null
    replayExternalContextResult = null
    Object.defineProperty(window, 'parent', {
      configurable: true,
      value: originalParent,
    })
  })

  async function mountRouteHost(path = '/multitable/sheet_orders/view_grid?baseId=base_ops') {
    container = document.createElement('div')
    document.body.appendChild(container)
    const navigated: Array<{ sheetId?: string; viewId?: string }> = []
    const navigationResults: NavigationResult[] = []

    const RouteHarness = defineComponent({
      name: 'MultitableRouteHarness',
      components: { MultitableEmbedHost },
      props: {
        baseId: { type: String, default: undefined },
        sheetId: { type: String, default: undefined },
        viewId: { type: String, default: undefined },
        recordId: { type: String, default: undefined },
        mode: { type: String, default: undefined },
        embedded: { type: Boolean, default: undefined },
          role: { type: String, default: undefined },
      },
      setup() {
        return {
          onNavigated: (payload: { sheetId?: string; viewId?: string }) => navigated.push(payload),
          onNavigationResult: (payload: NavigationResult) => navigationResults.push(payload),
        }
      },
      template: `
        <MultitableEmbedHost
          :base-id="baseId"
          :sheet-id="sheetId"
          :view-id="viewId"
          :record-id="recordId"
          :mode="mode"
          :embedded="embedded"
          :role="role"
          @navigated="onNavigated"
          @navigation-result="onNavigationResult"
        />
      `,
    })

    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        {
          path: '/',
          name: 'root',
          component: defineComponent({
            name: 'RouteRoot',
            render: () => h('div', { 'data-route-root': 'true' }),
          }),
        },
        buildMultitableRoute(RouteHarness),
        {
          path: '/done',
          name: 'done',
          component: defineComponent({
            name: 'RouteDone',
            render: () => h('div', { 'data-route-done': 'true' }),
          }),
        },
      ],
    })

    const Root = defineComponent({
      name: 'EmbedHostRouteRoot',
      render: () => h(RouterView),
    })

    app = createApp(Root)
    app.use(router)
    await router.push(path)
    await router.isReady()
    app.mount(container)
    await nextTick()
    return { router, navigated, navigationResults }
  }

  it('blocks route leave when the workbench rejects page leave', async () => {
    confirmPageLeaveSpy.mockReturnValue(false)
    const { router } = await mountRouteHost()

    await router.push('/done')
    await nextTick()

    expect(confirmPageLeaveSpy).toHaveBeenCalledTimes(1)
    expect(router.currentRoute.value.name).toBe(AppRouteNames.MULTITABLE)
    expect(container?.querySelector('[data-workbench-sheet-id]')?.getAttribute('data-workbench-sheet-id')).toBe('sheet_orders')
  })

  it('responds to mt:get-navigation-state with the current embed snapshot and echoed requestId', async () => {
    const host = await mountRouteHost()
    getEmbedHostStateSpy.mockReturnValueOnce({
      currentContext: {
        baseId: 'base_ops',
        sheetId: 'sheet_orders',
        viewId: 'view_grid',
      },
      hasBlockingState: true,
      blockingReason: 'unsaved-drafts',
      hasUnsavedDrafts: true,
      busy: false,
      pendingContext: {
        baseId: 'base_people',
        sheetId: 'sheet_people',
        viewId: 'view_gallery',
        requestId: 'req_deferred',
        reason: 'busy',
      },
    })

    window.dispatchEvent(new MessageEvent('message', {
      origin: window.location.origin,
      data: { type: 'mt:get-navigation-state', requestId: 'req_state' },
    }))

    await vi.waitFor(() => {
      const stateCalls = parentPostMessageSpy.mock.calls
        .map(([payload]) => payload)
        .filter((payload) => payload?.type === 'mt:navigation-state')
      expect(stateCalls.length).toBe(1)
    })

    const stateCalls = parentPostMessageSpy.mock.calls
      .map(([payload]) => payload)
      .filter((payload) => payload?.type === 'mt:navigation-state')
    expect(stateCalls[0]).toEqual({
      type: 'mt:navigation-state',
      requestId: 'req_state',
      currentContext: {
        baseId: 'base_ops',
        sheetId: 'sheet_orders',
        viewId: 'view_grid',
      },
      hasBlockingState: true,
      blockingReason: 'unsaved-drafts',
      hasUnsavedDrafts: true,
      busy: false,
      pendingContext: {
        baseId: 'base_people',
        sheetId: 'sheet_people',
        viewId: 'view_gallery',
        requestId: 'req_deferred',
        reason: 'busy',
      },
    })
    expect(requestExternalContextSyncSpy).not.toHaveBeenCalled()
    expect(host.navigationResults).toEqual([])
    expect(host.navigated).toEqual([])
  })

  it('reports the canonical applied context instead of the originally requested target', async () => {
    const host = await mountRouteHost()
    requestExternalContextSyncSpy.mockResolvedValueOnce({
      status: 'applied',
      context: { baseId: 'base_missing', sheetId: 'sheet_missing', viewId: 'view_missing' },
    })
    getEmbedHostStateSpy.mockReturnValueOnce({
      currentContext: {
        baseId: 'base_people',
        sheetId: 'sheet_people',
        viewId: 'view_gallery',
      },
      hasBlockingState: false,
      blockingReason: null,
      hasUnsavedDrafts: false,
      busy: false,
      pendingContext: null,
    })

    window.dispatchEvent(new MessageEvent('message', {
      origin: window.location.origin,
      data: {
        type: 'mt:navigate',
        baseId: 'base_missing',
        sheetId: 'sheet_missing',
        viewId: 'view_missing',
        requestId: 'req_actual',
      },
    }))

    await vi.waitFor(() => expect(requestExternalContextSyncSpy).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => {
      expect(container?.querySelector('[data-workbench-base-id]')?.getAttribute('data-workbench-base-id')).toBe('base_people')
      expect(container?.querySelector('[data-workbench-sheet-id]')?.getAttribute('data-workbench-sheet-id')).toBe('sheet_people')
      expect(container?.querySelector('[data-workbench-view-id]')?.getAttribute('data-workbench-view-id')).toBe('view_gallery')
    })

    expect(host.navigationResults.at(-1)).toEqual({
      status: 'applied',
      baseId: 'base_people',
      sheetId: 'sheet_people',
      viewId: 'view_gallery',
      reason: undefined,
      requestId: 'req_actual',
    })
    const navigatedCalls = parentPostMessageSpy.mock.calls
      .map(([payload]) => payload)
      .filter((payload) => payload?.type === 'mt:navigated')
    expect(navigatedCalls.at(-1)).toEqual({
      type: 'mt:navigated',
      baseId: 'base_people',
      sheetId: 'sheet_people',
      viewId: 'view_gallery',
      requestId: 'req_actual',
    })
  })

  it('emits deferred status and keeps host context stable when workbench defers navigation', async () => {
    const host = await mountRouteHost()
    requestExternalContextSyncSpy.mockResolvedValueOnce({
      status: 'deferred',
      context: { baseId: 'base_ops', sheetId: 'sheet_people', viewId: 'view_gallery' },
      reason: 'busy',
    })

    window.dispatchEvent(new MessageEvent('message', {
      origin: window.location.origin,
      data: { type: 'mt:navigate', sheetId: 'sheet_people', viewId: 'view_gallery', requestId: 'req_busy' },
    }))
    await vi.waitFor(() => expect(requestExternalContextSyncSpy).toHaveBeenCalledTimes(1))
    await nextTick()

    expect(requestExternalContextSyncSpy).toHaveBeenLastCalledWith(
      { baseId: 'base_ops', sheetId: 'sheet_people', viewId: 'view_gallery' },
      { confirmIfBlocked: true, requestId: 'req_busy' },
    )
    await vi.waitFor(() => expect(host.navigationResults.length).toBe(1))
    expect(container?.querySelector('[data-workbench-sheet-id]')?.getAttribute('data-workbench-sheet-id')).toBe('sheet_orders')
    expect(container?.querySelector('[data-workbench-view-id]')?.getAttribute('data-workbench-view-id')).toBe('view_grid')
    expect(host.navigated).toEqual([])
    expect(host.navigationResults).toEqual([{
      status: 'deferred',
      baseId: 'base_ops',
      sheetId: 'sheet_people',
      viewId: 'view_gallery',
      reason: 'busy',
      requestId: 'req_busy',
    }])
  })

  it('synthesizes a requestId for deferred navigation when the host omits one and reuses it on replay', async () => {
    const host = await mountRouteHost()
    requestExternalContextSyncSpy.mockResolvedValueOnce({
      status: 'deferred',
      context: { baseId: 'base_people', sheetId: 'sheet_people', viewId: 'view_gallery' },
      reason: 'busy',
    })

    window.dispatchEvent(new MessageEvent('message', {
      origin: window.location.origin,
      data: { type: 'mt:navigate', baseId: 'base_people', sheetId: 'sheet_people', viewId: 'view_gallery' },
    }))

    await vi.waitFor(() => expect(requestExternalContextSyncSpy).toHaveBeenCalledTimes(1))
    const generatedRequestId = requestExternalContextSyncSpy.mock.calls[0]?.[1]?.requestId
    expect(typeof generatedRequestId).toBe('string')
    expect(generatedRequestId).toMatch(/^mt_nav_/)
    await vi.waitFor(() => expect(host.navigationResults.length).toBe(1))
    expect(host.navigationResults.at(-1)).toEqual({
      status: 'deferred',
      baseId: 'base_people',
      sheetId: 'sheet_people',
      viewId: 'view_gallery',
      reason: 'busy',
      requestId: generatedRequestId,
    })

    getEmbedHostStateSpy.mockReturnValueOnce({
      currentContext: {
        baseId: 'base_people',
        sheetId: 'sheet_people',
        viewId: 'view_gallery',
      },
      hasBlockingState: false,
      blockingReason: null,
      hasUnsavedDrafts: false,
      busy: false,
      pendingContext: null,
    })
    replayExternalContextResult?.({
      status: 'applied',
      context: { baseId: 'base_people', sheetId: 'sheet_people', viewId: 'view_gallery' },
      requestId: generatedRequestId,
    })
    await nextTick()
    await vi.waitFor(() => {
      expect(container?.querySelector('[data-workbench-base-id]')?.getAttribute('data-workbench-base-id')).toBe('base_people')
      expect(container?.querySelector('[data-workbench-sheet-id]')?.getAttribute('data-workbench-sheet-id')).toBe('sheet_people')
      expect(container?.querySelector('[data-workbench-view-id]')?.getAttribute('data-workbench-view-id')).toBe('view_gallery')
    })

    const navigatedCalls = parentPostMessageSpy.mock.calls
      .map(([payload]) => payload)
      .filter((payload) => payload?.type === 'mt:navigated')
    expect(navigatedCalls.at(-1)).toEqual({
      type: 'mt:navigated',
      baseId: 'base_people',
      sheetId: 'sheet_people',
      viewId: 'view_gallery',
      requestId: generatedRequestId,
    })
  })

  it('emits superseded for the older deferred request when a newer deferred target replaces it', async () => {
    const host = await mountRouteHost()
    requestExternalContextSyncSpy
      .mockResolvedValueOnce({
        status: 'deferred',
        context: { baseId: 'base_people', sheetId: 'sheet_people', viewId: 'view_gallery' },
        reason: 'busy',
      })
      .mockResolvedValueOnce({
        status: 'deferred',
        context: { baseId: 'base_ops', sheetId: 'sheet_sales', viewId: 'view_board' },
        reason: 'busy',
      })

    window.dispatchEvent(new MessageEvent('message', {
      origin: window.location.origin,
      data: { type: 'mt:navigate', baseId: 'base_people', sheetId: 'sheet_people', viewId: 'view_gallery', requestId: 'req_old' },
    }))
    await vi.waitFor(() => expect(host.navigationResults.length).toBe(1))

    window.dispatchEvent(new MessageEvent('message', {
      origin: window.location.origin,
      data: { type: 'mt:navigate', baseId: 'base_ops', sheetId: 'sheet_sales', viewId: 'view_board', requestId: 'req_new' },
    }))
    await vi.waitFor(() => expect(requestExternalContextSyncSpy).toHaveBeenCalledTimes(2))
    replayExternalContextResult?.({
      status: 'superseded',
      context: { baseId: 'base_people', sheetId: 'sheet_people', viewId: 'view_gallery' },
      reason: 'superseded',
      requestId: 'req_old',
    })
    await vi.waitFor(() => expect(host.navigationResults.length).toBe(3))

    expect(host.navigationResults).toEqual([
      {
        status: 'deferred',
        baseId: 'base_people',
        sheetId: 'sheet_people',
        viewId: 'view_gallery',
        reason: 'busy',
        requestId: 'req_old',
      },
      {
        status: 'superseded',
        baseId: 'base_people',
        sheetId: 'sheet_people',
        viewId: 'view_gallery',
        reason: 'superseded',
        requestId: 'req_old',
      },
      {
        status: 'deferred',
        baseId: 'base_ops',
        sheetId: 'sheet_sales',
        viewId: 'view_board',
        reason: 'busy',
        requestId: 'req_new',
      },
    ])
    expect(host.navigated).toEqual([])
  })

  it('replays only the newest deferred request after the older one is superseded', async () => {
    const host = await mountRouteHost()
    requestExternalContextSyncSpy
      .mockResolvedValueOnce({
        status: 'deferred',
        context: { baseId: 'base_people', sheetId: 'sheet_people', viewId: 'view_gallery' },
        reason: 'busy',
      })
      .mockResolvedValueOnce({
        status: 'deferred',
        context: { baseId: 'base_ops', sheetId: 'sheet_sales', viewId: 'view_board' },
        reason: 'busy',
      })

    window.dispatchEvent(new MessageEvent('message', {
      origin: window.location.origin,
      data: { type: 'mt:navigate', baseId: 'base_people', sheetId: 'sheet_people', viewId: 'view_gallery', requestId: 'req_old' },
    }))
    await vi.waitFor(() => expect(host.navigationResults.length).toBe(1))

    window.dispatchEvent(new MessageEvent('message', {
      origin: window.location.origin,
      data: { type: 'mt:navigate', baseId: 'base_ops', sheetId: 'sheet_sales', viewId: 'view_board', requestId: 'req_new' },
    }))
    replayExternalContextResult?.({
      status: 'superseded',
      context: { baseId: 'base_people', sheetId: 'sheet_people', viewId: 'view_gallery' },
      reason: 'superseded',
      requestId: 'req_old',
    })
    await vi.waitFor(() => expect(host.navigationResults.length).toBe(3))

    getEmbedHostStateSpy.mockReturnValueOnce({
      currentContext: {
        baseId: 'base_ops',
        sheetId: 'sheet_sales',
        viewId: 'view_board',
      },
      hasBlockingState: false,
      blockingReason: null,
      hasUnsavedDrafts: false,
      busy: false,
      pendingContext: null,
    })
    replayExternalContextResult?.({
      status: 'applied',
      context: { baseId: 'base_ops', sheetId: 'sheet_sales', viewId: 'view_board' },
      requestId: 'req_new',
    })
    await nextTick()

    await vi.waitFor(() => {
      expect(container?.querySelector('[data-workbench-base-id]')?.getAttribute('data-workbench-base-id')).toBe('base_ops')
      expect(container?.querySelector('[data-workbench-sheet-id]')?.getAttribute('data-workbench-sheet-id')).toBe('sheet_sales')
      expect(container?.querySelector('[data-workbench-view-id]')?.getAttribute('data-workbench-view-id')).toBe('view_board')
    })

    expect(host.navigationResults).toEqual([
      {
        status: 'deferred',
        baseId: 'base_people',
        sheetId: 'sheet_people',
        viewId: 'view_gallery',
        reason: 'busy',
        requestId: 'req_old',
      },
      {
        status: 'superseded',
        baseId: 'base_people',
        sheetId: 'sheet_people',
        viewId: 'view_gallery',
        reason: 'superseded',
        requestId: 'req_old',
      },
      {
        status: 'deferred',
        baseId: 'base_ops',
        sheetId: 'sheet_sales',
        viewId: 'view_board',
        reason: 'busy',
        requestId: 'req_new',
      },
      {
        status: 'applied',
        baseId: 'base_ops',
        sheetId: 'sheet_sales',
        viewId: 'view_board',
        reason: undefined,
        requestId: 'req_new',
      },
    ])
    const navigatedCalls = parentPostMessageSpy.mock.calls
      .map(([payload]) => payload)
      .filter((payload) => payload?.type === 'mt:navigated')
    expect(navigatedCalls).toEqual([
      {
        type: 'mt:navigated',
        baseId: 'base_ops',
        sheetId: 'sheet_sales',
        viewId: 'view_board',
        requestId: 'req_new',
      },
    ])
  })

  it('uses the synthesized old requestId when a generated deferred request is superseded', async () => {
    const host = await mountRouteHost()
    requestExternalContextSyncSpy
      .mockResolvedValueOnce({
        status: 'deferred',
        context: { baseId: 'base_people', sheetId: 'sheet_people', viewId: 'view_gallery' },
        reason: 'busy',
      })
      .mockResolvedValueOnce({
        status: 'deferred',
        context: { baseId: 'base_ops', sheetId: 'sheet_sales', viewId: 'view_board' },
        reason: 'busy',
      })

    window.dispatchEvent(new MessageEvent('message', {
      origin: window.location.origin,
      data: { type: 'mt:navigate', baseId: 'base_people', sheetId: 'sheet_people', viewId: 'view_gallery' },
    }))
    await vi.waitFor(() => expect(host.navigationResults.length).toBe(1))
    const generatedOldRequestId = requestExternalContextSyncSpy.mock.calls[0]?.[1]?.requestId
    expect(generatedOldRequestId).toMatch(/^mt_nav_/)

    window.dispatchEvent(new MessageEvent('message', {
      origin: window.location.origin,
      data: { type: 'mt:navigate', baseId: 'base_ops', sheetId: 'sheet_sales', viewId: 'view_board', requestId: 'req_newer' },
    }))
    replayExternalContextResult?.({
      status: 'superseded',
      context: { baseId: 'base_people', sheetId: 'sheet_people', viewId: 'view_gallery' },
      reason: 'superseded',
      requestId: generatedOldRequestId,
    })

    await vi.waitFor(() => expect(host.navigationResults.length).toBe(3))
    expect(host.navigationResults).toEqual([
      {
        status: 'deferred',
        baseId: 'base_people',
        sheetId: 'sheet_people',
        viewId: 'view_gallery',
        reason: 'busy',
        requestId: generatedOldRequestId,
      },
      {
        status: 'superseded',
        baseId: 'base_people',
        sheetId: 'sheet_people',
        viewId: 'view_gallery',
        reason: 'superseded',
        requestId: generatedOldRequestId,
      },
      {
        status: 'deferred',
        baseId: 'base_ops',
        sheetId: 'sheet_sales',
        viewId: 'view_board',
        reason: 'busy',
        requestId: 'req_newer',
      },
    ])
  })

  it('emits blocked status when workbench rejects host navigation', async () => {
    const host = await mountRouteHost()
    requestExternalContextSyncSpy.mockResolvedValueOnce({
      status: 'blocked',
      context: { baseId: 'base_ops', sheetId: 'sheet_people', viewId: 'view_gallery' },
      reason: 'user-cancelled',
    })

    window.dispatchEvent(new MessageEvent('message', {
      origin: window.location.origin,
      data: { type: 'mt:navigate', sheetId: 'sheet_people', viewId: 'view_gallery', requestId: 'req_blocked' },
    }))
    await vi.waitFor(() => expect(requestExternalContextSyncSpy).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(host.navigationResults.length).toBe(1))

    expect(container?.querySelector('[data-workbench-base-id]')?.getAttribute('data-workbench-base-id')).toBe('base_ops')
    expect(container?.querySelector('[data-workbench-sheet-id]')?.getAttribute('data-workbench-sheet-id')).toBe('sheet_orders')
    expect(container?.querySelector('[data-workbench-view-id]')?.getAttribute('data-workbench-view-id')).toBe('view_grid')
    expect(host.navigated).toEqual([])
    expect(host.navigationResults).toEqual([{
      status: 'blocked',
      baseId: 'base_ops',
      sheetId: 'sheet_people',
      viewId: 'view_gallery',
      reason: 'user-cancelled',
      requestId: 'req_blocked',
    }])
  })

  it('applies host mt:navigate, updates base override, and emits applied status before navigation', async () => {
    const host = await mountRouteHost()
    requestExternalContextSyncSpy.mockResolvedValueOnce({
      status: 'applied',
      context: { baseId: 'base_people', sheetId: 'sheet_people', viewId: 'view_gallery' },
    })
    getEmbedHostStateSpy.mockReturnValueOnce({
      currentContext: {
        baseId: 'base_people',
        sheetId: 'sheet_people',
        viewId: 'view_gallery',
      },
      hasBlockingState: false,
      blockingReason: null,
      hasUnsavedDrafts: false,
      busy: false,
      pendingContext: null,
    })

    window.dispatchEvent(new MessageEvent('message', {
      origin: window.location.origin,
      data: { type: 'mt:navigate', baseId: 'base_people', sheetId: 'sheet_people', viewId: 'view_gallery', requestId: 'req_applied' },
    }))
    await vi.waitFor(() => expect(requestExternalContextSyncSpy).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => {
      expect(container?.querySelector('[data-workbench-base-id]')?.getAttribute('data-workbench-base-id')).toBe('base_people')
      expect(container?.querySelector('[data-workbench-sheet-id]')?.getAttribute('data-workbench-sheet-id')).toBe('sheet_people')
    })

    expect(container?.querySelector('[data-workbench-view-id]')?.getAttribute('data-workbench-view-id')).toBe('view_gallery')
    expect(host.navigationResults).toEqual([{
      status: 'applied',
      baseId: 'base_people',
      sheetId: 'sheet_people',
      viewId: 'view_gallery',
      reason: undefined,
      requestId: 'req_applied',
    }])
    expect(host.navigated).toEqual([{ sheetId: 'sheet_people', viewId: 'view_gallery' }])
    const navigatedCalls = parentPostMessageSpy.mock.calls
      .map(([payload]) => payload)
      .filter((payload) => payload?.type === 'mt:navigated')
    expect(navigatedCalls.at(-1)).toEqual({
      type: 'mt:navigated',
      baseId: 'base_people',
      sheetId: 'sheet_people',
      viewId: 'view_gallery',
      requestId: 'req_applied',
    })
  })

  it('replays deferred host navigation and echoes requestId when the deferred context finally applies', async () => {
    const host = await mountRouteHost()
    requestExternalContextSyncSpy.mockResolvedValueOnce({
      status: 'deferred',
      context: { baseId: 'base_people', sheetId: 'sheet_people', viewId: 'view_gallery' },
      reason: 'busy',
    })

    window.dispatchEvent(new MessageEvent('message', {
      origin: window.location.origin,
      data: { type: 'mt:navigate', baseId: 'base_people', sheetId: 'sheet_people', viewId: 'view_gallery', requestId: 'req_replay' },
    }))
    await vi.waitFor(() => expect(host.navigationResults.length).toBe(1))
    expect(host.navigationResults[0]).toEqual({
      status: 'deferred',
      baseId: 'base_people',
      sheetId: 'sheet_people',
      viewId: 'view_gallery',
      reason: 'busy',
      requestId: 'req_replay',
    })

    getEmbedHostStateSpy.mockReturnValueOnce({
      currentContext: {
        baseId: 'base_people',
        sheetId: 'sheet_people',
        viewId: 'view_gallery',
      },
      hasBlockingState: false,
      blockingReason: null,
      hasUnsavedDrafts: false,
      busy: false,
      pendingContext: null,
    })
    replayExternalContextResult?.({
        status: 'applied',
        context: { baseId: 'base_people', sheetId: 'sheet_people', viewId: 'view_gallery' },
        requestId: 'req_replay',
      })
    await nextTick()
    await vi.waitFor(() => {
      expect(container?.querySelector('[data-workbench-base-id]')?.getAttribute('data-workbench-base-id')).toBe('base_people')
      expect(container?.querySelector('[data-workbench-sheet-id]')?.getAttribute('data-workbench-sheet-id')).toBe('sheet_people')
      expect(container?.querySelector('[data-workbench-view-id]')?.getAttribute('data-workbench-view-id')).toBe('view_gallery')
    })

    expect(host.navigationResults).toEqual([
      {
        status: 'deferred',
        baseId: 'base_people',
        sheetId: 'sheet_people',
        viewId: 'view_gallery',
        reason: 'busy',
        requestId: 'req_replay',
      },
      {
        status: 'applied',
        baseId: 'base_people',
        sheetId: 'sheet_people',
        viewId: 'view_gallery',
        reason: undefined,
        requestId: 'req_replay',
      },
    ])
    const navigatedCalls = parentPostMessageSpy.mock.calls
      .map(([payload]) => payload)
      .filter((payload) => payload?.type === 'mt:navigated')
    expect(navigatedCalls.at(-1)).toEqual({
      type: 'mt:navigated',
      baseId: 'base_people',
      sheetId: 'sheet_people',
      viewId: 'view_gallery',
      requestId: 'req_replay',
    })
  })
})
