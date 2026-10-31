import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, type App } from 'vue'
import UserManagementView from '../src/views/UserManagementView.vue'

const apiFetchMock = vi.fn()
vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({ hasAdminAccess: () => true }),
}))
vi.mock('../src/utils/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

function json(data: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => data } as Response
}
function user(id: string, email = 'calc14-ui@example.test') {
  return { id, name: id, email, role: 'user', is_active: true, is_admin: false,
    last_login_at: null, created_at: '2026-10-30T00:00:00Z' }
}
function access(id: string, email?: string) {
  return { user: user(id, email), roles: [], permissions: [], isAdmin: false }
}
async function flush() {
  for (let i = 0; i < 12; i += 1) { await Promise.resolve(); await nextTick() }
}
let app: App | undefined
let root: HTMLDivElement
beforeEach(() => {
  apiFetchMock.mockReset()
  localStorage.clear()
  sessionStorage.clear()
  window.history.replaceState(null, '', '/admin/users')
  root = document.createElement('div')
  document.body.appendChild(root)
})
afterEach(() => { app?.unmount(); app = undefined; root.remove(); vi.restoreAllMocks() })

async function mount(options: {
  users?: string[]
  error?: { code: string; status: number }
  groupCapabilities?: unknown
  shiftCapabilities?: unknown
  groupOrgId?: string
  shiftOrgId?: string
} = {}) {
  const groupCapabilities = 'groupCapabilities' in options ? options.groupCapabilities : { businessEffectiveDateRequired: true }
  const shiftCapabilities = 'shiftCapabilities' in options ? options.shiftCapabilities : { businessEffectiveDateRequired: true }
  const writes: string[] = []
  apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
    const pathname = new URL(path, window.location.origin).pathname
    if (pathname === '/api/admin/users' && init?.method === 'POST') {
      writes.push(String(init.body))
      return options.error
        ? json({ ok: false, error: { code: options.error.code, message: 'private-server-value', details: ['private-detail'] } }, options.error.status)
        : json({ ok: true, data: access(writes.length === 1 ? '44444444-4444-4444-8444-444444444444' : '44444444-4444-4444-8444-444444444445', JSON.parse(String(init.body)).email) }, 201)
    }
    if (pathname === '/api/admin/users') return json({ ok: true, data: { items: (options.users ?? []).map(id => user(id, id + '@example.test')) } })
    if (pathname === '/api/auth/session-orgs') {
      return json({ success: true, data: { orgs: ['33333333-3333-4333-8333-333333333333', '33333333-3333-4333-8333-333333333334'], currentOrgId: null } })
    }
    if (pathname === '/api/attendance/groups') return json({ ok: true, data: { items: [
      { id: '11111111-1111-4111-8111-111111111111', name: 'Group A', orgId: options.groupOrgId ?? '33333333-3333-4333-8333-333333333333', capabilities: groupCapabilities }, { id: '11111111-1111-4111-8111-111111111112', name: 'Group B', orgId: '33333333-3333-4333-8333-333333333333', capabilities: groupCapabilities },
    ] } })
    if (pathname === '/api/attendance/shifts') return json({ ok: true, data: { items: [
      { id: '22222222-2222-4222-8222-222222222222', name: 'Shift A', orgId: options.shiftOrgId ?? '33333333-3333-4333-8333-333333333333', capabilities: shiftCapabilities, workStartTime: '09:00', workEndTime: '18:00' },
      { id: '22222222-2222-4222-8222-222222222223', name: 'Shift B', orgId: '33333333-3333-4333-8333-333333333333', capabilities: shiftCapabilities, workStartTime: '09:00', workEndTime: '18:00' },
    ] } })
    if (pathname.endsWith('/access')) return json({ ok: true, data: access(pathname.split('/')[4]!) })
    if (pathname.endsWith('/member-admission') || pathname.endsWith('/dingtalk-access')) {
      return json({ ok: false, error: { code: 'UNAVAILABLE' } }, 503)
    }
    if (pathname === '/api/admin/roles' || pathname === '/api/admin/access-presets'
      || pathname === '/api/admin/invites' || pathname.endsWith('/sessions')) {
      return json({ ok: true, data: { items: [] } })
    }
    throw new Error('Unexpected mocked request')
  })
  app = createApp(UserManagementView)
  app.component('RouterLink', defineComponent({
    props: { to: { type: [String, Object], default: undefined } }, setup(_props, { slots }) { return () => h('a', slots.default?.()) },
  }))
  app.mount(root)
  await flush()
  return writes
}
function input(selector: string, value: string) {
  const node = root.querySelector<HTMLInputElement>(selector)
  expect(node, selector).not.toBeNull()
  node!.value = value
  node!.dispatchEvent(new Event('input', { bubbles: true }))
}
async function select(label: string, value: string) {
  const node = root.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)
  expect(node, label).not.toBeNull()
  expect(Array.from(node!.options).some(option => option.value === value)).toBe(true)
  node!.value = value
  node!.dispatchEvent(new Event('change', { bubbles: true }))
  await flush()
}
const dateSelector = '[data-create-user-effective-date]'
const groupLabel = '考勤组（可选）'
const shiftLabel = '默认班次（可选）'
const orgLabel = '所属组织（可选）'
function dateValue() { return root.querySelector<HTMLInputElement>(dateSelector)?.value }
async function submit(email = 'calc14-ui@example.test') {
  input('input[placeholder="姓名"]', 'New employee')
  input('input[placeholder="邮箱（可选）"]', email)
  const button = Array.from(root.querySelectorAll<HTMLButtonElement>('.user-admin__panel--create button'))
    .find(node => node.textContent?.trim() === '创建用户')
  expect(button).toBeTruthy()
  button!.click()
  await flush()
}
const oldMinimal = { name: 'New employee', email: 'calc14-ui@example.test', role: 'user', isActive: true }

