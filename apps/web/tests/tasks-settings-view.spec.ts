import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, createApp, defineComponent, h, nextTick, ref, type App as VueApp } from 'vue'
import { createMemoryHistory, createRouter, RouterView, type Router } from 'vue-router'

/**
 * M4 FE-3 — `/tasks/settings` (TasksSettingsView.vue) and its entry on the /tasks list header
 * (docs/development/task-m4-frontend-design-20261007.md §2.1–§2.2, §4.5, §7.1, §10.1; backend
 * contract `GET/PATCH /api/task-settings`, PR-3a S3). The route's meta and the gate-22 cells for
 * the new path are in tasks-routes.spec.ts; the EN / ZH copy sweep is in tasks-labels.spec.ts.
 *
 * Mock face: `apiFetch` plays the backend by path, so the REAL tasksApi client builds every request
 * and parses every answer — request bodies are asserted byte for byte as the client serialized
 * them. Also mocked: `loadTasksContext`, `notifyTasksChanged`, `useAuth`, `useLocale` (ZH), and
 * `resolveViewerTimeZone`, which answers a fixed zone that is neither UTC nor the zone of the
 * machine running the cells. The router and both views are real. No backend runs here.
 */

const h_ = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  loadTasksContext: vi.fn(),
  notifyTasksChanged: vi.fn(),
  resolveViewerTimeZone: vi.fn(),
  getCurrentUserId: vi.fn(),
  /** `GET /api/task-settings` -> the response (or a promise of it). */
  getSettingsReply: vi.fn(),
  /** `PATCH /api/task-settings` (the serialized body) -> the response (or a promise of it). */
  patchSettingsReply: vi.fn(),
}))

vi.mock('../src/utils/api', () => ({
  apiFetch: h_.apiFetch,
}))

vi.mock('../src/tasks/tasksContext', () => ({
  loadTasksContext: h_.loadTasksContext,
}))

vi.mock('../src/tasks/tasksBadgeBus', () => ({
  notifyTasksChanged: h_.notifyTasksChanged,
  onTasksChanged: () => () => undefined,
}))

vi.mock('../src/tasks/tasksApi', async () => {
  const actual = await vi.importActual<typeof import('../src/tasks/tasksApi')>('../src/tasks/tasksApi')
  return { ...actual, resolveViewerTimeZone: h_.resolveViewerTimeZone }
})

vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({ getCurrentUserId: h_.getCurrentUserId }),
}))

vi.mock('../src/composables/useLocale', () => {
  const isZh = ref(true)
  return {
    useLocale: () => ({
      locale: computed(() => (isZh.value ? 'zh-CN' : 'en')),
      isZh,
      setLocale: (next: unknown) => {
        isZh.value = next === 'zh-CN'
      },
    }),
  }
})

import TasksSettingsView from '../src/views/tasks/TasksSettingsView.vue'
import TasksView from '../src/views/tasks/TasksView.vue'

// ---------------------------------------------------------------------------------------------
// Fixtures and the fake backend
// ---------------------------------------------------------------------------------------------

/** The browser zone every cell sees unless it says otherwise. */
const BROWSER_ZONE = 'Pacific/Chatham'

const SETTINGS = Object.freeze({
  badgeScope: 'overdue',
  dailyReminderEnabled: false,
  defaultRemindPolicy: Object.freeze({ mode: 'default' }),
  timeZone: null as string | null,
})

function settings(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...SETTINGS, defaultRemindPolicy: { ...SETTINGS.defaultRemindPolicy }, ...over }
}

function jsonResponse(status: number, body: unknown): Response {
  return { status, json: async () => body } as unknown as Response
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolveFn!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolveFn = res
  })
  return { promise, resolve: resolveFn }
}

type FetchInit = { method?: string; body?: string } | undefined

function settingsCalls(method: 'GET' | 'PATCH'): Array<[string, FetchInit]> {
  return (h_.apiFetch.mock.calls as Array<[string, FetchInit]>).filter(
    ([path, init]) => path === '/api/task-settings' && (init?.method ?? 'GET') === method,
  )
}

/** The bodies of every `PATCH /api/task-settings`, exactly as the client serialized them. */
function patchBodies(): string[] {
  return settingsCalls('PATCH').map(([, init]) => init?.body as string)
}

// ---------------------------------------------------------------------------------------------
// Mount helpers
// ---------------------------------------------------------------------------------------------

let app: VueApp<Element> | null = null
let container: HTMLDivElement | null = null
let router: Router | null = null

async function flush(cycles = 10): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

const OtherPage = defineComponent({
  name: 'OtherPage',
  render: () => h('p', { 'data-testid': 'other-page' }, 'other page'),
})

/** `/tasks/settings` on a real router whose `/tasks` is a stand-in page (leaving the settings page
 *  unmounts it). With `withTasksView`, `/tasks` and `/tasks/:id` are the real TasksView, in the
 *  order appRoutes.ts lists the three records. */
async function mountAt(path: string, options: { withTasksView?: boolean } = {}): Promise<HTMLElement> {
  router = createRouter({
    history: createMemoryHistory(),
    routes: options.withTasksView
      ? [
          { path: '/tasks', name: 'tasks', component: TasksView },
          { path: '/tasks/settings', name: 'tasks-settings', component: TasksSettingsView },
          { path: '/tasks/:id', name: 'task-detail', component: TasksView },
        ]
      : [
          { path: '/tasks', name: 'tasks', component: OtherPage },
          { path: '/tasks/settings', name: 'tasks-settings', component: TasksSettingsView },
        ],
  })
  const RootShell = defineComponent({ name: 'RootShell', render: () => h(RouterView) })
  container = document.createElement('div')
  document.body.appendChild(container)
  app = createApp(RootShell)
  app.use(router)
  app.mount(container)
  await router.push(path)
  await router.isReady()
  await flush()
  return container
}

