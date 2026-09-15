import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, onMounted, type App as VueApp } from 'vue'
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
      commentId: { type: String, default: undefined },
      fieldId: { type: String, default: undefined },
      openComments: { type: Boolean, default: undefined },
      mode: { type: String, default: undefined },
      role: { type: String, default: undefined },
    },
    setup(props, { expose, emit }) {
      replayExternalContextResult = (payload) => {
        emit('external-context-result', payload)
      }
      onMounted(() => {
        emit('ready', {
          baseId: props.baseId ?? '',
          sheetId: props.sheetId ?? '',
          viewId: props.viewId ?? '',
        })
      })
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
        'data-workbench-record-id': props.recordId ?? '',
        'data-workbench-comment-id': props.commentId ?? '',
        'data-workbench-field-id': props.fieldId ?? '',
        'data-workbench-open-comments': String(props.openComments ?? false),
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
        commentId: { type: String, default: undefined },
        fieldId: { type: String, default: undefined },
        openComments: { type: Boolean, default: undefined },
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
          :comment-id="commentId"
          :field-id="fieldId"
          :open-comments="openComments"
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

  it('#5750 keeps ?baseId= in the URL when the applied context carries no base id', async () => {
    const { router } = await mountRouteHost('/multitable/sheet_orders/view_grid?baseId=base_ops&keepme=1')
    expect(router.currentRoute.value.query.baseId).toBe('base_ops')

    // mt:navigate with an EXPLICIT empty baseId = "same base, other sheet". The workbench stays on
    // base_ops (its getEmbedHostState snapshot says so), so the URL must keep pinning that base
    // instead of deleting the key while every other query param survives the spread.
    window.dispatchEvent(new MessageEvent('message', {
      origin: window.location.origin,
      data: { type: 'mt:navigate', baseId: '', sheetId: 'sheet_deals', viewId: 'view_grid', requestId: 'req_no_base' },
    }))
    await vi.waitFor(() => expect(requestExternalContextSyncSpy).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(router.currentRoute.value.params.sheetId).toBe('sheet_deals'))

    expect(router.currentRoute.value.params.sheetId).toBe('sheet_deals')
    expect(router.currentRoute.value.query.keepme).toBe('1')
    expect(router.currentRoute.value.query.baseId).toBe('base_ops')
    // ...and the frame renders the same base the URL now pins.
    expect(container?.querySelector('[data-workbench-base-id]')?.getAttribute('data-workbench-base-id')).toBe('base_ops')
  })

  // #5750 review: keeping ?baseId= must not also keep the deep-link keys. Before the baseId
  // fallback, a context without a base id always mismatched the URL, so the router.replace ran and
  // stripped ?recordId= / ?mode= (both are live props). A host navigating back to the plain sheet
  // still has to get that cleanup -- only the baseId deletion was the bug.
  it('#5750 still strips recordId/mode when the host navigates back to the plain sheet', async () => {
    const { router } = await mountRouteHost('/multitable/sheet_orders/view_grid?baseId=base_ops&recordId=rec_1&mode=readonly')
    expect(router.currentRoute.value.query.recordId).toBe('rec_1')

    window.dispatchEvent(new MessageEvent('message', {
      origin: window.location.origin,
      data: { type: 'mt:navigate', baseId: '', sheetId: 'sheet_orders', viewId: 'view_grid', requestId: 'req_plain_sheet' },
    }))
    await vi.waitFor(() => expect(requestExternalContextSyncSpy).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(router.currentRoute.value.query.recordId).toBeUndefined())

    expect(router.currentRoute.value.query.mode).toBeUndefined()
    expect(router.currentRoute.value.query.baseId).toBe('base_ops')
    expect(router.currentRoute.value.params.sheetId).toBe('sheet_orders')
    expect(router.currentRoute.value.params.viewId).toBe('view_grid')
  })

  it('blocks route leave when the workbench rejects page leave', async () => {
    confirmPageLeaveSpy.mockReturnValue(false)
    const { router } = await mountRouteHost()

    await router.push('/done')
    await nextTick()

    expect(confirmPageLeaveSpy).toHaveBeenCalledTimes(1)
    expect(router.currentRoute.value.name).toBe(AppRouteNames.MULTITABLE)
    expect(container?.querySelector('[data-workbench-sheet-id]')?.getAttribute('data-workbench-sheet-id')).toBe('sheet_orders')
  })

  it('forwards comment jump query props into the workbench', async () => {
    await mountRouteHost('/multitable/sheet_orders/view_grid?baseId=base_ops&recordId=rec_7&commentId=cmt_9&fieldId=fld_notes&openComments=true')

    const workbench = container?.querySelector('[data-workbench-sheet-id]')
    expect(workbench?.getAttribute('data-workbench-record-id')).toBe('rec_7')
    expect(workbench?.getAttribute('data-workbench-comment-id')).toBe('cmt_9')
    expect(workbench?.getAttribute('data-workbench-field-id')).toBe('fld_notes')
    expect(workbench?.getAttribute('data-workbench-open-comments')).toBe('true')
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

  it('forwards mt:ready only after the workbench signals readiness', async () => {
    await mountRouteHost('/multitable/sheet_orders/view_form?baseId=base_ops')

    await vi.waitFor(() => {
      const readyCalls = parentPostMessageSpy.mock.calls
        .map(([payload]) => payload)
        .filter((payload) => payload?.type === 'mt:ready')
      expect(readyCalls.length).toBe(1)
    })

    const readyCall = parentPostMessageSpy.mock.calls
      .map(([payload]) => payload)
      .find((payload) => payload?.type === 'mt:ready')

    expect(readyCall).toEqual({
      type: 'mt:ready',
      baseId: 'base_ops',
      sheetId: 'sheet_orders',
      viewId: 'view_form',
    })
  })

  it('reports the applied target context instead of a stale host snapshot', async () => {
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
      expect(container?.querySelector('[data-workbench-base-id]')?.getAttribute('data-workbench-base-id')).toBe('base_missing')
      expect(container?.querySelector('[data-workbench-sheet-id]')?.getAttribute('data-workbench-sheet-id')).toBe('sheet_missing')
      expect(container?.querySelector('[data-workbench-view-id]')?.getAttribute('data-workbench-view-id')).toBe('view_missing')
    })

    expect(host.navigationResults.at(-1)).toEqual({
      status: 'applied',
      baseId: 'base_missing',
      sheetId: 'sheet_missing',
      viewId: 'view_missing',
      reason: undefined,
      requestId: 'req_actual',
    })
    const navigatedCalls = parentPostMessageSpy.mock.calls
      .map(([payload]) => payload)
      .filter((payload) => payload?.type === 'mt:navigated')
    expect(navigatedCalls.at(-1)).toEqual({
      type: 'mt:navigated',
      baseId: 'base_missing',
      sheetId: 'sheet_missing',
      viewId: 'view_missing',
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
    expect(host.router.currentRoute.value.name).toBe(AppRouteNames.MULTITABLE)
    expect(host.router.currentRoute.value.params.sheetId).toBe('sheet_people')
    expect(host.router.currentRoute.value.params.viewId).toBe('view_gallery')
    expect(host.router.currentRoute.value.query.baseId).toBe('base_people')
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

  // #5750 follow-up: a host that answers mt:navigated with another mt:navigate ping-pongs forever.
  // Each re-send is a NEW requestId, so nothing at the message layer recognises it as a repeat, and
  // #5750's HTTP convergence does not help -- the workbench answers 'applied' again and the applied
  // branch posted a fresh mt:navigated, which triggered the next re-send. mt:navigate-result must
  // stay 1:1 with requests (a host awaiting a reply is never starved); mt:navigated must not repeat.
  it('#5750 follow-up posts one mt:navigate-result per request but only ONE mt:navigated for an identical repeated triple', async () => {
    const host = await mountRouteHost()
    const postedOfType = (type: string) =>
      parentPostMessageSpy.mock.calls
        .map(([payload]) => payload)
        .filter((payload) => (payload as { type?: string })?.type === type)

    for (let i = 1; i <= 5; i += 1) {
      window.dispatchEvent(new MessageEvent('message', {
        origin: window.location.origin,
        data: {
          type: 'mt:navigate',
          baseId: 'base_people',
          sheetId: 'sheet_people',
          viewId: 'view_gallery',
          requestId: `req_pingpong_${i}`,
        },
      }))
      await vi.waitFor(() => expect(requestExternalContextSyncSpy).toHaveBeenCalledTimes(i))
      await vi.waitFor(() => expect(host.navigationResults.length).toBe(i))
    }

    // Every request got its own reply, with its own requestId.
    const resultCalls = postedOfType('mt:navigate-result')
    expect(resultCalls).toHaveLength(5)
    expect(resultCalls.map((payload) => (payload as { requestId?: string }).requestId)).toEqual([
      'req_pingpong_1',
      'req_pingpong_2',
      'req_pingpong_3',
      'req_pingpong_4',
      'req_pingpong_5',
    ])
    expect(host.navigationResults.map((result) => result.status)).toEqual(
      ['applied', 'applied', 'applied', 'applied', 'applied'],
    )

    // ...but the echo that would feed the next re-send went out exactly once.
    expect(postedOfType('mt:navigated')).toEqual([{
      type: 'mt:navigated',
      baseId: 'base_people',
      sheetId: 'sheet_people',
      viewId: 'view_gallery',
      requestId: 'req_pingpong_1',
    }])
    expect(host.navigated).toEqual([{ sheetId: 'sheet_people', viewId: 'view_gallery' }])

    // A genuinely different triple is still a navigation the host has to hear about.
    window.dispatchEvent(new MessageEvent('message', {
      origin: window.location.origin,
      data: {
        type: 'mt:navigate',
        baseId: 'base_ops',
        sheetId: 'sheet_deals',
        viewId: 'view_board',
        requestId: 'req_pingpong_other',
      },
    }))
    await vi.waitFor(() => expect(requestExternalContextSyncSpy).toHaveBeenCalledTimes(6))
    await vi.waitFor(() => expect(postedOfType('mt:navigated')).toHaveLength(2))

    expect(postedOfType('mt:navigate-result')).toHaveLength(6)
    expect(postedOfType('mt:navigated').at(-1)).toEqual({
      type: 'mt:navigated',
      baseId: 'base_ops',
      sheetId: 'sheet_deals',
      viewId: 'view_board',
      requestId: 'req_pingpong_other',
    })
    expect(host.navigated).toEqual([
      { sheetId: 'sheet_people', viewId: 'view_gallery' },
      { sheetId: 'sheet_deals', viewId: 'view_board' },
    ])
  })

  // #5750 follow-up, second guard: a requestId is answered by exactly one mt:navigated. A workbench
  // result repeated under an already-answered requestId (the host re-sends the external-context
  // echo on a timer, #5750) must not produce a second reply for it -- but it must not be swallowed
  // either when it really moved the frame, or the parent loses track of where the frame is. The
  // repeat is therefore echoed as an ordinary navigation, WITHOUT the spent requestId.
  it('#5750 follow-up never echoes the same requestId twice, yet still reports the move it caused', async () => {
    const host = await mountRouteHost()
    const navigatedPosts = () =>
      parentPostMessageSpy.mock.calls
        .map(([payload]) => payload as { type?: string; baseId?: string; sheetId?: string; viewId?: string; requestId?: string | number })
        .filter((payload) => payload?.type === 'mt:navigated')

    replayExternalContextResult?.({
      status: 'applied',
      context: { baseId: 'base_people', sheetId: 'sheet_people', viewId: 'view_gallery' },
      requestId: 'req_dup',
    })
    await vi.waitFor(() => expect(navigatedPosts()).toHaveLength(1))
    expect(navigatedPosts()[0]?.requestId).toBe('req_dup')

    // Something else moves the frame, so the repeat below cannot be caught by the triple guard.
    window.dispatchEvent(new MessageEvent('message', {
      origin: window.location.origin,
      data: { type: 'mt:navigate', baseId: 'base_ops', sheetId: 'sheet_deals', viewId: 'view_board', requestId: 'req_move' },
    }))
    await vi.waitFor(() => expect(navigatedPosts()).toHaveLength(2))

    replayExternalContextResult?.({
      status: 'applied',
      context: { baseId: 'base_people', sheetId: 'sheet_people', viewId: 'view_gallery' },
      requestId: 'req_dup',
    })
    await vi.waitFor(() => expect(navigatedPosts()).toHaveLength(3))

    // The frame really went back, and the parent was told...
    expect(navigatedPosts().at(-1)).toEqual({
      type: 'mt:navigated',
      baseId: 'base_people',
      sheetId: 'sheet_people',
      viewId: 'view_gallery',
      requestId: undefined,
    })
    expect(container?.querySelector('[data-workbench-sheet-id]')?.getAttribute('data-workbench-sheet-id')).toBe('sheet_people')
    expect(host.navigated).toEqual([
      { sheetId: 'sheet_people', viewId: 'view_gallery' },
      { sheetId: 'sheet_deals', viewId: 'view_board' },
      { sheetId: 'sheet_people', viewId: 'view_gallery' },
    ])
    // ...but 'req_dup' was answered exactly once.
    expect(navigatedPosts().filter((payload) => payload.requestId === 'req_dup')).toHaveLength(1)
  })

  // Review round 2: the ?recordId=/?mode= cleanup used to ride along on the URL rewrite, and the URL
  // was rewritten because the echoed (= requested) triple differed from the one on screen. Now that
  // the workbench echoes the RESOLVED triple, a request naming a view this sheet does not have
  // resolves back to the view already on screen -- the frame does not move, so nothing rewrites the
  // URL, and the deep-link keys would survive a navigation that was supposed to clear them.
  it('#5750 follow-up still strips recordId/mode when the request resolves back to the view on screen', async () => {
    const host = await mountRouteHost('/multitable/sheet_orders/view_grid?baseId=base_ops&recordId=rec_1&mode=readonly')
    expect(host.router.currentRoute.value.query.recordId).toBe('rec_1')
    // What the workbench answers for a dead view id: views[0], which here is the view on screen.
    requestExternalContextSyncSpy.mockResolvedValueOnce({
      status: 'applied',
      context: { baseId: 'base_ops', sheetId: 'sheet_orders', viewId: 'view_grid' },
    })

    window.dispatchEvent(new MessageEvent('message', {
      origin: window.location.origin,
      data: { type: 'mt:navigate', baseId: 'base_ops', sheetId: 'sheet_orders', viewId: 'view_deleted', requestId: 'req_dead_view' },
    }))
    await vi.waitFor(() => expect(requestExternalContextSyncSpy).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(host.router.currentRoute.value.query.recordId).toBeUndefined())

    expect(host.router.currentRoute.value.query.mode).toBeUndefined()
    // ...while the URL keeps the live view, never the dead one the host asked for.
    expect(host.router.currentRoute.value.params.viewId).toBe('view_grid')
    expect(host.router.currentRoute.value.params.sheetId).toBe('sheet_orders')
    expect(host.router.currentRoute.value.query.baseId).toBe('base_ops')
    const navigatedPosts = parentPostMessageSpy.mock.calls
      .map(([payload]) => payload as { type?: string; viewId?: string; requestId?: string | number })
      .filter((payload) => payload?.type === 'mt:navigated')
    expect(navigatedPosts).toHaveLength(1)
    expect(navigatedPosts[0]?.viewId).toBe('view_grid')
    expect(navigatedPosts[0]?.requestId).toBe('req_dead_view')
  })

  // Review round 2: the triple guard is keyed on what the HOST last echoed, and the host's overrides
  // never see an in-frame navigation (a user clicking another view inside the iframe) -- so a parent
  // that polls mt:get-navigation-state, sees the drift and navigates back would have its real move
  // suppressed as a duplicate. The poll is the moment the host learns the frame is not where it said
  // it was; from then on that landing is news again.
  it('#5750 follow-up re-echoes a triple the frame drifted away from once the parent has polled the drift', async () => {
    const host = await mountRouteHost()
    const postedOfType = (type: string) =>
      parentPostMessageSpy.mock.calls
        .map(([payload]) => payload as { type?: string; baseId?: string; sheetId?: string; viewId?: string; requestId?: string | number; currentContext?: { viewId?: string } })
        .filter((payload) => payload?.type === type)

    window.dispatchEvent(new MessageEvent('message', {
      origin: window.location.origin,
      data: { type: 'mt:navigate', baseId: 'base_people', sheetId: 'sheet_people', viewId: 'view_gallery', requestId: 'req_first' },
    }))
    await vi.waitFor(() => expect(postedOfType('mt:navigated')).toHaveLength(1))

    // The user switches view INSIDE the frame: the workbench moves, the host's overrides do not.
    getEmbedHostStateSpy.mockReturnValue({
      currentContext: { baseId: 'base_people', sheetId: 'sheet_people', viewId: 'view_kanban' },
      hasBlockingState: false,
      blockingReason: null,
      hasUnsavedDrafts: false,
      busy: false,
      pendingContext: null,
    })
    window.dispatchEvent(new MessageEvent('message', {
      origin: window.location.origin,
      data: { type: 'mt:get-navigation-state', requestId: 'req_poll' },
    }))
    await vi.waitFor(() => expect(postedOfType('mt:navigation-state')).toHaveLength(1))
    expect(postedOfType('mt:navigation-state')[0]?.currentContext?.viewId).toBe('view_kanban')

    // The parent corrects back to the triple it was last told about. That is a real move.
    getEmbedHostStateSpy.mockReturnValue({
      currentContext: { baseId: 'base_people', sheetId: 'sheet_people', viewId: 'view_gallery' },
      hasBlockingState: false,
      blockingReason: null,
      hasUnsavedDrafts: false,
      busy: false,
      pendingContext: null,
    })
    window.dispatchEvent(new MessageEvent('message', {
      origin: window.location.origin,
      data: { type: 'mt:navigate', baseId: 'base_people', sheetId: 'sheet_people', viewId: 'view_gallery', requestId: 'req_correct' },
    }))
    await vi.waitFor(() => expect(postedOfType('mt:navigate-result')).toHaveLength(2))
    await vi.waitFor(() => expect(postedOfType('mt:navigated')).toHaveLength(2))

    expect(postedOfType('mt:navigated').at(-1)).toEqual({
      type: 'mt:navigated',
      baseId: 'base_people',
      sheetId: 'sheet_people',
      viewId: 'view_gallery',
      requestId: 'req_correct',
    })
    expect(host.navigated).toEqual([
      { sheetId: 'sheet_people', viewId: 'view_gallery' },
      { sheetId: 'sheet_people', viewId: 'view_gallery' },
    ])
  })

  // Review round 2: a requestId is spent by an echo that GOES OUT. Recording it on the suppressed
  // path would answer a request with silence and then strip its id from the echo that really carries
  // it, leaving the parent an uncorrelatable message for a request it never saw answered.
  it('#5750 follow-up keeps the requestId usable when its first echo was suppressed as a duplicate', async () => {
    await mountRouteHost()
    const navigatedPosts = () =>
      parentPostMessageSpy.mock.calls
        .map(([payload]) => payload as { type?: string; sheetId?: string; requestId?: string | number })
        .filter((payload) => payload?.type === 'mt:navigated')

    window.dispatchEvent(new MessageEvent('message', {
      origin: window.location.origin,
      data: { type: 'mt:navigate', baseId: 'base_people', sheetId: 'sheet_people', viewId: 'view_gallery', requestId: 'req_a' },
    }))
    await vi.waitFor(() => expect(navigatedPosts()).toHaveLength(1))

    // A workbench result for a FRESH request repeats the triple already echoed: suppressed.
    replayExternalContextResult?.({
      status: 'applied',
      context: { baseId: 'base_people', sheetId: 'sheet_people', viewId: 'view_gallery' },
      requestId: 'req_late',
    })
    await nextTick()
    await nextTick()
    expect(navigatedPosts()).toHaveLength(1)

    // The same request then really moves the frame -- its echo must still carry its id.
    replayExternalContextResult?.({
      status: 'applied',
      context: { baseId: 'base_ops', sheetId: 'sheet_deals', viewId: 'view_board' },
      requestId: 'req_late',
    })
    await vi.waitFor(() => expect(navigatedPosts()).toHaveLength(2))
    expect(navigatedPosts().at(-1)).toEqual({
      type: 'mt:navigated',
      baseId: 'base_ops',
      sheetId: 'sheet_deals',
      viewId: 'view_board',
      requestId: 'req_late',
    })
  })
})

// P3-D2: positive coverage for the two owner-named origin fixes -- the wildcard is no longer honored
// on inbound, and outbound posts pin a concrete origin instead of '*'.
describe('multitable embed host — origin hardening (P3-D2)', () => {
  let originApp: VueApp<Element> | null = null
  let originContainer: HTMLDivElement | null = null
  let parentSpy: ReturnType<typeof vi.fn>
  let savedParent: WindowProxy

  beforeEach(() => {
    confirmPageLeaveSpy.mockReset()
    confirmPageLeaveSpy.mockReturnValue(true)
    getEmbedHostStateSpy.mockReset()
    getEmbedHostStateSpy.mockReturnValue({
      currentContext: { baseId: 'b', sheetId: 's', viewId: 'v' },
      hasBlockingState: false,
      blockingReason: null,
      hasUnsavedDrafts: false,
      busy: false,
      pendingContext: null,
    })
    requestExternalContextSyncSpy.mockReset()
    requestExternalContextSyncSpy.mockImplementation(async (input) => ({
      status: 'applied',
      context: { baseId: input.baseId ?? '', sheetId: input.sheetId ?? '', viewId: input.viewId ?? '' },
    }))
    parentSpy = vi.fn()
    savedParent = window.parent
    Object.defineProperty(window, 'parent', { configurable: true, value: { postMessage: parentSpy } })
  })

  afterEach(() => {
    if (originApp) originApp.unmount()
    originApp = null
    if (originContainer?.parentNode) originContainer.parentNode.removeChild(originContainer)
    originContainer = null
    Object.defineProperty(window, 'parent', { configurable: true, value: savedParent })
  })

  async function mountHostWithOrigins(allowedOrigins: string[]) {
    originContainer = document.createElement('div')
    document.body.appendChild(originContainer)
    const HostWrap = defineComponent({
      name: 'OriginHostWrap',
      components: { MultitableEmbedHost },
      setup() { return { allowedOrigins } },
      template: `<MultitableEmbedHost base-id="b" sheet-id="s" view-id="v" :allowed-origins="allowedOrigins" />`,
    })
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/', name: 'origin-root', component: HostWrap }],
    })
    originApp = createApp(defineComponent({ name: 'OriginRoot', render: () => h(RouterView) }))
    originApp.use(router)
    await router.push('/')
    await router.isReady()
    originApp.mount(originContainer)
    await nextTick()
  }

  it('rejects an inbound message from a foreign origin even when allowedOrigins includes "*"', async () => {
    await mountHostWithOrigins(['*'])
    parentSpy.mockClear()
    // the wildcard is no longer a pass -- a foreign origin is rejected, so the host never responds
    window.dispatchEvent(new MessageEvent('message', {
      origin: 'https://evil.example.com',
      data: { type: 'mt:get-navigation-state', requestId: 'rEvil' },
    }))
    await nextTick()
    await nextTick()
    const responded = parentSpy.mock.calls.some(
      ([payload]) => (payload as { type?: string })?.type === 'mt:navigation-state',
    )
    expect(responded).toBe(false)
  })

  it('pins outbound postMessage to the allowlisted parent origin and never targets "*"', async () => {
    await mountHostWithOrigins(['https://plm.example.com'])
    window.dispatchEvent(new MessageEvent('message', {
      origin: 'https://plm.example.com',
      data: { type: 'mt:get-navigation-state', requestId: 'rOk' },
    }))
    await vi.waitFor(() => {
      expect(
        parentSpy.mock.calls.some(([payload]) => (payload as { type?: string })?.type === 'mt:navigation-state'),
      ).toBe(true)
    })
    // no outbound post -- mount-time or response -- ever targets '*'
    for (const call of parentSpy.mock.calls) {
      expect(call[1]).not.toBe('*')
    }
    const stateCall = parentSpy.mock.calls.find(
      ([payload]) => (payload as { type?: string })?.type === 'mt:navigation-state',
    )
    expect(stateCall?.[1]).toBe('https://plm.example.com')
  })
})
