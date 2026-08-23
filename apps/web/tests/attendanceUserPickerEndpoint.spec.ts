import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref, type App } from 'vue'
import fs from 'node:fs'
import path from 'node:path'
import AttendanceView from '../src/views/AttendanceView.vue'
import { useAuth } from '../src/composables/useAuth'
import { apiFetch } from '../src/utils/api'

/**
 * Every `AttendanceUserPickerField` on an attendance surface searches through the
 * attendance-scoped user-search route, so the control is usable by exactly the audience the
 * surface itself admits.
 *
 * Two independent legs, because either one alone is weak:
 *  - a BEHAVIOURAL leg that mounts the real admin view, serves only the attendance-scoped
 *    route, and requires every picker on the page to render a real <option> from it; and
 *  - a MECHANICAL leg over the sources, so a picker added tomorrow cannot quietly ship
 *    without the endpoint the behavioural leg would have caught only if it were driven.
 */

const ATTENDANCE_USER_SEARCH = '/api/attendance-admin/users/search'
const PLATFORM_USER_ROUTE = '/api/admin/users'

/**
 * The pickers the admin view mounts once an attendance group exists. Pinned so this file walks a
 * known set instead of whatever happens to render; the source sweep in part B covers the rest.
 */
const EXPECTED_MOUNTED_PICKER_IDS = [
  'attendance-scheduler-scope-subject-ref',
  'attendance-scheduler-scope-target-users',
  'attendance-group-member-user-picker',
  'attendance-group-manager-user-picker',
  'attendance-annual-balance-user',
  'attendance-annual-bulk-adjust-user-picker',
  'attendance-rotation-user',
  'attendance-assignment-user-id',
  'attendance-bulk-apply-user-picker',
] as const

/* ───────────────────────────── harness (mirrors the admin specs) ───────────────────────────── */

const pluginHarness = vi.hoisted(() => ({
  initialPlugins: [{ name: 'plugin-attendance', status: 'active' }] as Array<{ name: string; status: string }>,
}))