/** What TasksSettingsView exposes (`defineExpose`) — read only by the late-result cells. */
interface SettingsPageHandle {
  readResult: { kind: string; settings?: Record<string, unknown> }
  draft: { badgeScope: string; dailyReminderEnabled: boolean; defaultRemindPolicy: { mode: string }; timeZone: string }
  pending: boolean
  saved: boolean
  fieldErrors: Record<string, string>
  saveBannerKind: string | null
  orgMissingFromSave: boolean
}

/** The settings page instance the router is showing right now. */
function settingsPage(): SettingsPageHandle {
  const instance = router!.currentRoute.value.matched[0]?.instances.default
  expect(instance, 'the router shows a settings page instance').toBeTruthy()
  return instance as unknown as SettingsPageHandle
}

function shown(el: HTMLElement, testid: string): HTMLElement | null {
  return el.querySelector(`[data-testid="${testid}"]`)
}

function must(el: HTMLElement, testid: string): HTMLElement {
  const found = shown(el, testid)
  expect(found, `expected [data-testid="${testid}"]`).toBeTruthy()
  return found as HTMLElement
}

function text(el: HTMLElement, testid: string): string {
  return must(el, testid).textContent?.trim() ?? ''
}

function input(el: HTMLElement, testid: string): HTMLInputElement {
  return must(el, testid) as HTMLInputElement
}

function saveButton(el: HTMLElement): HTMLButtonElement {
  return must(el, 'tasks-settings-save') as HTMLButtonElement
}

async function pickBadgeScope(el: HTMLElement, value: string): Promise<void> {
  input(el, `tasks-settings-badge-scope-${value}`).click()
  await flush()
}

async function toggleDailyReminder(el: HTMLElement): Promise<void> {
  input(el, 'tasks-settings-daily-reminder').click()
  await flush()
}

async function choosePolicy(el: HTMLElement, mode: string): Promise<void> {
  const select = must(el, 'tasks-settings-remind-policy') as HTMLSelectElement
  select.value = mode
  select.dispatchEvent(new Event('change'))
  await flush()
}

async function typeZone(el: HTMLElement, value: string): Promise<void> {
  const field = input(el, 'tasks-settings-time-zone')
  field.value = value
  field.dispatchEvent(new Event('input'))
  await flush()
}

/** Submits the form the way the browser does on Enter or a click on the save button. Dispatching
 *  the event directly also reaches the handler while the button is disabled, so the handler's own
 *  guards are what a cell sees. */
async function submit(el: HTMLElement): Promise<void> {
  must(el, 'tasks-settings-form').dispatchEvent(new Event('submit', { cancelable: true }))
  await flush()
}

beforeEach(() => {
  h_.loadTasksContext.mockReset().mockResolvedValue({ state: 'ready', orgId: 'org1' })
  h_.notifyTasksChanged.mockReset()
  h_.resolveViewerTimeZone.mockReset().mockReturnValue(BROWSER_ZONE)
  h_.getCurrentUserId.mockReset().mockResolvedValue(null)
  h_.getSettingsReply.mockReset().mockImplementation(() => jsonResponse(200, settings()))
  // The default PATCH answer merges the sent keys onto the fixture, as the server does.
  h_.patchSettingsReply.mockReset().mockImplementation((body: string) => jsonResponse(200, { ...settings(), ...JSON.parse(body) }))
  h_.apiFetch.mockReset().mockImplementation(async (path: string, init?: FetchInit) => {
    const method = init?.method ?? 'GET'
    if (path === '/api/task-settings' && method === 'GET') return h_.getSettingsReply()
    if (path === '/api/task-settings' && method === 'PATCH') return h_.patchSettingsReply(init?.body)
    if (path.startsWith('/api/tasks?view=')) return jsonResponse(200, { items: [] })
    return jsonResponse(404, { error: { code: 'NOT_FOUND' } })
  })
})

afterEach(() => {
  app?.unmount()
  container?.remove()
  app = null
  container = null
  router = null
})

// ---------------------------------------------------------------------------------------------
// The entry on the /tasks list header (design §2.2)
// ---------------------------------------------------------------------------------------------

describe('the settings entry on the /tasks header', () => {
  it('the ready list page links to /tasks/settings beside the heading, not inside it', async () => {
    const el = await mountAt('/tasks', { withTasksView: true })
    const link = must(el, 'tasks-settings-link')
    expect(link.tagName).toBe('A')
    expect(link.getAttribute('href')).toBe('/tasks/settings')
    expect(link.textContent?.trim()).toBe('设置')
    expect(el.querySelector('h1')?.textContent).toBe('任务')
    expect(link.closest('header')).toBe(el.querySelector('h1')?.closest('header'))
  })

  it('following the link opens the settings page (the static path, not a task id)', async () => {
    const el = await mountAt('/tasks', { withTasksView: true })
    must(el, 'tasks-settings-link').click()
    await flush()
    await vi.waitFor(() => expect(shown(el, 'tasks-settings-form')).toBeTruthy())
    expect(router!.currentRoute.value.name).toBe('tasks-settings')
    expect(el.querySelector('h1')?.textContent).toBe('任务设置')
    expect(settingsCalls('GET')).toHaveLength(1)
    expect(h_.apiFetch.mock.calls.some(([path]) => String(path).startsWith('/api/tasks/settings'))).toBe(false)
  })

  it('is absent from the detail page', async () => {
    const el = await mountAt('/tasks/t1', { withTasksView: true })
    expect(el.querySelector('h1')?.textContent).toBe('任务详情')
    expect(shown(el, 'tasks-settings-link')).toBeNull()
  })

  it.each([
    ['org_missing', 'tasks-view-org-missing'],
    ['unavailable', 'tasks-view-unavailable'],
    ['forbidden', 'tasks-view-forbidden'],
    ['error', 'tasks-view-error'],
  ] as const)('is absent while the tasks context is %s', async (state, testid) => {
    h_.loadTasksContext.mockResolvedValue({ state })
    const el = await mountAt('/tasks', { withTasksView: true })
    expect(shown(el, testid)).toBeTruthy()
    expect(shown(el, 'tasks-settings-link')).toBeNull()
  })

  it('is absent when a list read reports org_missing (the guidance block replaces the page)', async () => {
    h_.apiFetch.mockImplementation(async () => jsonResponse(200, { items: [], degraded: true, reason: 'org_missing' }))
    const el = await mountAt('/tasks', { withTasksView: true })
    expect(shown(el, 'tasks-view-org-missing')).toBeTruthy()
    expect(shown(el, 'tasks-settings-link')).toBeNull()
  })
})