// Main approved the exact per-item capability contract and assigned its route implementation
// to Gauss. These are mocked contract assertions, not evidence that live metadata is present.
describe('CALC14 user creation attendance effective date', () => {
  it('keeps the legacy group editor and exact body when source-date posture is unknown', async () => {
    const writes = await mount({ groupCapabilities: undefined, shiftCapabilities: undefined })
    await select(groupLabel, '11111111-1111-4111-8111-111111111111')
    expect(root.querySelector(dateSelector)).toBeNull()
    await submit()
    expect(writes).toEqual([JSON.stringify({
      name: 'New employee', email: 'calc14-ui@example.test',
      attendanceGroupId: '11111111-1111-4111-8111-111111111111', role: 'user', isActive: true,
    })])
  })

  it('keeps the legacy shift-only editor and body without a W7 source-date capability', async () => {
    const writes = await mount({ groupCapabilities: undefined, shiftCapabilities: undefined })
    await select(shiftLabel, '22222222-2222-4222-8222-222222222222')
    input('input[aria-label="默认班次生效日期（可选）"]', '2026-11-01')
    expect(root.querySelector(dateSelector)).toBeNull()
    await submit()
    expect(writes).toEqual([JSON.stringify({
      name: 'New employee', email: 'calc14-ui@example.test',
      defaultShiftId: '22222222-2222-4222-8222-222222222222', defaultShiftStartDate: '2026-11-01',
      role: 'user', isActive: true,
    })])
  })

  it.each([
    ['off', { businessEffectiveDateRequired: false }],
    ['string', { businessEffectiveDateRequired: 'true' }],
    ['number', { businessEffectiveDateRequired: 1 }],
    ['null', null],
    ['array', []],
  ])('keeps legacy group shape for %s capability metadata', async (_name, capabilities) => {
    const writes = await mount({ groupCapabilities: capabilities })
    await select(groupLabel, '11111111-1111-4111-8111-111111111111')
    expect(root.querySelector(dateSelector)).toBeNull()
    await submit()
    expect(writes).toEqual([JSON.stringify({ name: 'New employee', email: 'calc14-ui@example.test', attendanceGroupId: '11111111-1111-4111-8111-111111111111', role: 'user', isActive: true })])
  })

  it.each([
    ['group off', { businessEffectiveDateRequired: false }, { businessEffectiveDateRequired: true }],
    ['shift off', { businessEffectiveDateRequired: true }, { businessEffectiveDateRequired: false }],
    ['shift unknown', { businessEffectiveDateRequired: true }, undefined],
  ])('requires every selected item capability for %s', async (_name, groupCapabilities, shiftCapabilities) => {
    const writes = await mount({ groupCapabilities, shiftCapabilities })
    await select(groupLabel, '11111111-1111-4111-8111-111111111111')
    await select(shiftLabel, '22222222-2222-4222-8222-222222222222')
    input('input[aria-label="默认班次生效日期（可选）"]', '2026-11-01')
    expect(root.querySelector(dateSelector)).toBeNull()
    await submit()
    expect(writes).toEqual([JSON.stringify({
      name: 'New employee', email: 'calc14-ui@example.test', attendanceGroupId: '11111111-1111-4111-8111-111111111111',
      defaultShiftId: '22222222-2222-4222-8222-222222222222', defaultShiftStartDate: '2026-11-01',
      role: 'user', isActive: true,
    })])
  })

  it.each([
    ['missing binding', '', '33333333-3333-4333-8333-333333333333', ''],
    ['different item orgs', '33333333-3333-4333-8333-333333333333', '33333333-3333-4333-8333-333333333334', ''],
    ['explicit org conflict', '33333333-3333-4333-8333-333333333333', '33333333-3333-4333-8333-333333333333', '33333333-3333-4333-8333-333333333334'],
  ])('withholds dated UI and submission for %s', async (_name, groupOrgId, shiftOrgId, explicitOrg) => {
    const writes = await mount({ groupOrgId, shiftOrgId })
    await select(groupLabel, '11111111-1111-4111-8111-111111111111')
    await select(shiftLabel, '22222222-2222-4222-8222-222222222222')
    if (explicitOrg) await select(orgLabel, explicitOrg)
    const state = app!._instance!.setupState as { createAttendanceBusinessEffectiveDate: string }
    state.createAttendanceBusinessEffectiveDate = '2026-12-01'
    expect(root.querySelector(dateSelector)).toBeNull()
    await submit()
    expect(writes).toHaveLength(1)
    expect(JSON.parse(writes[0]!)).not.toHaveProperty('businessEffectiveDate')
  })

  it('clears a stored date when selected capability is lost and does not restore it on re-enable', async () => {
    const writes = await mount()
    await select(groupLabel, '11111111-1111-4111-8111-111111111111')
    input(dateSelector, '2026-12-01')
    const state = app!._instance!.setupState as {
      attendanceGroups: Array<{ businessEffectiveDateRequired: boolean }>
    }
    state.attendanceGroups[0]!.businessEffectiveDateRequired = false
    await flush()
    expect(root.querySelector(dateSelector)).toBeNull()
    state.attendanceGroups[0]!.businessEffectiveDateRequired = true
    await flush()
    expect(dateValue()).toBe('')
    await submit()
    expect(JSON.parse(writes[0]!)).toEqual({ ...oldMinimal, attendanceGroupId: '11111111-1111-4111-8111-111111111111' })
  })

  it.each([
    ['group', '11111111-1111-4111-8111-111111111111', ''],
    ['shift', '', '22222222-2222-4222-8222-222222222222'],
    ['group and shift', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'],
  ])('submits the explicit date for %s without deriving it from other dates', async (_name, groupId, shiftId) => {
    const writes = await mount()
    input('input[aria-label="入职日期（可选）"]', '2026-10-01')
    if (groupId) await select(groupLabel, groupId)
    if (shiftId) await select(shiftLabel, shiftId)
    expect(dateValue()).toBe('')
    if (shiftId) input('input[aria-label="默认班次生效日期（可选）"]', '2026-11-01')
    const field = root.querySelector<HTMLInputElement>(dateSelector)!
    expect(root.querySelector(`label[for="${field.id}"]`)?.textContent).toContain('生效日期')
    expect(document.getElementById(field.getAttribute('aria-describedby')!)?.textContent).toContain('已冻结结果不受影响')
    input(dateSelector, '2026-12-01')
    await submit()
    expect(writes).toHaveLength(1)
    expect(JSON.parse(writes[0]!)).toEqual({
      name: 'New employee', email: 'calc14-ui@example.test', hireDate: '2026-10-01',
      ...(groupId ? { attendanceGroupId: groupId } : {}),
      ...(shiftId ? { defaultShiftId: shiftId, defaultShiftStartDate: '2026-11-01' } : {}),
      role: 'user', isActive: true, businessEffectiveDate: '2026-12-01',
    })
  })

  it('keeps the exact old attendance body when the effective date is blank', async () => {
    const writes = await mount()
    input('input[aria-label="入职日期（可选）"]', '2026-10-01')
    await select(groupLabel, '11111111-1111-4111-8111-111111111111')
    await select(shiftLabel, '22222222-2222-4222-8222-222222222222')
    input('input[aria-label="默认班次生效日期（可选）"]', '2026-11-01')
    await submit()
    expect(writes).toEqual([JSON.stringify({
      name: 'New employee', email: 'calc14-ui@example.test', hireDate: '2026-10-01',
      attendanceGroupId: '11111111-1111-4111-8111-111111111111', defaultShiftId: '22222222-2222-4222-8222-222222222222', defaultShiftStartDate: '2026-11-01',
      role: 'user', isActive: true,
    })])
  })

  it('preserves the exact no-attendance body after removing a dated assignment', async () => {
    const writes = await mount()
    await select(groupLabel, '11111111-1111-4111-8111-111111111111')
    input(dateSelector, '2026-12-01')
    await select(groupLabel, '')
    expect(root.querySelector(dateSelector)).toBeNull()
    await submit()
    expect(writes).toEqual([JSON.stringify(oldMinimal)])
  })

  it('keeps org-only user admission free of an effective date', async () => {
    const writes = await mount()
    await select(groupLabel, '11111111-1111-4111-8111-111111111111')
    input(dateSelector, '2026-12-01')
    await select(groupLabel, '')
    await select(orgLabel, '33333333-3333-4333-8333-333333333333')
    await submit()
    expect(writes).toEqual([JSON.stringify({ name: 'New employee', email: 'calc14-ui@example.test', attendanceOrgId: '33333333-3333-4333-8333-333333333333', role: 'user', isActive: true })])
  })

  it('clears the date on organization, group and default-shift changes', async () => {
    await mount()
    await select(groupLabel, '11111111-1111-4111-8111-111111111111')
    input(dateSelector, '2026-12-01')
    await select(orgLabel, '33333333-3333-4333-8333-333333333333')
    expect(dateValue()).toBe('')
    input(dateSelector, '2026-12-01')
    await select(orgLabel, '')
    expect(dateValue()).toBe('')
    input(dateSelector, '2026-12-01')
    await select(groupLabel, '11111111-1111-4111-8111-111111111112')
    expect(dateValue()).toBe('')
    input(dateSelector, '2026-12-01')
    await select(shiftLabel, '22222222-2222-4222-8222-222222222223')
    expect(dateValue()).toBe('')
    input(dateSelector, '2026-12-01')
    await select(shiftLabel, '22222222-2222-4222-8222-222222222222')
    expect(dateValue()).toBe('')
  })

  it('clears the date when selecting an existing user for editing', async () => {
    await mount({ users: ['55555555-5555-4555-8555-555555555555', '55555555-5555-4555-8555-555555555556'] })
    await select(groupLabel, '11111111-1111-4111-8111-111111111111')
    input(dateSelector, '2026-12-01')
    const edit = Array.from(root.querySelectorAll<HTMLButtonElement>('.user-admin__user-body'))
      .find(node => node.textContent?.includes('55555555-5555-4555-8555-555555555556'))
    expect(edit).toBeTruthy()
    edit!.click()
    await flush()
    expect(dateValue()).toBe('')
  })

  it('resets the date after creation and leaves the next creation blank', async () => {
    const writes = await mount()
    await select(groupLabel, '11111111-1111-4111-8111-111111111111')
    input(dateSelector, '2026-12-01')
    await submit()
    expect(root.querySelector(dateSelector)).toBeNull()
    await select(groupLabel, '11111111-1111-4111-8111-111111111111')
    expect(dateValue()).toBe('')
    await submit('calc14-ui-next@example.test')
    expect(writes).toHaveLength(2)
    expect(JSON.parse(writes[1]!)).toEqual({ ...oldMinimal, email: 'calc14-ui-next@example.test', attendanceGroupId: '11111111-1111-4111-8111-111111111111' })
  })

  it.each([
    ['ATTENDANCE_CALC14_EFFECTIVE_DATE_REQUIRED', 422, '请为本次变更填写生效日期。'],
    ['ATTENDANCE_CALC14_EFFECTIVE_DATE_INVALID', 422, '请填写有效的生效日期。'],
    ['ATTENDANCE_CALC14_HISTORICAL_AUTHORIZATION_REQUIRED', 403, '历史生效日期需单独核验并授权。'],
    ['ATTENDANCE_CALC14_SOURCE_DATE_CONFLICT', 409, '该日期已有不同变更，或早于已有变更。请核对历史后再选择日期。'],
    ['ATTENDANCE_CALC14_SOURCE_HISTORY_INCOMPLETE', 422, '所需历史资料不完整，请联系管理员核验后再操作。'],
    ['ATTENDANCE_CALC14_SOURCE_SCOPE_INVALID', 403, '考勤生效日期未能确认，请核对组织与考勤配置后重试。'],
    ['ATTENDANCE_CALC14_SOURCE_IMMUTABLE', 409, '考勤生效日期未能确认，请核对组织与考勤配置后重试。'],
  ])('shows values-free feedback for %s without resubmitting', async (code, status, expected) => {
    const writes = await mount({ error: { code, status } })
    await select(groupLabel, '11111111-1111-4111-8111-111111111111')
    input(dateSelector, '2026-12-01')
    await submit()
    const banner = root.querySelector('.user-admin__status--error')
    expect(banner?.textContent?.trim()).toBe(expected)
    expect(root.textContent).not.toContain('private-server-value')
    expect(root.textContent).not.toContain('private-detail')
    expect(writes).toHaveLength(1)
    expect(dateValue()).toBe('2026-12-01')
  })
})