vi.mock('../src/composables/usePlugins', () => ({
  usePlugins: () => ({
    plugins: ref(pluginHarness.initialPlugins),
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

function emptyAttendanceResponse(): Response {
  return jsonResponse(200, { ok: true, data: { items: [], summary: null } })
}

/**
 * One attendance group, so the group-member and group-owner pickers mount too. Without a group
 * in the list those two sections render no picker and the sweep below would miss them.
 */
function attendanceGroupsResponse(): Response {
  return jsonResponse(200, {
    ok: true,
    data: {
      items: [{
        id: 'group-a',
        name: 'Ops Team',
        code: 'ops-team',
        timezone: 'Asia/Shanghai',
        ruleSetId: null,
        attendanceType: 'fixed_shift',
        description: null,
        memberCount: 0,
      }],
      total: 1,
    },
  })
}

/**
 * Mount the admin view with every picker-bearing section realised. The admin sections render
 * under `v-show`, so all of them are in the DOM after mount; the group pickers additionally need
 * a group in the list, which `attendanceGroupsResponse()` supplies.
 */
async function mountAdminViewWithAllPickers(container: HTMLElement): Promise<App> {
  const app = createApp(AttendanceView, { mode: 'admin' })
  app.mount(container)
  await flushUi(10)
  return app
}

function userSearchResponse(userId: string): Response {
  return jsonResponse(200, {
    ok: true,
    data: {
      items: [{
        id: userId,
        email: `${userId}@uiwalk.local`,
        name: null,
        role: 'user',
        is_active: true,
        is_admin: false,
        last_login_at: null,
        created_at: '',
      }],
      page: 1,
      pageSize: 20,
      total: 1,
    },
  })
}

async function flushUi(cycles = 6): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

/** Every picker instance currently in the DOM, keyed by its own search input's id. */
function pickerFields(container: HTMLElement): Array<{ id: string; field: Element; input: HTMLInputElement }> {
  return Array.from(container.querySelectorAll<HTMLInputElement>('.attendance__user-picker-controls input'))
    .map((input) => ({ id: input.id, field: input.closest('.attendance__field')!, input }))
    .filter((entry) => Boolean(entry.field))
}

/**
 * Drive one picker the way a person does — type, press the search button, wait — and report
 * whether a REAL <option> for `userId` rendered. Returns a boolean rather than asserting so the
 * same driver can serve the assertion and its positive control.
 */
async function pickerRendersRealOption(field: Element, input: HTMLInputElement, userId: string): Promise<boolean> {
  const searchButton = field.querySelector<HTMLButtonElement>('.attendance__user-picker-controls button')
  if (!searchButton) return false
  input.value = userId
  input.dispatchEvent(new Event('input'))
  searchButton.click()
  await flushUi(4)
  const select = field.querySelector<HTMLSelectElement>('select')
  if (!select) return false
  return Array.from(select.options).some((option) => option.value === userId)
}

/* ─────────────────────────────── A. behavioural ─────────────────────────────── */

describe('attendance user pickers — every picker searches through the attendance-scoped route', () => {
  let app: App | null = null
  let container: HTMLElement | null = null

  beforeEach(() => {
    vi.mocked(apiFetch).mockReset()
    localStorage.setItem('tenantId', 'default')
    localStorage.removeItem('user_roles')
    localStorage.removeItem('auth_token')
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    app?.unmount()
    app = null
    container?.remove()
    container = null
    localStorage.removeItem('tenantId')
    localStorage.removeItem('user_roles')
    localStorage.removeItem('auth_token')
  })

  it('renders real results in every picker on the admin page when only the attendance-scoped route answers', async () => {
    const targetUserId = 'attendance-scoped-target'
    vi.mocked(apiFetch).mockImplementation(async (input) => {
      const url = String(input)
      // The platform-admin user route answers nothing here. A picker still wired to it
      // renders zero real options, which the per-picker assertion below reports by id.
      if (url.startsWith(PLATFORM_USER_ROUTE)) {
        return jsonResponse(403, { ok: false, error: { code: 'FORBIDDEN', message: 'Admin access required' } })
      }
      if (url.includes(ATTENDANCE_USER_SEARCH)) return userSearchResponse(targetUserId)
      if (url.startsWith('/api/attendance/groups?') || url === '/api/attendance/groups') {
        return attendanceGroupsResponse()
      }
      return emptyAttendanceResponse()
    })

    app = await mountAdminViewWithAllPickers(container!)

    const pickers = pickerFields(container!)
    // Domain floor, pinned as a SET rather than a count: an empty NodeList would make the loop
    // below vacuously green, and a shrinking one would silently narrow what this test walks.
    expect(pickers.map((picker) => picker.id).sort()).toEqual([...EXPECTED_MOUNTED_PICKER_IDS].sort())

    const withoutResults: string[] = []
    for (const { id, field, input } of pickers) {
      if (!(await pickerRendersRealOption(field, input, targetUserId))) withoutResults.push(id || '(unnamed picker)')
    }
    expect(
      withoutResults,
      'these pickers rendered no real <option> — their search did not go through the attendance-scoped route',
    ).toEqual([])

    const platformCalls = vi.mocked(apiFetch).mock.calls
      .map(([requested]) => String(requested))
      .filter((requested) => requested.startsWith(PLATFORM_USER_ROUTE))
    expect(platformCalls).toEqual([])
    const attendanceCalls = vi.mocked(apiFetch).mock.calls
      .map(([requested]) => String(requested))
      .filter((requested) => requested.startsWith(ATTENDANCE_USER_SEARCH))
    expect(attendanceCalls.length).toBeGreaterThanOrEqual(EXPECTED_MOUNTED_PICKER_IDS.length)
    expect(attendanceCalls.every((requested) => new URLSearchParams(requested.split('?')[1]).get('orgId') === 'default')).toBe(true)
  })

  it('makes the real platform-admin page request global scope explicitly for every mounted picker', async () => {
    localStorage.setItem('auth_token', 'eyJhbGciOiJub25lIn0.eyJyb2xlcyI6WyJhZG1pbiJdfQ.')
    expect(useAuth().getAccessSnapshot().isAdmin).toBe(true)
    const targetUserId = 'platform-global-target'
    vi.mocked(apiFetch).mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes(ATTENDANCE_USER_SEARCH)) return userSearchResponse(targetUserId)
      if (url.startsWith('/api/attendance/groups?') || url === '/api/attendance/groups') {
        return attendanceGroupsResponse()
      }
      return emptyAttendanceResponse()
    })

    app = await mountAdminViewWithAllPickers(container!)
    expect(useAuth().getAccessSnapshot().isAdmin).toBe(true)
    const pickers = pickerFields(container!)
    expect(pickers.map((picker) => picker.id).sort()).toEqual([...EXPECTED_MOUNTED_PICKER_IDS].sort())

    for (const { field, input } of pickers) {
      expect(await pickerRendersRealOption(field, input, targetUserId)).toBe(true)
    }

    const attendanceCalls = vi.mocked(apiFetch).mock.calls
      .map(([requested]) => String(requested))
      .filter((requested) => requested.startsWith(ATTENDANCE_USER_SEARCH))
    expect(attendanceCalls.length).toBeGreaterThanOrEqual(EXPECTED_MOUNTED_PICKER_IDS.length)
    const nonGlobalCalls = attendanceCalls.filter((requested) => {
      const params = new URLSearchParams(requested.split('?')[1])
      return params.get('scope') !== 'global' || params.has('orgId')
    })
    expect(nonGlobalCalls).toEqual([])
  })

  it('POSITIVE CONTROL — the same driver reports no results when the attendance-scoped route answers nothing', async () => {
    // Without this leg, "every picker rendered a real option" could not be distinguished from
    // "the driver always returns true".
    const targetUserId = 'attendance-scoped-target'
    vi.mocked(apiFetch).mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes(ATTENDANCE_USER_SEARCH)) {
        return jsonResponse(403, { ok: false, error: { code: 'FORBIDDEN', message: 'Admin access required' } })
      }
      if (url.startsWith('/api/attendance/groups?') || url === '/api/attendance/groups') {
        return attendanceGroupsResponse()
      }
      return emptyAttendanceResponse()
    })

    app = await mountAdminViewWithAllPickers(container!)

    const pickers = pickerFields(container!)
    expect(pickers.length).toBe(EXPECTED_MOUNTED_PICKER_IDS.length)

    const withResults: string[] = []
    for (const { id, field, input } of pickers) {
      if (await pickerRendersRealOption(field, input, targetUserId)) withResults.push(id || '(unnamed picker)')
    }
    expect(withResults, 'no picker can produce a result when its endpoint returns none').toEqual([])
  })

  it('does not let the real user-access panel fall back globally after a scoped not-found response', async () => {
    const targetUserId = '11111111-1111-4111-8111-111111111111'
    vi.mocked(apiFetch).mockImplementation(async (input) => {
      const url = String(input)
      if (url === `/api/attendance-admin/users/${targetUserId}/access?orgId=default`) {
        return jsonResponse(404, {
          ok: false,
          error: { code: 'USER_TARGET_NOT_FOUND', message: 'User not found in requested scope' },
        })
      }
      if (url.startsWith('/api/permissions/user/')) {
        return jsonResponse(200, { permissions: ['*:*'], isAdmin: true })
      }
      if (url.startsWith('/api/attendance/groups?') || url === '/api/attendance/groups') {
        return attendanceGroupsResponse()
      }
      return emptyAttendanceResponse()
    })

    app = await mountAdminViewWithAllPickers(container!)
    const input = container!.querySelector<HTMLInputElement>('#attendance-provision-user-id')
    expect(input).not.toBeNull()
    input!.value = targetUserId
    input!.dispatchEvent(new Event('input'))
    await nextTick()

    const section = input!.closest('.attendance__admin-section')
    const loadButton = section?.querySelector<HTMLButtonElement>('.attendance__admin-section-header button')
    expect(loadButton).not.toBeNull()
    loadButton!.click()
    await flushUi(6)

    const calls = vi.mocked(apiFetch).mock.calls.map(([requested]) => String(requested))
    expect(calls).toContain(`/api/attendance-admin/users/${targetUserId}/access?orgId=default`)
    expect(calls.some((url) => url.startsWith('/api/permissions/user/'))).toBe(false)
    expect(section?.textContent).toContain('User not found in requested scope')
  })

  it('keeps the real delegated page fail-closed when an old backend returns a bare 404', async () => {
    const targetUserId = '11111111-1111-4111-8111-111111111111'
    vi.mocked(apiFetch).mockImplementation(async (input) => {
      const url = String(input)
      if (url === `/api/attendance-admin/users/${targetUserId}/access?orgId=default`) {
        return jsonResponse(404, { message: 'Not Found' })
      }
      if (url.startsWith('/api/permissions/user/')) {
        return jsonResponse(200, { permissions: ['*:*'], isAdmin: true })
      }
      if (url.startsWith('/api/attendance/groups?') || url === '/api/attendance/groups') {
        return attendanceGroupsResponse()
      }
      return emptyAttendanceResponse()
    })

    app = await mountAdminViewWithAllPickers(container!)
    const input = container!.querySelector<HTMLInputElement>('#attendance-provision-user-id')!
    input.value = targetUserId
    input.dispatchEvent(new Event('input'))
    await nextTick()
    const section = input.closest('.attendance__admin-section')
    section?.querySelector<HTMLButtonElement>('.attendance__admin-section-header button')?.click()
    await flushUi(6)

    const calls = vi.mocked(apiFetch).mock.calls.map(([requested]) => String(requested))
    expect(calls).toContain(`/api/attendance-admin/users/${targetUserId}/access?orgId=default`)
    expect(calls.some((url) => url.startsWith('/api/permissions/user/'))).toBe(false)
  })
})