// ---------------------------------------------------------------------------------------------
// Read states (design §4.5)
// ---------------------------------------------------------------------------------------------

describe('TasksSettingsView — read states', () => {
  it('shows loading while the context read is pending, and reads no settings before it is ready', async () => {
    const context = deferred<unknown>()
    h_.loadTasksContext.mockReturnValue(context.promise)
    const el = await mountAt('/tasks/settings')
    expect(text(el, 'tasks-settings-loading')).toBe('加载中…')
    expect(settingsCalls('GET')).toHaveLength(0)

    context.resolve({ state: 'ready', orgId: 'org1' })
    await flush()
    expect(settingsCalls('GET')).toHaveLength(1)
    expect(shown(el, 'tasks-settings-form')).toBeTruthy()
  })

  it('shows loading while the settings read is pending, then the form', async () => {
    const reply = deferred<Response>()
    h_.getSettingsReply.mockReturnValue(reply.promise)
    const el = await mountAt('/tasks/settings')
    expect(text(el, 'tasks-settings-loading')).toBe('加载中…')
    expect(shown(el, 'tasks-settings-form')).toBeNull()

    reply.resolve(jsonResponse(200, settings()))
    await flush()
    expect(shown(el, 'tasks-settings-loading')).toBeNull()
    expect(shown(el, 'tasks-settings-form')).toBeTruthy()
  })

  it('a 404 renders the not-found state (a missing route or a missing org) and no form', async () => {
    h_.getSettingsReply.mockReturnValue(jsonResponse(404, { error: { code: 'NOT_FOUND' } }))
    const el = await mountAt('/tasks/settings')
    expect(text(el, 'tasks-settings-not-found')).toBe('无法读取设置：当前服务不支持，或尚未选择组织')
    expect(shown(el, 'tasks-settings-forbidden')).toBeNull()
    expect(shown(el, 'tasks-settings-error')).toBeNull()
    expect(shown(el, 'tasks-settings-form')).toBeNull()
  })

  it('a 403 renders the forbidden state and no form', async () => {
    h_.getSettingsReply.mockReturnValue(jsonResponse(403, null))
    const el = await mountAt('/tasks/settings')
    expect(text(el, 'tasks-settings-forbidden')).toBe('您没有权限查看任务设置')
    expect(shown(el, 'tasks-settings-not-found')).toBeNull()
    expect(shown(el, 'tasks-settings-error')).toBeNull()
    expect(shown(el, 'tasks-settings-form')).toBeNull()
  })

  it.each([
    ['a 500', () => jsonResponse(500, null)],
    ['a malformed 200', () => jsonResponse(200, { ...settings(), badgeScope: 'sometimes' })],
    ['a transport failure', () => Promise.reject(new TypeError('Failed to fetch'))],
  ] as const)('%s renders the error state and no form', async (_label, reply) => {
    h_.getSettingsReply.mockImplementation(reply)
    const el = await mountAt('/tasks/settings')
    expect(text(el, 'tasks-settings-error')).toBe('加载任务设置失败，请稍后重试')
    expect(shown(el, 'tasks-settings-not-found')).toBeNull()
    expect(shown(el, 'tasks-settings-forbidden')).toBeNull()
    expect(shown(el, 'tasks-settings-form')).toBeNull()
  })

  it.each([
    ['org_missing', 'tasks-view-org-missing', '请先选择一个组织后再查看任务'],
    ['unavailable', 'tasks-view-unavailable', '任务功能未启用或当前服务不支持'],
    ['forbidden', 'tasks-view-forbidden', '您没有权限查看任务'],
    ['error', 'tasks-view-error', '加载任务时出现错误，请稍后重试'],
  ] as const)('context %s renders the TasksView block and copy, and reads no settings', async (state, testid, copy) => {
    h_.loadTasksContext.mockResolvedValue({ state })
    const el = await mountAt('/tasks/settings')
    expect(text(el, testid)).toBe(copy)
    expect(shown(el, 'tasks-settings-form')).toBeNull()
    expect(shown(el, 'tasks-settings-loading')).toBeNull()
    expect(settingsCalls('GET')).toHaveLength(0)
  })

  it('carries the page heading and a link back to /tasks', async () => {
    const el = await mountAt('/tasks/settings')
    expect(el.querySelector('h1')?.textContent).toBe('任务设置')
    const back = must(el, 'tasks-settings-back-link')
    expect(back.getAttribute('href')).toBe('/tasks')
    expect(back.textContent).toContain('返回任务列表')
  })
})

// ---------------------------------------------------------------------------------------------
// The form (design §7.1)
// ---------------------------------------------------------------------------------------------

