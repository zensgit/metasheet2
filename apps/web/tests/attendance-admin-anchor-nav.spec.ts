import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref, type App } from 'vue'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import AttendanceView from '../src/views/AttendanceView.vue'
import { apiFetch } from '../src/utils/api'

const ADMIN_NAV_COLLAPSE_PREFS_STORAGE_KEY = 'metasheet_attendance_admin_nav_collapsed_groups'
const ADMIN_NAV_RECENTS_STORAGE_KEY = 'metasheet_attendance_admin_nav_recent_sections'
const ADMIN_NAV_LAST_SECTION_STORAGE_KEY = 'metasheet_attendance_admin_nav_last_section'
const ADMIN_NAV_FOCUS_MODE_STORAGE_KEY = 'metasheet_attendance_admin_nav_focused_mode'
const ADMIN_NAV_DEFAULT_STORAGE_SCOPE = 'default'

function scopedAdminNavStorageKey(baseKey: string, scope = ADMIN_NAV_DEFAULT_STORAGE_SCOPE): string {
  return `${baseKey}:${scope}`
}

vi.mock('../src/composables/usePlugins', () => ({
  usePlugins: () => ({
    plugins: ref([
      {
        name: 'plugin-attendance',
        status: 'active',
      },
    ]),
    views: ref([]),
    navItems: ref([]),
    loading: ref(false),
    error: ref(null),
    fetchPlugins: vi.fn().mockResolvedValue(undefined),
  }),
}))

vi.mock('../src/utils/api', () => ({
  apiFetch: vi.fn(),
}))

function jsonResponse(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
    blob: async () => new Blob([JSON.stringify(payload)], { type: 'application/json' }),
  } as unknown as Response
}

async function flushUi(cycles = 6): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function setViewportWidth(width: number): void {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    writable: true,
    value: width,
  })
  window.dispatchEvent(new Event('resize'))
}