/* ─────────────────────────────── B. mechanical ─────────────────────────────── */

const WEB_SRC = path.resolve(__dirname, '../src')

/** Every `<AttendanceUserPickerField …>` element in the source tree, with its raw attributes. */
function collectPickerUsages(source: string, file: string): Array<{ file: string; index: number; element: string }> {
  const usages: Array<{ file: string; index: number; element: string }> = []
  const pattern = /<AttendanceUserPickerField(\s[^]*?)?\/>/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(source)) !== null) {
    usages.push({ file, index: usages.length, element: match[0] })
  }
  return usages
}

function listSourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return listSourceFiles(full)
    return entry.isFile() && /\.(vue|ts)$/.test(entry.name) ? [full] : []
  })
}

describe('attendance user pickers — the endpoint is stated at every usage', () => {
  const usages = listSourceFiles(WEB_SRC)
    .flatMap((file) => collectPickerUsages(fs.readFileSync(file, 'utf8'), path.relative(WEB_SRC, file)))
    // The component's own definition file is not a usage of it.
    .filter((usage) => !usage.file.endsWith('AttendanceUserPickerField.vue'))

  it('finds every picker usage in the source tree', () => {
    // Domain floor pinned to the current count: adding a picker is a deliberate act, and this
    // number changing is the signal that the leg below has a new case to cover.
    expect(usages.length).toBe(13)
  })

  it('every usage passes the attendance-scoped user-search endpoint', () => {
    const missing = usages
      .filter((usage) => !usage.element.includes(ATTENDANCE_USER_SEARCH))
      .map((usage) => `${usage.file}#${usage.index}`)
    expect(
      missing,
      `these picker usages do not state ${ATTENDANCE_USER_SEARCH}`,
    ).toEqual([])
  })

  it('every usage passes its current org to the attendance-scoped endpoint', () => {
    const missing = usages
      .filter((usage) => !/:org-id\s*=/.test(usage.element))
      .map((usage) => `${usage.file}#${usage.index}`)
    expect(missing, 'these picker usages could query outside their visible organization').toEqual([])
  })

  it('every usage forwards the platform-admin global-scope decision', () => {
    const missing = usages
      .filter((usage) => !/:global-scope\s*=/.test(usage.element))
      .map((usage) => `${usage.file}#${usage.index}`)
    expect(missing, 'these picker usages cannot opt into explicit global scope for platform admins').toEqual([])
  })

  it('POSITIVE CONTROL — the same collector flags a usage that omits it', () => {
    const decoy = collectPickerUsages(
      `<template>
         <AttendanceUserPickerField v-model="a" :tr="tr" label="x" endpoint="${ATTENDANCE_USER_SEARCH}" />
         <AttendanceUserPickerField v-model="b" :tr="tr" label="y" />
       </template>`,
      'decoy.vue',
    )
    expect(decoy).toHaveLength(2)
    expect(decoy.filter((usage) => !usage.element.includes(ATTENDANCE_USER_SEARCH)).map((usage) => usage.index))
      .toEqual([1])
  })

  it('POSITIVE CONTROL — the org-scope rule flags an endpoint usage without org-id', () => {
    const decoy = collectPickerUsages(
      `<template>
         <AttendanceUserPickerField v-model="a" :tr="tr" label="x" endpoint="${ATTENDANCE_USER_SEARCH}" :org-id="orgId" />
         <AttendanceUserPickerField v-model="b" :tr="tr" label="y" endpoint="${ATTENDANCE_USER_SEARCH}" />
       </template>`,
      'decoy.vue',
    )
    expect(decoy.filter((usage) => !/:org-id\s*=/.test(usage.element)).map((usage) => usage.index)).toEqual([1])
  })
})