describe('TasksSettingsView — the form', () => {
  it('starts from the server values', async () => {
    h_.getSettingsReply.mockReturnValue(
      jsonResponse(200, settings({ badgeScope: 'overdue_or_today', dailyReminderEnabled: true, defaultRemindPolicy: { mode: 'none' }, timeZone: 'Asia/Shanghai' })),
    )
    const el = await mountAt('/tasks/settings')
    expect(input(el, 'tasks-settings-badge-scope-overdue_or_today').checked).toBe(true)
    expect(input(el, 'tasks-settings-badge-scope-off').checked).toBe(false)
    expect(input(el, 'tasks-settings-badge-scope-overdue').checked).toBe(false)
    expect(input(el, 'tasks-settings-daily-reminder').checked).toBe(true)
    expect((must(el, 'tasks-settings-remind-policy') as HTMLSelectElement).value).toBe('none')
    expect(input(el, 'tasks-settings-time-zone').value).toBe('Asia/Shanghai')
    expect(must(el, 'tasks-settings-use-browser-zone').getAttribute('data-suggested')).toBe('false')
  })

  it('a `timeZone: null` leaves the zone input empty and highlights the browser-zone suggestion', async () => {
    const el = await mountAt('/tasks/settings')
    expect(input(el, 'tasks-settings-badge-scope-overdue').checked).toBe(true)
    expect(input(el, 'tasks-settings-daily-reminder').checked).toBe(false)
    expect((must(el, 'tasks-settings-remind-policy') as HTMLSelectElement).value).toBe('default')
    expect(input(el, 'tasks-settings-time-zone').value).toBe('')
    expect(must(el, 'tasks-settings-use-browser-zone').getAttribute('data-suggested')).toBe('true')
  })

  it('labels every control and groups the badge scopes under a legend', async () => {
    const el = await mountAt('/tasks/settings')
    const fieldset = must(el, 'tasks-settings-badge-scope')
    expect(fieldset.tagName).toBe('FIELDSET')
    expect(fieldset.querySelector('legend')?.textContent?.trim()).toBe('红点统计范围')
    const radioLabels = Array.from(fieldset.querySelectorAll('label')).map((label) => label.textContent?.trim())
    expect(radioLabels).toEqual(['关闭', '仅逾期', '逾期与今天到期'])
    expect(input(el, 'tasks-settings-daily-reminder').closest('label')?.textContent?.trim()).toBe('每日汇总提醒')
    expect(input(el, 'tasks-settings-daily-reminder').getAttribute('aria-describedby')).toBe('tasks-settings-daily-reminder-note')
    expect(text(el, 'tasks-settings-daily-reminder-note')).toBe('按你的时区每天固定时刻发送；是否实际发送取决于服务端配置')
    const select = must(el, 'tasks-settings-remind-policy')
    expect(el.querySelector(`label[for="${select.id}"]`)?.textContent?.trim()).toBe('新任务的缺省提醒')
    expect(Array.from(select.querySelectorAll('option')).map((o) => [o.value, o.textContent?.trim()])).toEqual([
      ['default', '按缺省规则'],
      ['none', '不提醒'],
    ])
    const zone = input(el, 'tasks-settings-time-zone')
    expect(el.querySelector(`label[for="${zone.id}"]`)?.textContent?.trim()).toBe('时区')
    expect(zone.getAttribute('list')).toBe('tasks-settings-time-zone-options')
    expect(must(el, 'tasks-settings-use-browser-zone').getAttribute('type')).toBe('button')
    expect(must(el, 'tasks-settings-use-browser-zone').textContent?.trim()).toBe('使用浏览器时区')
  })

  it('offers zone candidates with the browser zone first', async () => {
    const el = await mountAt('/tasks/settings')
    const options = must(el, 'tasks-settings-time-zone-options').querySelectorAll('option')
    expect(options.length).toBeGreaterThan(0)
    expect(options[0].getAttribute('value')).toBe(BROWSER_ZONE)
  })

  it('with nothing changed the save button is disabled and a submit sends nothing', async () => {
    const el = await mountAt('/tasks/settings')
    expect(saveButton(el).disabled).toBe(true)
    await submit(el)
    expect(patchBodies()).toEqual([])
  })

  it('a change enables the save button; changing it back disables it again', async () => {
    const el = await mountAt('/tasks/settings')
    await pickBadgeScope(el, 'off')
    expect(saveButton(el).disabled).toBe(false)
    await pickBadgeScope(el, 'overdue')
    expect(saveButton(el).disabled).toBe(true)
    await submit(el)
    expect(patchBodies()).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------
// Only the changed keys are sent (design §7.1)
// ---------------------------------------------------------------------------------------------

describe('TasksSettingsView — the request carries only the changed keys', () => {
  it('a badge scope change sends exactly that key', async () => {
    const el = await mountAt('/tasks/settings')
    await pickBadgeScope(el, 'off')
    await submit(el)
    expect(patchBodies()).toEqual(['{"badgeScope":"off"}'])
  })

  it('clearing the zone sends `timeZone: null` and nothing else', async () => {
    h_.getSettingsReply.mockReturnValue(jsonResponse(200, settings({ timeZone: 'Asia/Shanghai' })))
    const el = await mountAt('/tasks/settings')
    await typeZone(el, '')
    await submit(el)
    expect(patchBodies()).toEqual(['{"timeZone":null}'])
  })

  it('two changes send exactly those two keys, in the contract order', async () => {
    const el = await mountAt('/tasks/settings')
    await typeZone(el, 'Europe/Paris')
    await choosePolicy(el, 'none')
    await submit(el)
    expect(patchBodies()).toEqual(['{"defaultRemindPolicy":{"mode":"none"},"timeZone":"Europe/Paris"}'])
  })

  it('the daily reminder alone, with a zone already saved, sends exactly that key', async () => {
    h_.getSettingsReply.mockReturnValue(jsonResponse(200, settings({ timeZone: 'Asia/Shanghai' })))
    const el = await mountAt('/tasks/settings')
    await toggleDailyReminder(el)
    await submit(el)
    expect(patchBodies()).toEqual(['{"dailyReminderEnabled":true}'])
  })
})

// ---------------------------------------------------------------------------------------------
// The zone the daily reminder needs, and the browser-zone button (design §7.1, [fe-06])
// ---------------------------------------------------------------------------------------------

describe('TasksSettingsView — the daily reminder and the time zone', () => {
  it('ticking the daily reminder with an empty zone fills in the browser zone and says so; saving sends both', async () => {
    const el = await mountAt('/tasks/settings')
    await toggleDailyReminder(el)
    expect(input(el, 'tasks-settings-daily-reminder').checked).toBe(true)
    expect(input(el, 'tasks-settings-time-zone').value).toBe(BROWSER_ZONE)
    expect(text(el, 'tasks-settings-time-zone-autofilled')).toBe('已按浏览器时区填入，可修改')
    expect(input(el, 'tasks-settings-time-zone').getAttribute('aria-describedby')).toBe('tasks-settings-time-zone-autofilled')
    expect(patchBodies()).toEqual([])

    await submit(el)
    expect(patchBodies()).toEqual([`{"dailyReminderEnabled":true,"timeZone":"${BROWSER_ZONE}"}`])
  })

  it('ticking the daily reminder keeps a zone that is already there', async () => {
    h_.getSettingsReply.mockReturnValue(jsonResponse(200, settings({ timeZone: 'Asia/Shanghai' })))
    const el = await mountAt('/tasks/settings')
    await toggleDailyReminder(el)
    expect(input(el, 'tasks-settings-time-zone').value).toBe('Asia/Shanghai')
    expect(shown(el, 'tasks-settings-time-zone-autofilled')).toBeNull()
  })

  it('unticking the daily reminder leaves the zone as it is', async () => {
    h_.getSettingsReply.mockReturnValue(jsonResponse(200, settings({ dailyReminderEnabled: true, timeZone: 'Asia/Shanghai' })))
    const el = await mountAt('/tasks/settings')
    await toggleDailyReminder(el)
    expect(input(el, 'tasks-settings-daily-reminder').checked).toBe(false)
    expect(input(el, 'tasks-settings-time-zone').value).toBe('Asia/Shanghai')
    await submit(el)
    expect(patchBodies()).toEqual(['{"dailyReminderEnabled":false}'])
  })

  it('editing the filled-in zone retires the notice', async () => {
    const el = await mountAt('/tasks/settings')
    await toggleDailyReminder(el)
    expect(shown(el, 'tasks-settings-time-zone-autofilled')).toBeTruthy()
    await typeZone(el, 'Asia/Tokyo')
    expect(shown(el, 'tasks-settings-time-zone-autofilled')).toBeNull()
  })

  it('unticking the daily reminder after clearing the filled-in zone leaves the zone empty and nothing to save', async () => {
    const el = await mountAt('/tasks/settings')
    await toggleDailyReminder(el)
    expect(input(el, 'tasks-settings-time-zone').value).toBe(BROWSER_ZONE)
    await typeZone(el, '')
    await toggleDailyReminder(el)
    expect(input(el, 'tasks-settings-daily-reminder').checked).toBe(false)
    expect(input(el, 'tasks-settings-time-zone').value).toBe('')
    expect(shown(el, 'tasks-settings-time-zone-autofilled')).toBeNull()
    expect(saveButton(el).disabled).toBe(true)
  })

  it('daily reminder on with the zone cleared again: the pre-check reports the zone requirement and nothing is sent', async () => {
    const el = await mountAt('/tasks/settings')
    await toggleDailyReminder(el)
    await typeZone(el, '')
    await submit(el)
    expect(text(el, 'tasks-settings-time-zone-error')).toBe('开启每日提醒需要先设置时区')
    expect(input(el, 'tasks-settings-time-zone').getAttribute('aria-invalid')).toBe('true')
    expect(input(el, 'tasks-settings-time-zone').getAttribute('aria-describedby')).toBe('tasks-settings-time-zone-error')
    expect(patchBodies()).toEqual([])
    expect(h_.notifyTasksChanged).not.toHaveBeenCalled()
  })

  it('clearing the zone of a saved daily reminder is caught by the same pre-check', async () => {
    h_.getSettingsReply.mockReturnValue(jsonResponse(200, settings({ dailyReminderEnabled: true, timeZone: 'Asia/Shanghai' })))
    const el = await mountAt('/tasks/settings')
    await typeZone(el, '')
    await submit(el)
    expect(text(el, 'tasks-settings-time-zone-error')).toBe('开启每日提醒需要先设置时区')
    expect(patchBodies()).toEqual([])
  })

  it.each(['Not/AZone', '+08:00', 'UTC+8', '   '])('the pre-check refuses the zone %j next to the zone input and sends nothing', async (zone) => {
    const el = await mountAt('/tasks/settings')
    await typeZone(el, zone)
    await submit(el)
    expect(text(el, 'tasks-settings-time-zone-error')).toBe('无效的时区')
    expect(patchBodies()).toEqual([])
  })

  it('a case variant of a zone passes the pre-check; the answer\'s canonical name replaces it', async () => {
    h_.patchSettingsReply.mockReturnValue(jsonResponse(200, settings({ timeZone: 'Asia/Shanghai' })))
    const el = await mountAt('/tasks/settings')
    await typeZone(el, 'asia/shanghai')
    await submit(el)
    expect(patchBodies()).toEqual(['{"timeZone":"asia/shanghai"}'])
    expect(input(el, 'tasks-settings-time-zone').value).toBe('Asia/Shanghai')
  })

  it('the browser-zone button fills in the browser zone without submitting', async () => {
    const el = await mountAt('/tasks/settings')
    h_.resolveViewerTimeZone.mockReturnValue('America/St_Johns')
    must(el, 'tasks-settings-use-browser-zone').click()
    await flush()
    expect(input(el, 'tasks-settings-time-zone').value).toBe('America/St_Johns')
    expect(must(el, 'tasks-settings-use-browser-zone').getAttribute('data-suggested')).toBe('false')
    expect(shown(el, 'tasks-settings-time-zone-autofilled')).toBeNull()
    expect(patchBodies()).toEqual([])
    expect(saveButton(el).disabled).toBe(false)
  })

  it('with no usable browser zone the button is disabled, ticking the reminder fills nothing, and saving reports the requirement', async () => {
    h_.resolveViewerTimeZone.mockReturnValue('')
    const el = await mountAt('/tasks/settings')
    expect((must(el, 'tasks-settings-use-browser-zone') as HTMLButtonElement).disabled).toBe(true)
    await toggleDailyReminder(el)
    expect(input(el, 'tasks-settings-time-zone').value).toBe('')
    expect(shown(el, 'tasks-settings-time-zone-autofilled')).toBeNull()
    await submit(el)
    expect(text(el, 'tasks-settings-time-zone-error')).toBe('开启每日提醒需要先设置时区')
    expect(patchBodies()).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------
// The server's answers to a save (design §4.0, §4.5)
// ---------------------------------------------------------------------------------------------

const FIELD_ERROR_TESTIDS = [
  'tasks-settings-badge-scope-error',
  'tasks-settings-daily-reminder-error',
  'tasks-settings-remind-policy-error',
  'tasks-settings-time-zone-error',
  'tasks-settings-save-error',
] as const

function shownErrors(el: HTMLElement): string[] {
  return FIELD_ERROR_TESTIDS.filter((testid) => shown(el, testid) !== null)
}

describe('TasksSettingsView — 422 codes render next to their field', () => {
  it.each([
    ['INVALID_SETTINGS', 'tasks-settings-save-error', '设置格式不正确'],
    ['INVALID_BADGE_SCOPE', 'tasks-settings-badge-scope-error', '无效的红点范围'],
    ['INVALID_DAILY_REMINDER_ENABLED', 'tasks-settings-daily-reminder-error', '无效的每日提醒开关'],
    ['INVALID_POLICY', 'tasks-settings-remind-policy-error', '无效的提醒策略'],
    ['INVALID_TIME_ZONE', 'tasks-settings-time-zone-error', '无效的时区'],
    ['DAILY_REMINDER_REQUIRES_TIME_ZONE', 'tasks-settings-time-zone-error', '开启每日提醒需要先设置时区'],
  ] as const)('%s renders at %s with its own copy; the form and the draft stay', async (code, testid, copy) => {
    h_.patchSettingsReply.mockReturnValue(jsonResponse(422, { error: { code } }))
    const el = await mountAt('/tasks/settings')
    await pickBadgeScope(el, 'off')
    await submit(el)
    expect(patchBodies()).toHaveLength(1)
    expect(shownErrors(el)).toEqual([testid])
    expect(text(el, testid)).toBe(copy)
    expect(must(el, testid).getAttribute('role')).toBe('alert')
    expect(shown(el, 'tasks-settings-save-banner')).toBeNull()
    expect(shown(el, 'tasks-settings-saved')).toBeNull()
    expect(input(el, 'tasks-settings-badge-scope-off').checked).toBe(true)
    expect(saveButton(el).disabled).toBe(false)
    expect(h_.notifyTasksChanged).not.toHaveBeenCalled()
  })

  it('an unlisted 422 code renders the fallback copy next to the save button', async () => {
    h_.patchSettingsReply.mockReturnValue(jsonResponse(422, { error: { code: 'SOMETHING_NEW' } }))
    const el = await mountAt('/tasks/settings')
    await pickBadgeScope(el, 'off')
    await submit(el)
    expect(shownErrors(el)).toEqual(['tasks-settings-save-error'])
    expect(text(el, 'tasks-settings-save-error')).toBe('操作失败，请稍后重试')
  })

  it('editing the zone retires its inline error', async () => {
    h_.patchSettingsReply.mockImplementationOnce(() => jsonResponse(422, { error: { code: 'INVALID_TIME_ZONE' } }))
    const el = await mountAt('/tasks/settings')
    await typeZone(el, 'Asia/Tokyo')
    await submit(el)
    expect(shownErrors(el)).toEqual(['tasks-settings-time-zone-error'])
    await typeZone(el, 'Asia/Seoul')
    expect(shownErrors(el)).toEqual([])
  })

  it('an inline error goes away on the next edit', async () => {
    h_.patchSettingsReply.mockReturnValue(jsonResponse(422, { error: { code: 'INVALID_BADGE_SCOPE' } }))
    const el = await mountAt('/tasks/settings')
    await pickBadgeScope(el, 'off')
    await submit(el)
    expect(shownErrors(el)).toEqual(['tasks-settings-badge-scope-error'])
    await pickBadgeScope(el, 'overdue_or_today')
    expect(shownErrors(el)).toEqual([])
  })
})

describe('TasksSettingsView — org guidance and the page banner', () => {
  it('422 ORG_MISSING replaces the form with the org guidance block', async () => {
    h_.patchSettingsReply.mockReturnValue(jsonResponse(422, { error: { code: 'ORG_MISSING' } }))
    const el = await mountAt('/tasks/settings')
    await pickBadgeScope(el, 'off')
    await submit(el)
    expect(text(el, 'tasks-view-org-missing')).toBe('请先选择一个组织后再查看任务')
    expect(shown(el, 'tasks-settings-form')).toBeNull()
    expect(shown(el, 'tasks-settings-save-banner')).toBeNull()
    expect(h_.notifyTasksChanged).not.toHaveBeenCalled()
  })

  it.each([
    ['a 403', () => jsonResponse(403, null), '您没有权限修改任务设置'],
    ['a 404', () => jsonResponse(404, { error: { code: 'NOT_FOUND' } }), '无法保存设置：当前服务不支持'],
    ['a 500', () => jsonResponse(500, null), '保存设置失败，请稍后重试'],
    ['a malformed 200', () => jsonResponse(200, { ...settings(), timeZone: 7 }), '保存设置失败，请稍后重试'],
    ['a 409 (not in this contract)', () => jsonResponse(409, { error: { code: 'VERSION_CONFLICT' } }), '保存设置失败，请稍后重试'],
    ['a transport failure', () => Promise.reject(new TypeError('Failed to fetch')), '保存设置失败，请稍后重试'],
  ] as const)('%s renders the page banner; the form and the draft stay', async (_label, reply, copy) => {
    h_.patchSettingsReply.mockImplementation(reply)
    const el = await mountAt('/tasks/settings')
    await pickBadgeScope(el, 'off')
    await submit(el)
    expect(text(el, 'tasks-settings-save-banner')).toBe(copy)
    expect(must(el, 'tasks-settings-save-banner').getAttribute('role')).toBe('alert')
    expect(shownErrors(el)).toEqual([])
    expect(shown(el, 'tasks-settings-saved')).toBeNull()
    expect(input(el, 'tasks-settings-badge-scope-off').checked).toBe(true)
    expect(saveButton(el).disabled).toBe(false)
    expect(h_.notifyTasksChanged).not.toHaveBeenCalled()
  })

  it("a second save attempt retires the first attempt's banner", async () => {
    h_.patchSettingsReply.mockImplementationOnce(() => jsonResponse(500, null))
    const el = await mountAt('/tasks/settings')
    await pickBadgeScope(el, 'off')
    await submit(el)
    must(el, 'tasks-settings-save-banner')
    await submit(el)
    expect(patchBodies()).toHaveLength(2)
    expect(text(el, 'tasks-settings-saved')).toBe('已保存')
    expect(shown(el, 'tasks-settings-save-banner')).toBeNull()
  })

  it('the banner goes away on the next edit', async () => {
    h_.patchSettingsReply.mockReturnValue(jsonResponse(403, null))
    const el = await mountAt('/tasks/settings')
    await pickBadgeScope(el, 'off')
    await submit(el)
    expect(shown(el, 'tasks-settings-save-banner')).toBeTruthy()
    await choosePolicy(el, 'none')
    expect(shown(el, 'tasks-settings-save-banner')).toBeNull()
  })
})

describe('TasksSettingsView — a successful save', () => {
  it('replaces the form with the answer, shows "saved" and notifies the badge exactly once', async () => {
    h_.patchSettingsReply.mockReturnValue(
      jsonResponse(200, settings({ badgeScope: 'off', dailyReminderEnabled: true, timeZone: 'Asia/Shanghai' })),
    )
    const el = await mountAt('/tasks/settings')
    await pickBadgeScope(el, 'off')
    await toggleDailyReminder(el)
    await typeZone(el, 'asia/shanghai')
    await submit(el)

    expect(patchBodies()).toEqual(['{"badgeScope":"off","dailyReminderEnabled":true,"timeZone":"asia/shanghai"}'])
    expect(input(el, 'tasks-settings-time-zone').value).toBe('Asia/Shanghai')
    expect(input(el, 'tasks-settings-badge-scope-off').checked).toBe(true)
    expect(input(el, 'tasks-settings-daily-reminder').checked).toBe(true)
    expect(text(el, 'tasks-settings-saved')).toBe('已保存')
    expect(must(el, 'tasks-settings-saved').getAttribute('role')).toBe('status')
    expect(h_.notifyTasksChanged).toHaveBeenCalledTimes(1)
    expect(saveButton(el).disabled).toBe(true)
  })

  it('a save right after the zone was filled in retires the filled-in notice', async () => {
    h_.patchSettingsReply.mockReturnValue(jsonResponse(200, settings({ dailyReminderEnabled: true, timeZone: BROWSER_ZONE })))
    const el = await mountAt('/tasks/settings')
    await toggleDailyReminder(el)
    must(el, 'tasks-settings-time-zone-autofilled')
    await submit(el)
    expect(patchBodies()).toEqual([`{"dailyReminderEnabled":true,"timeZone":"${BROWSER_ZONE}"}`])
    expect(text(el, 'tasks-settings-saved')).toBe('已保存')
    expect(shown(el, 'tasks-settings-time-zone-autofilled')).toBeNull()
  })

  it('the next save is measured against the saved answer', async () => {
    const el = await mountAt('/tasks/settings')
    await pickBadgeScope(el, 'off')
    await submit(el)
    await pickBadgeScope(el, 'overdue')
    expect(saveButton(el).disabled).toBe(false)
    await submit(el)
    expect(patchBodies()).toEqual(['{"badgeScope":"off"}', '{"badgeScope":"overdue"}'])
    expect(h_.notifyTasksChanged).toHaveBeenCalledTimes(2)
  })

  it('"saved" goes away on the next edit', async () => {
    const el = await mountAt('/tasks/settings')
    await pickBadgeScope(el, 'off')
    await submit(el)
    expect(shown(el, 'tasks-settings-saved')).toBeTruthy()
    await choosePolicy(el, 'none')
    expect(shown(el, 'tasks-settings-saved')).toBeNull()
  })
})

// ---------------------------------------------------------------------------------------------
// One save at a time (design §4.0)
// ---------------------------------------------------------------------------------------------

describe('TasksSettingsView — one save at a time', () => {
  it('while a save is pending every control is disabled and the form is busy; they come back after the answer', async () => {
    const reply = deferred<Response>()
    h_.patchSettingsReply.mockReturnValue(reply.promise)
    const el = await mountAt('/tasks/settings')
    await pickBadgeScope(el, 'off')
    await submit(el)

    const controls = [
      ...Array.from(el.querySelectorAll('[data-testid^="tasks-settings-badge-scope-"]')).filter((node) => node.tagName === 'INPUT'),
      must(el, 'tasks-settings-daily-reminder'),
      must(el, 'tasks-settings-remind-policy'),
      must(el, 'tasks-settings-time-zone'),
      must(el, 'tasks-settings-use-browser-zone'),
      must(el, 'tasks-settings-save'),
    ] as Array<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>
    expect(controls).toHaveLength(8)
    expect(controls.filter((control) => !control.disabled).map((control) => control.getAttribute('data-testid'))).toEqual([])
    expect(must(el, 'tasks-settings-form').getAttribute('aria-busy')).toBe('true')

    reply.resolve(jsonResponse(200, settings({ badgeScope: 'off' })))
    await flush()
    expect(must(el, 'tasks-settings-form').getAttribute('aria-busy')).toBe('false')
    expect(input(el, 'tasks-settings-time-zone').disabled).toBe(false)
    expect(input(el, 'tasks-settings-daily-reminder').disabled).toBe(false)
  })

  it('a second submit while the first is pending sends nothing', async () => {
    const reply = deferred<Response>()
    h_.patchSettingsReply.mockReturnValue(reply.promise)
    const el = await mountAt('/tasks/settings')
    await pickBadgeScope(el, 'off')
    await submit(el)
    await submit(el)
    await submit(el)
    expect(patchBodies()).toHaveLength(1)

    reply.resolve(jsonResponse(200, settings({ badgeScope: 'off' })))
    await flush()
    expect(h_.notifyTasksChanged).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------------------------
// Results that land after the page was left (design §4.0)
// ---------------------------------------------------------------------------------------------

describe('TasksSettingsView — late results', () => {
  it('positive control: the exposed handle reflects the live page', async () => {
    h_.patchSettingsReply.mockReturnValue(jsonResponse(200, settings({ timeZone: 'Asia/Shanghai' })))
    const el = await mountAt('/tasks/settings')
    const page = settingsPage()
    expect(page.readResult.kind).toBe('ok')
    await typeZone(el, 'asia/shanghai')
    expect(page.draft.timeZone).toBe('asia/shanghai')
    await submit(el)
    expect(page.saved).toBe(true)
    expect(page.draft.timeZone).toBe('Asia/Shanghai')
  })

  it('an ok answer after leaving still notifies the badge once and changes nothing on the left page', async () => {
    const reply = deferred<Response>()
    h_.patchSettingsReply.mockReturnValue(reply.promise)
    const el = await mountAt('/tasks/settings')
    await typeZone(el, 'asia/shanghai')
    await submit(el)
    const page = settingsPage()

    await router!.push('/tasks')
    await flush()
    expect(shown(el, 'other-page')).toBeTruthy()
    expect(shown(el, 'tasks-settings-form')).toBeNull()

    reply.resolve(jsonResponse(200, settings({ timeZone: 'Asia/Shanghai' })))
    await flush()
    expect(h_.notifyTasksChanged).toHaveBeenCalledTimes(1)
    expect(page.saved).toBe(false)
    expect(page.draft.timeZone).toBe('asia/shanghai')
    expect(page.readResult.settings?.timeZone).toBeNull()
  })

  it.each([
    ['422 ORG_MISSING', () => jsonResponse(422, { error: { code: 'ORG_MISSING' } })],
    ['422 INVALID_TIME_ZONE', () => jsonResponse(422, { error: { code: 'INVALID_TIME_ZONE' } })],
    ['a 403', () => jsonResponse(403, null)],
  ] as const)('a failed answer (%s) after leaving changes nothing and notifies nothing', async (_label, answer) => {
    const reply = deferred<Response>()
    h_.patchSettingsReply.mockReturnValue(reply.promise)
    const el = await mountAt('/tasks/settings')
    await pickBadgeScope(el, 'off')
    await submit(el)
    const page = settingsPage()

    await router!.push('/tasks')
    await flush()
    reply.resolve(answer())
    await flush()
    expect(page.orgMissingFromSave).toBe(false)
    expect(page.fieldErrors).toEqual({})
    expect(page.saveBannerKind).toBeNull()
    expect(h_.notifyTasksChanged).not.toHaveBeenCalled()
  })

  it('a settings read that lands after leaving does not fill the left page', async () => {
    const reply = deferred<Response>()
    h_.getSettingsReply.mockReturnValue(reply.promise)
    const el = await mountAt('/tasks/settings')
    const page = settingsPage()
    expect(page.readResult.kind).toBe('loading')

    await router!.push('/tasks')
    await flush()
    reply.resolve(jsonResponse(200, settings({ badgeScope: 'off', timeZone: 'Asia/Shanghai' })))
    await flush()
    expect(page.readResult.kind).toBe('loading')
    expect(page.draft.timeZone).toBe('')
    expect(shown(el, 'other-page')).toBeTruthy()
  })

  it('a context read that lands after leaving reads no settings', async () => {
    const context = deferred<unknown>()
    h_.loadTasksContext.mockReturnValue(context.promise)
    await mountAt('/tasks/settings')
    await router!.push('/tasks')
    await flush()
    context.resolve({ state: 'ready', orgId: 'org1' })
    await flush()
    expect(settingsCalls('GET')).toHaveLength(0)
  })
})