describe('Attendance admin anchor navigation', () => {
  let app: App<Element> | null = null
  let container: HTMLDivElement | null = null
  let scrollIntoViewSpy: ReturnType<typeof vi.fn>
  let clipboardWriteTextSpy: ReturnType<typeof vi.fn>
  let originalScrollIntoView: typeof HTMLElement.prototype.scrollIntoView | undefined

  beforeEach(() => {
    vi.clearAllMocks()
    window.localStorage.clear()
    window.localStorage.setItem('metasheet_locale', 'en')
    window.localStorage.setItem('tenantId', 'default')
    window.localStorage.setItem('workspaceId', 'default')
    window.history.replaceState({}, '', '/attendance')
    setViewportWidth(1280)
    vi.mocked(apiFetch).mockResolvedValue(
      jsonResponse(200, {
        ok: true,
        data: {
          items: [],
          summary: null,
        },
      }),
    )
    container = document.createElement('div')
    document.body.appendChild(container)
    scrollIntoViewSpy = vi.fn()
    clipboardWriteTextSpy = vi.fn().mockResolvedValue(undefined)
    originalScrollIntoView = HTMLElement.prototype.scrollIntoView
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoViewSpy,
    })
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: clipboardWriteTextSpy,
      },
    })
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    if (originalScrollIntoView) {
      Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
        configurable: true,
        value: originalScrollIntoView,
      })
    }
    app = null
    container = null
  })

  it('renders grouped top-level admin anchors and excludes nested subsections', async () => {
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi()

    const groupLabels = Array.from(container!.querySelectorAll('.attendance__admin-nav-group-title')).map(
      item => item.textContent?.trim() || '',
    )
    const labels = Array.from(container!.querySelectorAll('.attendance__admin-nav-link')).map(
      item => item.textContent?.trim() || '',
    )

    expect(groupLabels).toEqual(['Workspace', 'Scheduling', 'Organization', 'Policies', 'Annual leave', 'Data & Payroll'])
    // 33 → 34: W4-1 registered the setup-readiness wizard section (attendance-admin-setup).
    // 34 → 35: W5-1 registered the decision-trace section (attendance-admin-decision-trace).
    // 35 → 34: A4 (A-class batch 2, 2026-08-22) deleted the dead "Group members" waystation
    // section and its rail entry outright (redirecting UserManagementView.vue's deep link
    // straight at Attendance groups instead).
    expect(labels).toHaveLength(34)
    expect(labels).toEqual(
      expect.arrayContaining([
        'Setup readiness',
        'Decision trace',
        'Annual leave balance',
        'Annual leave policy',
        'Annual leave operations',
        'Settings',
        'User Access',
        'Notification deliveries',
        'Report digest subscription',
        'Makeup punch policy',
        'Advanced scheduling',
        'Comprehensive hours',
        'Team availability',
        'Import',
        'Import batches',
        'Report fields',
        'Payroll Cycles',
        'Approval Flows',
        'Holidays',
      ]),
    )
    expect(labels).not.toContain('Holiday overrides')
    expect(labels).not.toContain('Template Versions')
    expect(labels).not.toContain('Group members')
    expect(container!.querySelector('.attendance__admin-nav-current')).toBeNull()
    expect(container!.querySelector('#attendance-admin-nav-filter')).toBeNull()
    expect(container!.querySelector('.attendance__admin-nav-actions')).toBeNull()
    expect(container!.querySelector('[data-admin-anchor-recent]')).toBeNull()
  })

  it('renders the four task groups as the first admin context and opens one workspace at a time', async () => {
    const clearSection = vi.fn()
    app = createApp(AttendanceView, {
      mode: 'admin',
      onClearSection: clearSection,
    })
    app.mount(container!)
    await flushUi()

    const homeContext = container!.querySelector<HTMLElement>('[data-admin-home-context="true"]')
    const sectionWorkspace = container!.querySelector<HTMLElement>('[data-admin-section-workspace="true"]')
    const homeHeader = container!.querySelector<HTMLElement>('.attendance__admin-header')
    expect(homeHeader?.textContent).toContain('Admin Console')
    expect(homeHeader?.querySelector('[data-admin-page-search="true"]')).toBeTruthy()
    expect(homeHeader?.querySelector('[data-admin-reload="true"]')).toBeTruthy()
    expect(homeHeader?.querySelector('[data-attendance-admin-guide]')).toBeTruthy()
    expect(homeContext?.querySelector('[data-attendance-admin-guide]')).toBeNull()
    const taskHome = container!.querySelector<HTMLElement>('[data-admin-task-home="true"]')
    expect(homeContext?.style.display).not.toBe('none')
    expect(sectionWorkspace?.style.display).toBe('none')
    expect(taskHome).toBeTruthy()
    expect(taskHome?.textContent).toContain('Attendance management')
    expect(Array.from(taskHome!.querySelectorAll('[data-admin-task-group]')).map(group => group.getAttribute('data-admin-task-group'))).toEqual([
      'daily-operations',
      'people-groups',
      'work-time-policies',
      'reporting-payroll',
    ])
    expect(taskHome?.textContent).toContain('Daily operations')
    expect(taskHome?.textContent).toContain('People and attendance groups')
    expect(taskHome?.textContent).toContain('Work time and policies')
    expect(taskHome?.textContent).toContain('Reporting and payroll')

    const pendingApprovalsLink = taskHome!.querySelector<HTMLAnchorElement>('[data-admin-task-action="pending-attendance-approvals"]')
    expect(pendingApprovalsLink?.getAttribute('href')).toBe('/attendance?tab=overview&section=attendance-overview-requests')
    // Relabeled per GATE-5086 (P2-1/P3-5): this link's destination is scoped to the viewer's own
    // requests by default, never an org-wide review queue — "Pending approvals" over-promised.
    expect(pendingApprovalsLink?.textContent?.trim()).toBe('My requests')
    expect(taskHome!.querySelector<HTMLAnchorElement>('[data-admin-task-action="attendance-anomalies"]')?.getAttribute('href'))
      .toBe('/attendance?tab=overview&section=attendance-overview-anomalies')
    for (const action of ['attendance-groups', 'shifts', 'holidays', 'rule-sets', 'daily-import']) {
      expect(taskHome!.querySelector(`[data-admin-task-action="${action}"]`)).toBeTruthy()
    }
    // Navigability audit fix 5(b): the standalone "Members" task-home shortcut is gone — it
    // duplicated the "Attendance groups" entry right next to it and landed on a section whose
    // only content was "open Attendance groups instead". A-class batch 2 (A4) removed the
    // waystation section and its sidebar nav entry outright, and repointed
    // UserManagementView.vue's post-create-user deep link straight at `attendance-admin-groups`.
    expect(taskHome!.querySelector('[data-admin-task-action="group-members"]')).toBeNull()

    const importButton = taskHome!.querySelector<HTMLButtonElement>('[data-admin-task-action="daily-import"]')
    expect(importButton).toBeTruthy()
    importButton!.click()
    await flushUi(2)

    expect(homeContext?.style.display).toBe('none')
    expect(sectionWorkspace?.style.display).not.toBe('none')
    const currentSectionBar = container!.querySelector<HTMLElement>('[data-admin-current-section="true"]')
    expect(currentSectionBar?.textContent).toContain('Import')
    expect(currentSectionBar?.textContent).not.toContain('Management home')
    expect(container!.querySelector('[data-admin-task-home-return]')).toBeNull()
    expect(clearSection).not.toHaveBeenCalled()
  })

  it('pins the parent navigate wiring for task-home link actions (fix 4, GATE-5086 P2-2)', async () => {
    // GATE-5086's mutation M8 deleted `@navigate="onAdminTaskHomeNavigate"` at
    // AttendanceView.vue's <AttendanceAdminTaskHome> usage and found 272/272 green across 5
    // suites — the three AttendanceAdminTaskHome.spec.ts cases only prove the CHILD emits;
    // nothing proved the PARENT was listening. With that binding gone the click still calls
    // preventDefault() (AttendanceAdminTaskHome.vue's onLinkActionClick) and the emit goes
    // nowhere — a fully inert click, strictly worse than the full-page reload this fix set out
    // to remove. This suite mounts AttendanceView with no router installed (see the
    // `injection "Symbol(router)" not found` warnings throughout this file), so
    // onAdminTaskHomeNavigate's fallback branch (`window.location.assign`) is what's
    // observable here; a real app with a router would take the `router.push` branch instead —
    // both branches are gated on the SAME `@navigate` binding this test pins.
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi()

    // jsdom's `window.location.assign` is non-configurable, so it cannot be `vi.spyOn`'d
    // directly — replace the whole `location` object for this test only, matching the pattern
    // already established in App.spec.ts's "clears local auth state and redirects after sign
    // out" test.
    const originalLocation = window.location
    const assign = vi.fn()
    Object.defineProperty(window, 'location', {
      value: { ...originalLocation, assign },
      writable: true,
      configurable: true,
    })
    try {
      const link = container!.querySelector<HTMLAnchorElement>('[data-admin-task-action="pending-attendance-approvals"]')
      expect(link).toBeTruthy()
      link!.click()
      await flushUi(2)

      expect(assign).toHaveBeenCalledWith('/attendance?tab=overview&section=attendance-overview-requests')
    } finally {
      Object.defineProperty(window, 'location', {
        value: originalLocation,
        writable: true,
        configurable: true,
      })
    }
  })

  it('routes task-home link actions through router.push when a real router is installed (fix 4 production path, GATE-5086 P2-2)', async () => {
    // Companion to the previous test, which mounts AttendanceView with NO router installed at
    // all (same as every other test in this file) and can therefore only observe
    // onAdminTaskHomeNavigate's `window.location.assign` FALLBACK branch. `useRouter()` resolves
    // to a real router anywhere in the app once `app.use(router)` is called — AttendanceView
    // does not need to sit under a `<router-view>` for this — so mounting it as the app root
    // under a real router exercises the branch that actually runs in production:
    // `void router.push(href)`. Mutating ONLY that line (e.g. to `void 0`, leaving the
    // `@navigate` binding itself intact) reds this test while leaving the previous
    // fallback-branch test green; the two are deliberately non-overlapping.
    const router: Router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/attendance', component: { template: '<div />' } },
      ],
    })
    await router.push('/attendance?tab=admin')
    await router.isReady()

    const routedApp = createApp(AttendanceView, { mode: 'admin' })
    routedApp.use(router)
    routedApp.mount(container!)
    await flushUi()

    // This app instance is local to this test (the outer `app`/`afterEach` unmount the shared
    // one, which stays null here) — unmount it ourselves, and in a `finally` so a failed
    // assertion below can't leak a mounted app into the rest of this file's 30+ other tests
    // (the exact "flake attributed to the last active suite" shape documented elsewhere in this
    // repo's institutional memory).
    try {
      const link = container!.querySelector<HTMLAnchorElement>('[data-admin-task-action="pending-attendance-approvals"]')
      expect(link).toBeTruthy()
      link!.click()

      // vue-router's navigation resolves over more microtask ticks than a fixed flushUi() loop
      // reliably covers (documented pitfall from this PR's own earlier router-link investigation)
      // — poll until settled rather than assuming a fixed tick count catches it.
      await vi.waitFor(() => {
        expect(router.currentRoute.value.fullPath).toBe('/attendance?tab=overview&section=attendance-overview-requests')
      })
    } finally {
      routedApp.unmount()
    }
  })

  it('creates an attendance group from the detail pane and selects it for people management', async () => {
    const savedGroups: Array<{
      id: string
      name: string
      code?: string | null
      timezone: string
      ruleSetId?: string | null
      description?: string | null
    }> = []
    const postBodies: unknown[] = []
    vi.mocked(apiFetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.startsWith('/api/attendance/groups?')) {
        return jsonResponse(200, { ok: true, data: { items: savedGroups } })
      }
      if (url === '/api/attendance/groups' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body || '{}'))
        postBodies.push(body)
        const group = {
          id: 'group-new',
          name: body.name,
          code: body.code ?? 'morning-office',
          timezone: body.timezone,
          ruleSetId: body.ruleSetId ?? null,
          description: body.description ?? null,
        }
        savedGroups.splice(0, savedGroups.length, group)
        return jsonResponse(200, { ok: true, data: group })
      }
      if (url === '/api/attendance/groups/group-new/members') {
        return jsonResponse(200, { ok: true, data: { items: [] } })
      }
      return jsonResponse(200, {
        ok: true,
        data: {
          items: [],
          summary: null,
        },
      })
    })

    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi()

    const groupsAnchor = container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-groups"]')
    expect(groupsAnchor).toBeTruthy()
    groupsAnchor!.click()
    await flushUi(2)

    const nameInput = container!.querySelector<HTMLInputElement>('#attendance-group-name')
    expect(nameInput).toBeTruthy()
    nameInput!.value = 'Morning office'
    nameInput!.dispatchEvent(new Event('input', { bubbles: true }))

    const createButton = container!.querySelector<HTMLButtonElement>('[data-attendance-group-basic] .attendance__btn--primary')
    expect(createButton?.textContent).toContain('Create group')
    createButton!.click()
    await flushUi(12)

    expect(postBodies).toEqual([
      expect.objectContaining({
        name: 'Morning office',
      }),
    ])
    expect(container!.querySelector('[data-attendance-group-detail]')?.textContent).toContain('Morning office')
    expect(container!.querySelector('[data-attendance-group-people]')?.textContent).toContain('No group members yet.')
    expect(container!.querySelector('[data-attendance-group-basic] .attendance__btn--primary')?.textContent).toContain('Save group')
    expect(container!.querySelector('[data-attendance-group-delete]')).toBeTruthy()
  })

  it('stages attendance group members before posting unique pending IDs', async () => {
    const existingMemberUserId = '11111111-1111-4111-8111-111111111111'
    const postBodies: unknown[] = []
    const resolveBodies: unknown[] = []
    vi.mocked(apiFetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/attendance-admin/users/batch/resolve') {
        resolveBodies.push(JSON.parse(String(init?.body || '{}')))
        return jsonResponse(200, {
          ok: true,
          data: {
            requested: 1,
            items: [
              {
                id: existingMemberUserId,
                email: 'alice.member@example.com',
                name: 'Alice Member',
                is_active: true,
              },
            ],
            missingUserIds: [],
            inactiveUserIds: [],
          },
        })
      }
      // The picker sites on this page are wired to the attendance-scoped user search; the
      // platform route is kept here so this mock stays honest for either caller.
      if (url.startsWith('/api/admin/users') || url.startsWith('/api/attendance-admin/users/search')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            items: [
              {
                id: 'user-2',
                email: 'user-2@example.com',
                name: 'User Two',
                role: 'employee',
                is_active: true,
                is_admin: false,
                last_login_at: null,
                created_at: '2026-05-28T00:00:00.000Z',
              },
            ],
          },
        })
      }
      if (url.startsWith('/api/attendance/groups?')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            items: [
              {
                id: 'group-a',
                name: 'Operations floor',
                code: 'ops_floor',
                timezone: 'Asia/Shanghai',
                ruleSetId: null,
              },
            ],
          },
        })
      }
      if (url === '/api/attendance/groups/group-a/members' && init?.method === 'POST') {
        postBodies.push(JSON.parse(String(init.body || '{}')))
        return jsonResponse(200, { ok: true, data: { items: [] } })
      }
      if (url === '/api/attendance/groups/group-a/members') {
        return jsonResponse(200, {
          ok: true,
          data: {
            items: [
              { id: 'member-1', groupId: 'group-a', userId: existingMemberUserId, createdAt: '2026-05-27T08:00:00.000Z' },
            ],
            total: 25,
          },
        })
      }
      return jsonResponse(200, {
        ok: true,
        data: {
          items: [],
          summary: null,
        },
      })
    })

    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi(8)

    const groupsAnchor = container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-groups"]')
    expect(groupsAnchor).toBeTruthy()
    groupsAnchor!.click()
    await flushUi(8)

    const people = container!.querySelector<HTMLElement>('[data-attendance-group-people]')
    expect(people).toBeTruthy()
    expect(people!.querySelector('[data-attendance-group-member-count]')?.textContent).toContain('Showing 1 of 25 members')
    expect(resolveBodies.at(-1)).toEqual({ userIds: [existingMemberUserId], orgId: 'default' })
    expect(people!.querySelector('[data-attendance-group-member-label]')?.textContent).toContain('Alice Member')
    expect(people!.querySelector('[data-attendance-group-member-user-id]')?.textContent).toContain(existingMemberUserId)
    expect(people!.querySelector('[data-attendance-group-member-secondary]')?.textContent).toContain('alice.member@example.com')

    const userSelect = people!.querySelector<HTMLSelectElement>('.attendance__user-picker select')
    expect(userSelect).toBeTruthy()
    userSelect!.value = 'user-2'
    userSelect!.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi(2)

    const appendButton = Array.from(people!.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent?.includes('Append selected user'))
    expect(appendButton).toBeTruthy()
    appendButton!.click()
    await flushUi(2)

    expect(people!.querySelector('[data-attendance-group-pending-members]')?.textContent).toContain('user-2')

    const removePending = people!.querySelector<HTMLButtonElement>('[data-attendance-group-pending-remove]')
    expect(removePending).toBeTruthy()
    removePending!.click()
    await flushUi(2)
    expect(people!.querySelector('[data-attendance-group-pending-members]')).toBeNull()

    userSelect!.value = 'user-2'
    userSelect!.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi(2)
    appendButton!.click()
    await flushUi(2)

    userSelect!.value = 'user-2'
    userSelect!.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi(2)
    appendButton!.click()
    await flushUi(2)
    expect(people!.querySelector('[data-attendance-group-member-notice]')?.textContent).toContain('user-2')

    const bulkInput = people!.querySelector<HTMLTextAreaElement>('#attendance-group-member-user-ids')
    expect(bulkInput).toBeTruthy()
    bulkInput!.value = `user-2, user-3\n${existingMemberUserId}`
    bulkInput!.dispatchEvent(new Event('input', { bubbles: true }))

    const addButton = Array.from(people!.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent?.includes('Add members'))
    expect(addButton).toBeTruthy()
    addButton!.click()
    await flushUi(8)

    expect(postBodies).toEqual([
      {
        userIds: ['user-2', 'user-3'],
      },
    ])
  })

  it('keeps same-label attendance group members distinct and removes by user ID', async () => {
    const firstMemberUserId = '22222222-2222-4222-8222-222222222222'
    const secondMemberUserId = '33333333-3333-4333-8333-333333333333'
    const deleteUrls: string[] = []
    vi.mocked(apiFetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/attendance-admin/users/batch/resolve') {
        return jsonResponse(200, {
          ok: true,
          data: {
            requested: 2,
            items: [
              { id: firstMemberUserId, email: 'one@example.com', name: 'Shared Label', is_active: true },
              { id: secondMemberUserId, email: 'two@example.com', name: 'Shared Label', is_active: true },
            ],
            missingUserIds: [],
            inactiveUserIds: [],
          },
        })
      }
      if (url.startsWith('/api/attendance/groups?')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            items: [
              {
                id: 'group-a',
                name: 'Operations floor',
                code: 'ops_floor',
                timezone: 'Asia/Shanghai',
                ruleSetId: null,
              },
            ],
          },
        })
      }
      if (url === `/api/attendance/groups/group-a/members/${secondMemberUserId}` && init?.method === 'DELETE') {
        deleteUrls.push(url)
        return jsonResponse(200, { ok: true, data: { removed: true } })
      }
      if (url === '/api/attendance/groups/group-a/members') {
        return jsonResponse(200, {
          ok: true,
          data: {
            items: [
              { id: 'member-1', groupId: 'group-a', userId: firstMemberUserId, createdAt: '2026-05-27T08:00:00.000Z' },
              { id: 'member-2', groupId: 'group-a', userId: secondMemberUserId, createdAt: '2026-05-27T08:05:00.000Z' },
            ],
            total: 2,
          },
        })
      }
      return jsonResponse(200, {
        ok: true,
        data: {
          items: [],
          summary: null,
        },
      })
    })

    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi(8)

    const groupsAnchor = container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-groups"]')
    expect(groupsAnchor).toBeTruthy()
    groupsAnchor!.click()
    await flushUi(8)

    const rows = Array.from(container!.querySelectorAll<HTMLTableRowElement>('[data-attendance-group-people] tbody tr'))
    expect(rows).toHaveLength(2)
    expect(rows[0]?.textContent).toContain('Shared Label')
    expect(rows[0]?.textContent).toContain(firstMemberUserId)
    expect(rows[1]?.textContent).toContain('Shared Label')
    expect(rows[1]?.textContent).toContain(secondMemberUserId)

    const secondRemove = Array.from(rows[1]!.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent?.includes('Remove'))
    expect(secondRemove).toBeTruthy()
    secondRemove!.click()
    await flushUi(8)

    expect(deleteUrls).toEqual([`/api/attendance/groups/group-a/members/${secondMemberUserId}`])
  })

  it('shows a neutral member label and separate saved user ID when label resolution fails', async () => {
    const memberUserId = '44444444-4444-4444-8444-444444444444'
    vi.mocked(apiFetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/attendance-admin/users/batch/resolve') {
        return jsonResponse(500, {
          ok: false,
          error: {
            message: 'resolver unavailable',
          },
        })
      }
      if (url.startsWith('/api/attendance/groups?')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            items: [
              {
                id: 'group-a',
                name: 'Operations floor',
                code: 'ops_floor',
                timezone: 'Asia/Shanghai',
                ruleSetId: null,
              },
            ],
          },
        })
      }
      if (url === '/api/attendance/groups/group-a/members') {
        return jsonResponse(200, {
          ok: true,
          data: {
            items: [
              { id: 'member-1', groupId: 'group-a', userId: memberUserId, createdAt: '2026-05-27T08:00:00.000Z' },
            ],
            total: 1,
          },
        })
      }
      return jsonResponse(200, {
        ok: true,
        data: {
          items: [],
          summary: null,
        },
      })
    })

    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi(8)

    const groupsAnchor = container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-groups"]')
    expect(groupsAnchor).toBeTruthy()
    groupsAnchor!.click()
    await flushUi(8)

    const people = container!.querySelector<HTMLElement>('[data-attendance-group-people]')
    expect(people).toBeTruthy()
    expect(people!.querySelector('[data-attendance-group-member-label]')?.textContent?.trim()).toBe('Unknown member')
    expect(people!.querySelector('[data-attendance-group-member-user-id]')?.textContent).toContain(memberUserId)
    expect(container!.textContent).not.toContain('resolver unavailable')
  })

  it('sends non-UUID (legacy) member IDs to label resolve and keeps a neutral label with the separate raw ID (no uuid handoffs)', async () => {
    const resolveBodies: unknown[] = []
    vi.mocked(apiFetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/attendance-admin/users/batch/resolve') {
        resolveBodies.push(JSON.parse(String(init?.body || '{}')))
        return jsonResponse(400, {
          ok: false,
          error: {
            message: 'Invalid user IDs',
          },
        })
      }
      if (url.startsWith('/api/attendance/groups?')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            items: [
              {
                id: 'group-a',
                name: 'Operations floor',
                code: 'ops_floor',
                timezone: 'Asia/Shanghai',
                ruleSetId: null,
              },
            ],
          },
        })
      }
      if (url === '/api/attendance/groups/group-a/members') {
        return jsonResponse(200, {
          ok: true,
          data: {
            items: [
              { id: 'member-1', groupId: 'group-a', userId: 'legacy-user-1', createdAt: '2026-05-27T08:00:00.000Z' },
            ],
            total: 1,
          },
        })
      }
      return jsonResponse(200, {
        ok: true,
        data: {
          items: [],
          summary: null,
        },
      })
    })

    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi(8)

    const groupsAnchor = container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-groups"]')
    expect(groupsAnchor).toBeTruthy()
    groupsAnchor!.click()
    await flushUi(8)

    const people = container!.querySelector<HTMLElement>('[data-attendance-group-people]')
    expect(people).toBeTruthy()
    // No uuid handoffs (496e3a082): non-UUID / legacy member IDs are now sent to the label
    // resolver too (the resolver no longer pre-filters to UUIDs).
    expect(resolveBodies).toEqual([{ userIds: ['legacy-user-1'], orgId: 'default' }])
    // Resolver rejection (400) keeps the raw ID separate from the neutral primary label.
    expect(people!.querySelector('[data-attendance-group-member-label]')?.textContent?.trim()).toBe('Unknown member')
    expect(people!.querySelector('[data-attendance-group-member-user-id]')?.textContent).toContain('legacy-user-1')
  })

  describe.each(['member', 'manager'] as const)('W6 %s personnel label residue', (actor) => {
    const actorUserId = '55555555-5555-4555-8555-555555555555'
    const foreignUserId = '99999999-9999-4999-8999-999999999999'
    const rosterEndpoint = actor === 'member' ? 'members' : 'managers'

    async function mountPersonnelRoster(
      resolve: () => Response | Promise<Response>,
      userIds = [actorUserId],
    ): Promise<void> {
      const resolveBodies: unknown[] = []
      const resolveMethods: (string | undefined)[] = []
      const requestedUrls: string[] = []
      vi.mocked(apiFetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString()
        requestedUrls.push(url)
        if (url === '/api/attendance-admin/users/batch/resolve') {
          resolveBodies.push(JSON.parse(String(init?.body || '{}')))
          resolveMethods.push(init?.method)
          return resolve()
        }
        if (url.startsWith('/api/attendance/groups?')) {
          return jsonResponse(200, {
            ok: true,
            data: {
              items: [{
                id: 'group-a',
                name: 'Synthetic group',
                code: 'synthetic_group',
                timezone: 'Asia/Shanghai',
                ruleSetId: null,
              }],
            },
          })
        }
        if (url === `/api/attendance/groups/group-a/${rosterEndpoint}`) {
          return jsonResponse(200, {
            ok: true,
            data: {
              items: userIds.map((userId, index) => ({
                id: `${actor}-${index + 1}`,
                groupId: 'group-a',
                userId,
                role: 'owner',
                createdAt: '2026-05-27T08:00:00.000Z',
              })),
              total: userIds.length,
            },
          })
        }
        return jsonResponse(200, { ok: true, data: { items: [], summary: null } })
      })

      app = createApp(AttendanceView, { mode: 'admin' })
      app.mount(container!)
      await flushUi(8)

      const groupsAnchor = container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-groups"]')
      expect(groupsAnchor).toBeTruthy()
      groupsAnchor!.click()
      await flushUi(8)

      expect(container!.querySelectorAll(`[data-attendance-group-${actor}-identity]`)).toHaveLength(userIds.length)
      expect(resolveBodies).toEqual([{ userIds, orgId: 'default' }])
      expect(resolveMethods).toEqual(['POST'])
      expect(requestedUrls.some(url => url.startsWith('/api/admin/users'))).toBe(false)
    }

    it.each([
      'missing deleted-representative row',
      'missing unseen indeterminate row',
      'resolver 403',
      'resolver 404',
      'resolver 500',
      'rejected network',
      'whitespace name and email',
      'null name and empty email',
      'unexpected extra foreign resolve row',
    ] as const)('renders a neutral primary label with a separate technical ID for %s', async (scenario) => {
      await mountPersonnelRoster(() => {
        if (scenario === 'rejected network') return Promise.reject(new Error('RESOLVER_UNAVAILABLE'))
        if (scenario === 'resolver 403' || scenario === 'resolver 404' || scenario === 'resolver 500') {
          return jsonResponse(Number(scenario.slice(-3)), {
            ok: false,
            error: { code: 'RESOLVER_UNAVAILABLE', message: 'RESOLVER_UNAVAILABLE' },
          })
        }
        // Missing rows have no tombstone evidence. Deleted-representative and unseen
        // fixtures deliberately use the same indeterminate scoped response.
        const items = scenario === 'whitespace name and email'
          ? [{ id: actorUserId, name: '   ', email: '  ', is_active: true }]
          : scenario === 'null name and empty email'
            ? [{ id: actorUserId, name: null, email: '', is_active: true }]
            : scenario === 'unexpected extra foreign resolve row'
              ? [{ id: foreignUserId, name: 'Synthetic foreign label', email: 'foreign@example.invalid', is_active: true }]
              : []
        return jsonResponse(200, {
          ok: true,
          data: {
            requested: 1,
            items,
            missingUserIds: items.some(item => item.id === actorUserId) ? [] : [actorUserId],
            inactiveUserIds: [],
          },
        })
      })

      const identity = container!.querySelector(`[data-attendance-group-${actor}-identity]`)
      const primary = identity!.querySelector(`[data-attendance-group-${actor}-label]`)
      const technicalId = identity!.querySelector(`[data-attendance-group-${actor}-user-id]`)
      expect(primary?.textContent?.trim()).toBe('Unknown member')
      expect(technicalId?.tagName).toBe('SPAN')
      expect(technicalId?.textContent?.trim()).toBe(actorUserId)
      expect(technicalId?.classList.contains('attendance__id-clip')).toBe(false)
      expect(identity!.querySelector(`[data-attendance-group-${actor}-secondary]`)).toBeNull()
      expect(identity!.textContent?.includes('Deleted')).toBe(false)
      expect(container!.textContent?.includes('RESOLVER_UNAVAILABLE')).toBe(false)
      expect(container!.textContent?.includes('Synthetic foreign label')).toBe(false)
      expect(container!.textContent?.includes('foreign@example.invalid')).toBe(false)
      expect(container!.textContent?.includes(foreignUserId)).toBe(false)

      if (actor === 'manager') {
        const role = container!.querySelector<HTMLSelectElement>('[data-attendance-group-manager-role]')
        expect(Array.from(role!.options).map(option => option.value)).toEqual(['owner', 'sub_owner'])
        expect(container!.querySelector<HTMLButtonElement>('[data-attendance-group-manager-remove]')?.disabled).toBe(false)
      }
    })

    it('preserves trimmed names, email fallback, and authorized Inactive secondary labels without inferring deletion', async () => {
      const emailUserId = '66666666-6666-4666-8666-666666666666'
      const inactiveUserId = '77777777-7777-4777-8777-777777777777'
      await mountPersonnelRoster(() => jsonResponse(200, {
        ok: true,
        data: {
          requested: 3,
          items: [
            { id: actorUserId, name: '  Synthetic Name  ', email: 'name@example.invalid', is_active: true },
            { id: emailUserId, name: '  ', email: '  email@example.invalid  ', is_active: true },
            { id: inactiveUserId, name: 'Synthetic Inactive', email: 'inactive@example.invalid', is_active: false },
          ],
          missingUserIds: [],
          inactiveUserIds: [inactiveUserId],
        },
      }), [actorUserId, emailUserId, inactiveUserId])

      const identities = Array.from(container!.querySelectorAll(`[data-attendance-group-${actor}-identity]`))
      expect(identities.map(identity => identity.querySelector(`[data-attendance-group-${actor}-label]`)?.textContent?.trim()))
        .toEqual(['Synthetic Name', 'email@example.invalid', 'Synthetic Inactive'])
      expect(identities.map(identity => identity.querySelector(`[data-attendance-group-${actor}-user-id]`)?.textContent?.trim()))
        .toEqual([actorUserId, emailUserId, inactiveUserId])
      expect(identities.map(identity => identity.querySelector(`[data-attendance-group-${actor}-secondary]`)?.textContent?.trim() ?? null))
        .toEqual(['name@example.invalid', null, 'inactive@example.invalid · Inactive'])
      expect(identities.some(identity => identity.textContent?.includes('Deleted'))).toBe(false)
      expect(identities.some(identity => identity.textContent?.includes('Unknown member'))).toBe(false)
    })
    it('keeps two unresolved people visually distinguishable with identity-bound removal names', async () => {
      const otherId = '88888888-8888-4888-8888-888888888888'
      await mountPersonnelRoster(() => jsonResponse(200, { ok: true, data: { items: [], missingUserIds: [actorUserId, otherId] } }), [actorUserId, otherId])
      const identities = Array.from(container!.querySelectorAll(`[data-attendance-group-${actor}-identity]`))
      expect(identities.map(node => node.querySelector(`[data-attendance-group-${actor}-label]`)?.textContent?.trim())).toEqual(['Unknown member', 'Unknown member'])
      expect(identities.map(node => node.querySelector(`[data-attendance-group-${actor}-user-id]`)?.classList.contains('attendance__id-clip'))).toEqual([false, false])
      expect(identities.map(node => node.querySelector(`[data-attendance-group-${actor}-user-id]`)?.textContent?.trim())).toEqual([actorUserId, otherId])
      expect(identities.map(node => node.closest('tr')?.querySelector('.attendance__table-actions button')?.getAttribute('aria-label'))).toEqual([
        `Remove Unknown member (${actorUserId})`, `Remove Unknown member (${otherId})`,
      ])
    })

  })

  it('keeps unresolved pending chips visually distinguishable without sending a member write', async () => {
    const ids = ['pending-a', 'pending-b']
    const writes: unknown[] = []
    vi.mocked(apiFetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('/api/attendance/groups?')) return jsonResponse(200, { ok: true, data: { items: [{ id: 'group-a', name: 'Synthetic group', code: 'synthetic', timezone: 'UTC', ruleSetId: null }] } })
      if (url.startsWith('/api/attendance-admin/users/search')) return jsonResponse(200, { ok: true, data: { items: ids.map(id => ({ id, name: null, email: '' })), total: 2 } })
      if (url === '/api/attendance/groups/group-a/members' && init?.method === 'POST') writes.push(init.body)
      return jsonResponse(200, { ok: true, data: { items: [], total: 0 } })
    })
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi(8)
    container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-groups"]')!.click()
    await flushUi(8)
    const people = container!.querySelector<HTMLElement>('[data-attendance-group-people]')!
    const select = people.querySelector<HTMLSelectElement>('.attendance__user-picker select')!
    const append = Array.from(people.querySelectorAll<HTMLButtonElement>('button')).find(b => b.textContent?.includes('Append selected user'))!
    for (const id of ids) {
      select.value = id
      select.dispatchEvent(new Event('change', { bubbles: true }))
      await flushUi(2)
      append.click()
      await flushUi(2)
    }
    const chips = Array.from(people.querySelectorAll('[data-attendance-group-pending-member]'))
    expect(chips).toHaveLength(2)
    expect(chips.map(chip => chip.querySelector('span')?.textContent)).toEqual(['Unknown member', 'Unknown member'])
    expect(chips.map(chip => chip.querySelectorAll('span')[1]?.classList.contains('attendance__id-clip'))).toEqual([false, false])
    expect(chips.map(chip => chip.querySelectorAll('span')[1]?.textContent)).toEqual(ids)
    expect(chips.map(chip => chip.querySelector('button')?.getAttribute('aria-label'))).toEqual(['Remove Unknown member (pending-a)', 'Remove Unknown member (pending-b)'])
    chips[0].querySelector<HTMLButtonElement>('button')!.click()
    await flushUi(2)
    expect(Array.from(people.querySelectorAll('[data-attendance-group-pending-member]')).map(chip => chip.querySelectorAll('span')[1]?.textContent)).toEqual(['pending-b'])
    expect(writes).toEqual([])
  })

  it('explains duplicate-only attendance group member input without posting', async () => {
    const postBodies: unknown[] = []
    vi.mocked(apiFetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.startsWith('/api/attendance/groups?')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            items: [
              {
                id: 'group-a',
                name: 'Operations floor',
                code: 'ops_floor',
                timezone: 'Asia/Shanghai',
                ruleSetId: null,
              },
            ],
          },
        })
      }
      if (url === '/api/attendance/groups/group-a/members' && init?.method === 'POST') {
        postBodies.push(JSON.parse(String(init.body || '{}')))
        return jsonResponse(200, { ok: true, data: { items: [] } })
      }
      if (url === '/api/attendance/groups/group-a/members') {
        return jsonResponse(200, {
          ok: true,
          data: {
            items: [
              { id: 'member-1', groupId: 'group-a', userId: 'user-1', createdAt: '2026-05-27T08:00:00.000Z' },
            ],
            total: 1,
          },
        })
      }
      return jsonResponse(200, {
        ok: true,
        data: {
          items: [],
          summary: null,
        },
      })
    })

    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi(8)

    const groupsAnchor = container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-groups"]')
    expect(groupsAnchor).toBeTruthy()
    groupsAnchor!.click()
    await flushUi(4)

    const people = container!.querySelector<HTMLElement>('[data-attendance-group-people]')
    expect(people).toBeTruthy()
    const bulkInput = people!.querySelector<HTMLTextAreaElement>('#attendance-group-member-user-ids')
    expect(bulkInput).toBeTruthy()
    bulkInput!.value = 'user-1'
    bulkInput!.dispatchEvent(new Event('input', { bubbles: true }))
    await flushUi(2)

    const addButton = Array.from(people!.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent?.includes('Add members'))
    expect(addButton).toBeTruthy()
    addButton!.click()
    await flushUi(4)

    expect(postBodies).toEqual([])
    expect(container!.textContent).toContain('All selected or entered users are already in this group or pending.')
    expect(container!.textContent).not.toContain('Enter at least one user ID.')
  })

  it('collapses and expands admin anchor groups', async () => {
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi()

    const policiesHeader = Array.from(container!.querySelectorAll<HTMLButtonElement>('.attendance__admin-nav-group-header'))
      .find(button => button.textContent?.includes('Policies'))
    expect(policiesHeader).toBeTruthy()
    expect(container!.querySelector('[data-admin-anchor="attendance-admin-approval-flows"]')).toBeTruthy()

    policiesHeader!.click()
    await flushUi(2)
    expect(container!.querySelector('[data-admin-anchor="attendance-admin-approval-flows"]')).toBeNull()

    policiesHeader!.click()
    await flushUi(2)
    expect(container!.querySelector('[data-admin-anchor="attendance-admin-approval-flows"]')).toBeTruthy()
  })

  it('persists collapsed groups across remounts', async () => {
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi()

    const policiesHeader = Array.from(container!.querySelectorAll<HTMLButtonElement>('.attendance__admin-nav-group-header'))
      .find(button => button.textContent?.includes('Policies'))
    expect(policiesHeader).toBeTruthy()

    policiesHeader!.click()
    await flushUi(2)
    expect(container!.querySelector('[data-admin-anchor="attendance-admin-approval-flows"]')).toBeNull()
    expect(window.localStorage.getItem(scopedAdminNavStorageKey(ADMIN_NAV_COLLAPSE_PREFS_STORAGE_KEY))).toContain('policies')

    app.unmount()
    container!.innerHTML = ''

    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi()
    expect(container!.querySelector('[data-admin-anchor="attendance-admin-approval-flows"]')).toBeNull()
  })

  it('scrolls the focused right content back to the top region, keeps the rail item visible, and marks it active', async () => {
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi()

    const button = container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-import-batches"]')
    expect(button).toBeTruthy()
    expect(button?.getAttribute('aria-current')).toBeNull()

    button!.click()
    await flushUi(2)

    expect(scrollIntoViewSpy).toHaveBeenCalled()
    const scrolledTargets = scrollIntoViewSpy.mock.instances as HTMLElement[]
    expect(scrolledTargets.some(target => target.id === 'attendance-admin-import-batches')).toBe(false)
    expect(scrolledTargets.some(target => target.dataset.adminContent === 'true')).toBe(true)
    expect(scrolledTargets.some(target => target.dataset.adminAnchor === 'attendance-admin-import-batches')).toBe(true)
    expect(window.location.hash).toBe('#attendance-admin-import-batches')
    expect(button?.getAttribute('aria-current')).toBe('true')
    expect(button?.classList.contains('attendance__admin-nav-link--active')).toBe(true)
    expect(container!.querySelector('[data-admin-shortcut="attendance-admin-import-batches"]')?.textContent).toContain('Data & Payroll · Import batches')

    const importSection = container!.querySelector<HTMLElement>('[data-admin-section="attendance-admin-import"]')
    const importBatchesSection = container!.querySelector<HTMLElement>('[data-admin-section="attendance-admin-import-batches"]')
    expect(importSection?.style.display).toBe('none')
    expect(importBatchesSection?.style.display).not.toBe('none')
    expect(importBatchesSection?.closest('[data-admin-section="attendance-admin-import"]')).toBeNull()
  })

  it('keeps the right pane focused on the active admin section and ignores legacy show-all preferences', async () => {
    window.localStorage.setItem(scopedAdminNavStorageKey(ADMIN_NAV_FOCUS_MODE_STORAGE_KEY), JSON.stringify(false))

    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi()

    const settingsSection = container!.querySelector<HTMLElement>('#attendance-admin-settings')
    const holidaysSection = container!.querySelector<HTMLElement>('#attendance-admin-holidays')
    expect(settingsSection).toBeTruthy()
    expect(holidaysSection).toBeTruthy()
    expect(settingsSection?.style.display).not.toBe('none')
    expect(holidaysSection?.style.display).toBe('none')

    const holidaysAnchor = container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-holidays"]')
    expect(holidaysAnchor).toBeTruthy()
    holidaysAnchor!.click()
    await flushUi(2)

    expect(settingsSection?.style.display).toBe('none')
    expect(holidaysSection?.style.display).not.toBe('none')
    expect(container!.querySelector('[data-admin-focus-toggle="true"]')).toBeNull()
    expect(window.localStorage.getItem(scopedAdminNavStorageKey(ADMIN_NAV_FOCUS_MODE_STORAGE_KEY))).toBe('true')
  })

  it('renders a sticky current-section bar in the right pane', async () => {
    app = createApp(AttendanceView, {
      mode: 'admin',
      initialSectionId: 'attendance-admin-settings',
    })
    app.mount(container!)
    await flushUi()

    const currentSectionBar = container!.querySelector<HTMLElement>('[data-admin-current-section="true"]')
    expect(currentSectionBar).toBeTruthy()
    expect(currentSectionBar?.textContent).toContain('Workspace · Settings')
    expect(currentSectionBar?.textContent).not.toContain('Current section')
    expect(currentSectionBar?.textContent).not.toContain('Management home')
    expect(currentSectionBar?.querySelector('[data-admin-quick-jump="true"]')).toBeNull()
    expect(currentSectionBar?.querySelector('[data-admin-prev-section]')).toBeNull()
    expect(currentSectionBar?.querySelector('[data-admin-next-section]')).toBeNull()
    expect(currentSectionBar?.querySelector('[data-admin-task-home-return]')).toBeNull()
    expect(currentSectionBar?.querySelector('[data-admin-page-search="true"]')).toBeTruthy()
    expect(currentSectionBar?.querySelector('[data-admin-reload="true"]')).toBeTruthy()
    expect(currentSectionBar?.querySelector('[data-attendance-admin-guide]')).toBeTruthy()
    expect(container!.querySelector('.attendance__admin-header')).toBeNull()
    expect(container!.querySelector('[data-admin-reload="true"]')?.previousElementSibling?.getAttribute('data-admin-page-search')).toBe('true')
  })

  it('lets operators move between sections from the rail after the jump bar is removed', async () => {
    app = createApp(AttendanceView, { mode: 'admin', initialSectionId: 'attendance-admin-settings' })
    app.mount(container!)
    await flushUi()

    expect(container!.querySelector('[data-admin-prev-section]')).toBeNull()
    expect(container!.querySelector('[data-admin-next-section]')).toBeNull()
    expect(container!.querySelector('[data-admin-quick-jump]')).toBeNull()

    container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-user-access"]')!.click()
    await flushUi(2)

    expect(window.location.hash).toBe('#attendance-admin-user-access')
    expect(container!.querySelector('[data-admin-current-section="true"]')?.textContent).toContain('Workspace · User Access')

    container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-settings"]')!.click()
    await flushUi(2)

    expect(window.location.hash).toBe('#attendance-admin-settings')
    expect(container!.querySelector('[data-admin-current-section="true"]')?.textContent).toContain('Workspace · Settings')
  })

  it('lets operators open a deep section from the rail after the quick selector is removed', async () => {
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi()

    expect(container!.querySelector('[data-admin-quick-jump="true"]')).toBeNull()
    container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-advanced-scheduling-workbench"]')!.click()
    await flushUi(2)

    expect(window.location.hash).toBe('#attendance-admin-advanced-scheduling-workbench')
    expect(container!.querySelector('[data-admin-current-section="true"]')?.textContent).toContain('Scheduling · Advanced scheduling')
    expect(container!.querySelector('[data-attendance-advanced-scheduling-workbench]')).toBeTruthy()
  })

  it('opens the comprehensive hours preview from the rail', async () => {
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi()

    container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-comprehensive-hours-preview"]')!.click()
    await flushUi(2)

    expect(window.location.hash).toBe('#attendance-admin-comprehensive-hours-preview')
    expect(container!.querySelector('[data-admin-current-section="true"]')?.textContent).toContain('Scheduling · Comprehensive hours')
    expect(container!.querySelector('[data-attendance-comprehensive-hours-preview]')).toBeTruthy()
  })

  it('normalizes legacy show-all storage back to focused mode across remounts', async () => {
    window.localStorage.setItem(scopedAdminNavStorageKey(ADMIN_NAV_FOCUS_MODE_STORAGE_KEY), JSON.stringify(false))

    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi()

    expect(container!.querySelector('[data-admin-focus-toggle="true"]')).toBeNull()
    expect(window.localStorage.getItem(scopedAdminNavStorageKey(ADMIN_NAV_FOCUS_MODE_STORAGE_KEY))).toBe('true')

    app.unmount()
    container!.innerHTML = ''

    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi()

    expect(container!.querySelector('[data-admin-focus-toggle="true"]')).toBeNull()
    expect(container!.querySelector<HTMLElement>('#attendance-admin-settings')?.style.display).not.toBe('none')
    expect(container!.querySelector<HTMLElement>('#attendance-admin-holidays')?.style.display).toBe('none')
  })

  it('restores the live user picker, structured rule builder, and holiday month calendar interactions', async () => {
    vi.mocked(apiFetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.startsWith('/api/attendance/groups?')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            items: [
              {
                id: 'group-a',
                name: 'Operations floor',
                code: 'ops_floor',
                timezone: 'Asia/Shanghai',
                ruleSetId: 'rule-set-1',
              },
            ],
          },
        })
      }
      if (url === '/api/attendance/groups/group-a/members') {
        return jsonResponse(200, {
          ok: true,
          data: {
            items: [
              { id: 'member-1', groupId: 'group-a', userId: 'user-1', createdAt: '2026-05-27T08:00:00.000Z' },
            ],
          },
        })
      }
      if (url.startsWith('/api/attendance/rule-sets?')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            items: [
              { id: 'rule-set-1', name: 'Ops rule', version: 1, scope: 'org', isDefault: true },
            ],
          },
        })
      }
      return jsonResponse(200, {
        ok: true,
        data: {
          items: [],
          summary: null,
        },
      })
    })

    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi()

    async function ensureGroupVisible(label: string): Promise<void> {
      const header = Array.from(container!.querySelectorAll<HTMLButtonElement>('.attendance__admin-nav-group-header'))
        .find(button => button.textContent?.includes(label))
      expect(header).toBeTruthy()
      if (header!.getAttribute('aria-expanded') === 'false') {
        header!.click()
        await flushUi(2)
      }
    }

    const groupsAnchor = container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-groups"]')
    expect(groupsAnchor).toBeTruthy()
    groupsAnchor!.click()
    await flushUi(2)

    expect(container!.querySelector('[data-attendance-group-manager]')).toBeTruthy()
    expect(container!.querySelector('[data-attendance-group-detail]')?.textContent).toContain('Operations floor')
    expect(container!.textContent).toContain('People')
    expect(container!.textContent).toContain('Rule policy')
    expect(container!.textContent).toContain('Work time')
    expect(container!.textContent).toContain('Punch method')
    expect(container!.textContent).toContain('user-1')
    expect(container!.querySelector('#attendance-group-member-user-picker')).toBeTruthy()
    expect(container!.textContent).toContain('Append selected user')

    // A4 (A-class batch 2, 2026-08-22): the "Group members" waystation section and its rail
    // entry are deleted outright — confirm no dangling anchor or section remains.
    expect(container!.querySelector('[data-admin-anchor="attendance-admin-group-members"]')).toBeNull()
    expect(container!.querySelector('[data-attendance-group-members-redirect]')).toBeNull()

    await ensureGroupVisible('Policies')
    const ruleSetsAnchor = container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-rule-sets"]')
    expect(ruleSetsAnchor).toBeTruthy()
    ruleSetsAnchor!.click()
    await flushUi(2)

    const builderSource = container!.querySelector<HTMLInputElement>('#attendance-rule-builder-source')
    const applyBuilderButton = Array.from(container!.querySelectorAll<HTMLButtonElement>('.attendance__admin-actions .attendance__btn'))
      .find(button => button.textContent?.includes('Apply builder to JSON'))
    const configTextarea = container!.querySelector<HTMLTextAreaElement>('#attendance-rule-set-config')
    expect(builderSource).toBeTruthy()
    expect(applyBuilderButton).toBeTruthy()
    expect(configTextarea).toBeTruthy()

    builderSource!.value = 'dingtalk'
    builderSource!.dispatchEvent(new Event('input', { bubbles: true }))
    applyBuilderButton!.click()
    await flushUi(2)

    expect(container!.textContent).toContain('Structured rule builder')
    expect(configTextarea!.value).toContain('"source": "dingtalk"')
    expect(configTextarea!.value).toContain('"workingDays"')

    await ensureGroupVisible('Scheduling')
    const holidaysAnchor = container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-holidays"]')
    expect(holidaysAnchor).toBeTruthy()
    holidaysAnchor!.click()
    await flushUi(2)

    expect(container!.textContent).toContain('Holiday management now follows a month calendar.')
    const holidayDateInput = container!.querySelector<HTMLInputElement>('#attendance-holiday-date')
    const before = holidayDateInput?.value
    const otherDate = Array.from(container!.querySelectorAll<HTMLButtonElement>('.attendance__holiday-cell'))
      .find(button => !button.classList.contains('attendance__holiday-cell--selected') && !button.disabled)
    expect(holidayDateInput).toBeTruthy()
    expect(otherDate).toBeTruthy()
    otherDate!.click()
    await flushUi(2)
    expect(holidayDateInput?.value).not.toBe(before)
  })

  it('restores import field meanings after loading the live template guide', async () => {
    vi.mocked(apiFetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url === '/api/attendance/import/template') {
        return jsonResponse(200, {
          ok: true,
            data: {
              payloadExample: {
                source: 'attendance',
                mode: 'override',
                timezone: 'Asia/Shanghai',
                columns: ['userId', 'workDate', 'firstInAt'],
                requiredFields: ['userId', 'workDate'],
                userId: '<userId>',
              },
              mappingProfiles: [],
            },
          })
      }
      return jsonResponse(200, {
        ok: true,
        data: {
          items: [],
          summary: null,
        },
      })
    })

    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi()

    const importAnchor = container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-import"]')
    expect(importAnchor).toBeTruthy()
    importAnchor!.click()
    await flushUi(2)

    const importSection = container!.querySelector<HTMLElement>('#attendance-admin-import')
    expect(importSection).toBeTruthy()
    const loadTemplateButton = Array.from(importSection!.querySelectorAll<HTMLButtonElement>('.attendance__admin-actions .attendance__btn'))
      .find(button => button.textContent?.includes('Load template'))
    expect(loadTemplateButton).toBeTruthy()
    loadTemplateButton!.click()
    await flushUi(3)

    expect(importSection!.textContent).toContain('Field meanings')
    expect(importSection!.textContent).toContain('Original attendance data source.')
    expect(importSection!.textContent).toContain('Import conflict strategy.')
    expect(importSection!.textContent).toContain('Template columns')
    expect(importSection!.querySelector('.attendance__template-guide')).toBeTruthy()
  })

  it('surfaces recent shortcuts at the top of the admin content instead of inside the left rail', async () => {
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi()

    const payrollTemplates = container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-payroll-templates"]')
    const payrollCycles = container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-payroll-cycles"]')
    expect(payrollTemplates).toBeTruthy()
    expect(payrollCycles).toBeTruthy()

    payrollTemplates!.click()
    await flushUi(2)
    payrollCycles!.click()
    await flushUi(2)

    const labels = Array.from(container!.querySelectorAll('[data-admin-shortcut]')).map(
      item => item.textContent?.trim() || '',
    )
    expect(labels).toEqual(['Data & Payroll · Payroll Cycles', 'Data & Payroll · Payroll Templates'])
    expect(container!.querySelector('[data-admin-anchor-recent]')).toBeNull()
  })

  it('restores the hashed admin anchor on first load', async () => {
    window.localStorage.setItem(ADMIN_NAV_COLLAPSE_PREFS_STORAGE_KEY, JSON.stringify(['policies']))
    window.history.replaceState({}, '', '/attendance#attendance-admin-approval-flows')
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi()

    expect(scrollIntoViewSpy).toHaveBeenCalled()
    const scrolledTargets = scrollIntoViewSpy.mock.instances as HTMLElement[]
    expect(scrolledTargets.some(target => target.id === 'attendance-admin-approval-flows')).toBe(true)
    expect(scrolledTargets.some(target => target.dataset.adminAnchor === 'attendance-admin-approval-flows')).toBe(true)
    const button = container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-approval-flows"]')
    expect(button?.classList.contains('attendance__admin-nav-link--active')).toBe(true)
    expect(button?.getAttribute('aria-current')).toBe('true')
    expect(window.location.hash).toBe('#attendance-admin-approval-flows')
  })

  it('does not render the removed left-rail clutter controls', async () => {
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi()

    expect(container!.querySelector('#attendance-admin-nav-filter')).toBeNull()
    expect(container!.querySelector('.attendance__admin-nav-actions')).toBeNull()
    expect(container!.textContent).not.toContain('Quick find')
    expect(container!.textContent).not.toContain('Expand all')
    expect(container!.textContent).not.toContain('Collapse all')
    expect(container!.textContent).not.toContain('Copy current link')
  })

  it('tracks recent admin sections as operators move across the console', async () => {
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi()

    const importBatches = container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-import-batches"]')
    const approvalFlows = container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-approval-flows"]')
    expect(importBatches).toBeTruthy()
    expect(approvalFlows).toBeTruthy()

    importBatches!.click()
    await flushUi(2)
    approvalFlows!.click()
    await flushUi(2)

    const labels = Array.from(container!.querySelectorAll('[data-admin-shortcut]')).map(
      item => item.textContent?.trim() || '',
    )
    expect(labels).toEqual(['Policies · Approval Flows', 'Data & Payroll · Import batches'])
    expect(window.localStorage.getItem(scopedAdminNavStorageKey(ADMIN_NAV_RECENTS_STORAGE_KEY))).toContain('attendance-admin-approval-flows')
  })

  it('restores recent admin sections across remounts', async () => {
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi()

    const importBatches = container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-import-batches"]')
    const approvalFlows = container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-approval-flows"]')
    importBatches!.click()
    await flushUi(2)
    approvalFlows!.click()
    await flushUi(2)

    app.unmount()
    container!.innerHTML = ''

    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi()

    const labels = Array.from(container!.querySelectorAll('[data-admin-shortcut]')).map(
      item => item.textContent?.trim() || '',
    )
    expect(labels).toEqual(['Policies · Approval Flows', 'Data & Payroll · Import batches'])
  })

  it('clears recent admin sections on demand', async () => {
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi()

    const importBatches = container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-import-batches"]')
    const approvalFlows = container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-approval-flows"]')
    importBatches!.click()
    await flushUi(2)
    approvalFlows!.click()
    await flushUi(2)

    const clearButton = container!.querySelector<HTMLButtonElement>('[data-admin-shortcuts-clear="true"]')
    expect(clearButton).toBeTruthy()
    clearButton!.click()
    await flushUi(2)

    expect(container!.querySelector('[data-admin-shortcut]')).toBeNull()
    expect(window.localStorage.getItem(scopedAdminNavStorageKey(ADMIN_NAV_RECENTS_STORAGE_KEY))).toBe('[]')
    expect(container!.textContent).toContain('Recent admin shortcuts cleared.')
  })

  it('keeps the task home as the first context when only a remembered section exists', async () => {
    window.localStorage.setItem(scopedAdminNavStorageKey(ADMIN_NAV_LAST_SECTION_STORAGE_KEY), 'attendance-admin-approval-flows')
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi()

    const scrolledTargets = scrollIntoViewSpy.mock.instances as HTMLElement[]
    expect(scrolledTargets.some(target => target.id === 'attendance-admin-approval-flows')).toBe(false)
    expect(container!.querySelector<HTMLElement>('[data-admin-home-context="true"]')?.style.display).not.toBe('none')
    expect(container!.querySelector<HTMLElement>('[data-admin-section-workspace="true"]')?.style.display).toBe('none')
    expect(window.location.hash).toBe('')
  })

  it('isolates admin rail persistence by org id', async () => {
    window.localStorage.setItem(scopedAdminNavStorageKey(ADMIN_NAV_LAST_SECTION_STORAGE_KEY, 'org-b'), 'attendance-admin-payroll-cycles')
    window.localStorage.setItem(
      scopedAdminNavStorageKey(ADMIN_NAV_RECENTS_STORAGE_KEY, 'org-b'),
      JSON.stringify(['attendance-admin-payroll-cycles', 'attendance-admin-import-batches']),
    )
    app = createApp(AttendanceView, { mode: 'admin' })
    const vm = app.mount(container!) as any
    await flushUi()
    if (vm?.$?.ctx && 'orgId' in vm.$.ctx) {
      const rawCtxOrgId = vm.$.ctx.orgId
      vm.$.ctx.orgId = 'org-b'
      if (rawCtxOrgId && typeof rawCtxOrgId === 'object' && 'value' in rawCtxOrgId) {
        rawCtxOrgId.value = 'org-b'
      }
    }
    const rawSetupOrgId = vm?.$?.devtoolsRawSetupState?.orgId
    if (rawSetupOrgId && typeof rawSetupOrgId === 'object' && 'value' in rawSetupOrgId) {
      rawSetupOrgId.value = 'org-b'
    }
    vm.orgId = 'org-b'
    await flushUi(3)

    const labels = Array.from(container!.querySelectorAll('[data-admin-shortcut]')).map(
      item => item.textContent?.trim() || '',
    )
    expect(labels).toEqual(['Data & Payroll · Payroll Cycles', 'Data & Payroll · Import batches'])
    const scrolledTargets = scrollIntoViewSpy.mock.instances as HTMLElement[]
    expect(scrolledTargets.some(target => target.id === 'attendance-admin-payroll-cycles')).toBe(false)
    expect(container!.querySelector<HTMLElement>('[data-admin-home-context="true"]')?.style.display).not.toBe('none')
  })

  it('collapses the grouped rail behind a toggle on narrow screens', async () => {
    setViewportWidth(640)
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi()

    const toggle = container!.querySelector<HTMLButtonElement>('.attendance__admin-nav-toggle')
    expect(toggle).toBeTruthy()
    expect(container!.querySelector('.attendance__admin-nav')).toBeNull()

    toggle!.click()
    await flushUi(2)
    expect(container!.querySelector('.attendance__admin-nav')).toBeTruthy()

    const importBatches = container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-import-batches"]')
    expect(importBatches).toBeTruthy()
    importBatches!.click()
    await flushUi(2)
    expect(container!.querySelector('.attendance__admin-nav')).toBeNull()
    expect(window.location.hash).toBe('#attendance-admin-import-batches')
  })

  it('surfaces the active group first in compact mode', async () => {
    setViewportWidth(640)
    window.history.replaceState({}, '', '/attendance#attendance-admin-approval-flows')
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi()

    const toggle = container!.querySelector<HTMLButtonElement>('.attendance__admin-nav-toggle')
    expect(toggle?.textContent).toContain('Policies')

    toggle!.click()
    await flushUi(2)

    const groupLabels = Array.from(container!.querySelectorAll('.attendance__admin-nav-group-title')).map(
      item => item.textContent?.trim() || '',
    )
    expect(groupLabels[0]).toBe('Policies')
    expect(container!.querySelector('[data-admin-anchor="attendance-admin-approval-flows"]')).toBeTruthy()
  })

  it('moves the active group to the top on desktop and collapses non-active groups after section selection', async () => {
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi()

    const shiftsAnchor = container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-shifts"]')
    expect(shiftsAnchor).toBeTruthy()

    shiftsAnchor!.click()
    await flushUi(2)

    const groupLabels = Array.from(container!.querySelectorAll('.attendance__admin-nav-group-title')).map(
      item => item.textContent?.trim() || '',
    )
    expect(groupLabels[0]).toBe('Scheduling')
    expect(container!.querySelector('[data-admin-anchor="attendance-admin-advanced-scheduling-workbench"]')).toBeTruthy()
    expect(container!.querySelector('[data-admin-anchor="attendance-admin-shifts"]')).toBeTruthy()
    expect(container!.querySelector('[data-admin-anchor="attendance-admin-user-access"]')).toBeNull()
    expect(container!.querySelector('[data-admin-shortcut="attendance-admin-shifts"]')?.textContent).toContain('Scheduling · Shifts')
  })

  it('filters the jump block by Chinese label and keeps the active section highlighted', async () => {
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi()

    const search = container!.querySelector<HTMLInputElement>('[data-admin-nav-search]')
    expect(search).toBeTruthy()
    expect(container!.querySelector('[data-admin-page-search-input]')).toBeNull()

    const shifts = container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-shifts"]')
    expect(shifts).toBeTruthy()
    shifts!.click()
    await flushUi(2)
    expect(shifts!.classList.contains('attendance__admin-nav-link--active')).toBe(true)
    expect(container!.querySelector('[data-admin-anchor="attendance-admin-user-access"]')).toBeNull()

    search!.value = '班次'
    search!.dispatchEvent(new Event('input'))
    await flushUi()
    const visible = Array.from(container!.querySelectorAll<HTMLButtonElement>('[data-admin-anchor]'))
    expect(visible.map(item => item.textContent?.trim())).toEqual(['Shifts'])
    expect(visible[0]?.classList.contains('attendance__admin-nav-link--active')).toBe(true)
    expect(container!.querySelector('[data-admin-anchor-group="scheduling"] .attendance__admin-nav-group-header')?.getAttribute('aria-expanded')).toBe('true')

    search!.value = '用户权限'
    search!.dispatchEvent(new Event('input'))
    await flushUi()
    expect(container!.querySelector('[data-admin-anchor="attendance-admin-user-access"]')?.textContent).toContain('User Access')
    expect(container!.querySelector('[data-admin-anchor-group="workspace"] .attendance__admin-nav-group-header')?.getAttribute('aria-expanded')).toBe('true')
    expect(container!.querySelector('[data-admin-anchor="attendance-admin-shifts"]')).toBeNull()

    search!.value = 'zzz-no-such-section'
    search!.dispatchEvent(new Event('input'))
    await flushUi()
    expect(container!.querySelector('[data-admin-anchor]')).toBeNull()
    expect(container!.querySelector('[data-attendance-search-empty]')?.textContent).toContain('No matches')

    search!.value = ''
    search!.dispatchEvent(new Event('input'))
    await flushUi()
    expect(container!.querySelector('[data-attendance-search-empty]')).toBeNull()
    expect(container!.querySelectorAll('[data-admin-anchor="attendance-admin-shifts"]').length).toBe(1)
    expect(container!.querySelector('[data-admin-anchor="attendance-admin-shifts"]')?.classList.contains('attendance__admin-nav-link--active')).toBe(true)
    expect(container!.querySelector('[data-admin-anchor="attendance-admin-user-access"]')).toBeNull()
  })

  it('searches the workbench catalog from the page search scope and jumps to the section', async () => {
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi()

    const toggle = container!.querySelector<HTMLButtonElement>('[data-admin-page-search-toggle]')
    expect(toggle?.textContent).toContain('Search this page')
    expect(container!.querySelector('[data-admin-page-search-input]')).toBeNull()
    expect(container!.querySelector('[data-admin-page-search-scope]')).toBeNull()

    toggle!.click()
    await flushUi()

    const pageScope = container!.querySelector<HTMLButtonElement>('[data-admin-page-search-scope="page"]')
    const workbenchScope = container!.querySelector<HTMLButtonElement>('[data-admin-page-search-scope="workbench"]')
    const input = container!.querySelector<HTMLInputElement>('[data-admin-page-search-input]')
    expect(pageScope?.textContent).toContain('This page')
    expect(pageScope?.getAttribute('aria-pressed')).toBe('true')
    expect(workbenchScope?.textContent).toContain('All workbench')
    expect(workbenchScope?.getAttribute('aria-pressed')).toBe('false')
    expect(input).toBeTruthy()
    expect(container!.querySelectorAll('[data-admin-page-search-input]')).toHaveLength(1)
    expect(container!.querySelector('[data-admin-page-search-results]')).toBeNull()

    input!.value = 'zzz-no-such-page-text'
    input!.dispatchEvent(new Event('input'))
    await flushUi()
    expect(container!.querySelector('[data-admin-page-search-hidden]')).toBeNull()
    expect(container!.querySelector('[data-admin-page-search-status]')?.textContent).toContain('No matches')
    expect(container!.querySelector('[data-admin-page-search-status]')?.hasAttribute('data-attendance-search-empty')).toBe(true)
    expect(container!.querySelector('[data-admin-page-search-results]')).toBeNull()

    workbenchScope!.click()
    await flushUi()
    expect(workbenchScope?.getAttribute('aria-pressed')).toBe('true')
    expect(pageScope?.getAttribute('aria-pressed')).toBe('false')
    expect(container!.querySelector('[data-admin-page-search-hidden]')).toBeNull()
    expect(container!.querySelector('[data-admin-page-search-results] [data-attendance-search-empty]')?.textContent).toContain('No matches')
    expect(container!.querySelector('[data-admin-page-search-status]')?.textContent).toContain('No matches')

    container!.querySelector<HTMLButtonElement>('[data-admin-page-search-clear]')!.click()
    await flushUi()
    expect(container!.querySelector('[data-admin-page-search-results]')).toBeNull()
    expect(container!.querySelector('[data-admin-page-search-status]')).toBeNull()
    expect(container!.querySelector('[data-attendance-search-empty]')).toBeNull()

    input!.value = '排班执行'
    input!.dispatchEvent(new Event('input'))
    await flushUi()
    const schedulingHits = Array.from(container!.querySelectorAll<HTMLButtonElement>('[data-admin-page-search-result]'))
    expect(schedulingHits.map(item => item.textContent?.trim())).toEqual([
      'Scheduling · Advanced scheduling',
      'Scheduling · Comprehensive hours',
      'Scheduling · Rotation Rules',
      'Scheduling · Rotation Assignments',
      'Scheduling · Shifts',
      'Scheduling · Assignments',
      'Scheduling · Scheduler scope mgmt',
      'Scheduling · Holidays',
    ])
    expect(container!.querySelector('[data-admin-page-search-status]')?.textContent).toContain('Workbench matches: 8')
    expect(container!.querySelector('[data-admin-page-search-hidden]')).toBeNull()

    input!.value = '班次'
    input!.dispatchEvent(new Event('input'))
    await flushUi()
    const shiftHits = Array.from(container!.querySelectorAll<HTMLButtonElement>('[data-admin-page-search-result]'))
    expect(shiftHits.map(item => item.getAttribute('data-admin-page-search-result'))).toEqual(['attendance-admin-shifts'])
    expect(shiftHits[0]?.textContent).toContain('Scheduling · Shifts')
    expect(container!.querySelector('[data-admin-nav-search]')?.value ?? '').toBe('')
    expect(container!.querySelector('[data-admin-anchor="attendance-admin-user-access"]')).toBeTruthy()

    shiftHits[0]!.click()
    await flushUi(2)

    expect(window.location.hash).toBe('#attendance-admin-shifts')
    expect(container!.querySelector('[data-admin-current-section="true"]')?.textContent).toContain('Scheduling · Shifts')
    expect(container!.querySelector('[data-admin-anchor="attendance-admin-shifts"]')?.classList.contains('attendance__admin-nav-link--active')).toBe(true)
    expect(container!.querySelectorAll('[data-admin-page-search-input]')).toHaveLength(1)
    expect(container!.querySelector('[data-admin-page-search-scope="workbench"]')?.getAttribute('aria-pressed')).toBe('true')
    expect(container!.querySelector('[data-admin-page-search-hidden]')).toBeNull()
    expect(container!.querySelector('.attendance__admin-header')).toBeNull()
  })
})
