import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, ref, type App } from 'vue'
import { routerKey } from 'vue-router'
import AttendanceView from '../src/views/AttendanceView.vue'
import { useAuth } from '../src/composables/useAuth'
import { readAuthSessionSignature } from '../src/composables/authPrincipal'
import { useLocale } from '../src/composables/useLocale'
import { apiFetch } from '../src/utils/api'
import { emptyAttendanceResponse, flushUi, jsonResponse, recordApiCall } from './helpers/attendanceA1Harness'

// Install this unchanged in apps/web/tests before running. The real host, watcher,
// auth principal and page-session guard are retained; only IO/plugin discovery is mocked.
vi.mock('../src/composables/usePlugins', () => ({
  usePlugins: () => ({
    plugins: ref([{ name: 'plugin-attendance', status: 'active' }]),
    views: ref([]), navItems: ref([]), loading: ref(false), error: ref(null),
    fetchPlugins: vi.fn().mockResolvedValue(undefined),
  }),
}))
vi.mock('../src/utils/api', () => ({ apiFetch: vi.fn(), getApiBase: () => '' }))

type Roster = 'members' | 'managers'
type Group = 'group-a' | 'group-b'
interface Row { id: string; groupId: Group; userId: string; role?: 'owner' }
interface HostState {
  attendanceGroupMemberGroupId: string
  attendanceGroupEditingId: string
  attendanceGroupMembers: Row[]
  attendanceGroupManagers: Row[]
  attendanceGroupMemberTotal: number
  adminForbidden: boolean
  attendanceSessionGuard: { isCurrent: () => boolean }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
function row(group: Group, roster: Roster, visit: number): Row {
  return { id: `${group}-${roster}-${visit}`, groupId: group,
    userId: `${group}-${roster}-user-${visit}`, ...(roster === 'managers' ? { role: 'owner' as const } : {}) }
}
const total = (group: Group, visit: number) => (group === 'group-a' ? 11 : 21) * visit
const payload = (group: Group, roster: Roster, visit: number) => ({
  ok: true, data: { items: [row(group, roster, visit)], total: total(group, visit) },
})
function pendingRead(group: Group, roster: Roster, visit: number) {
  const headers = deferred<Response>()
  const body = deferred<unknown>()
  const json = vi.fn(() => body.promise)
  const reply = (status: number) => headers.resolve({ ...jsonResponse(status, null), json })
  const finish = (status = 200) => {
    reply(status)
    body.resolve(status === 200 ? payload(group, roster, visit) : { ok: false, error: { code: 'FORBIDDEN' } })
  }
  return { group, roster, visit, headers, body, json, reply, finish }
}

for (const roster of ['members', 'managers'] as const) {
  describe(`AttendanceView ${roster}: same-session group roster isolation`, () => {
    let app: App | null = null
    let container: HTMLDivElement
    let pending: ReturnType<typeof pendingRead>[]
    let session: string
    let network: ReturnType<typeof vi.fn>
    let scrollDescriptor: PropertyDescriptor | undefined
    const state = () => app!._instance!.setupState as unknown as HostState
    const snapshot = () => JSON.parse(JSON.stringify({
      selected: state().attendanceGroupMemberGroupId,
      editing: state().attendanceGroupEditingId,
      members: state().attendanceGroupMembers,
      managers: state().attendanceGroupManagers,
      total: state().attendanceGroupMemberTotal,
      forbidden: state().adminForbidden,
    }))
    const dom = () => ({
      members: Array.from(container.querySelectorAll('[data-attendance-group-member-user-id]'), el => el.textContent?.trim()),
      managers: Array.from(container.querySelectorAll('[data-attendance-group-manager-user-id]'), el => el.textContent?.trim()),
      memberCount: container.querySelector('[data-attendance-group-member-count]')?.textContent?.trim() ?? null,
      managerCount: container.querySelector('[data-attendance-group-manager-count]')?.textContent?.trim() ?? null,
    })

    beforeEach(() => {
      pending = []
      localStorage.clear()
      window.history.replaceState({}, '', '/attendance/admin')
      useLocale().setLocale('en')
      const auth = useAuth()
      // Synthetic JWT-shaped fixture only; no server signature/authorization claim.
      auth.setToken(`eyJhbGciOiJub25lIn0.${btoa(JSON.stringify({ sub: 'roster-reviewer', tenantId: 'roster-org', roles: ['admin'] }))}.fixture`)
      auth.primeSession({ user: { id: 'roster-reviewer', tenantId: 'roster-org', roles: ['admin'] } })
      session = readAuthSessionSignature()
      network = vi.fn().mockRejectedValue(new Error('UNEXPECTED_REAL_NETWORK'))
      vi.stubGlobal('fetch', network)
      scrollDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView')
      Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
      const visits = new Map<string, number>()
      vi.mocked(apiFetch).mockReset()
      vi.mocked(apiFetch).mockImplementation(async (input, init) => {
        const call = recordApiCall(input, init)
        const path = call.url.split('?')[0]
        if (path === '/api/attendance/groups') {
          return jsonResponse(200, { ok: true, data: { scope: 'org', total: 2,
            items: ['group-a', 'group-b'].map(id => ({ id, name: id, code: id,
              timezone: 'Asia/Shanghai', ruleSetId: null, attendanceType: 'fixed_shift', memberCount: 0 })),
          } })
        }
        const match = path.match(/^\/api\/attendance\/groups\/(group-a|group-b)\/(members|managers)$/)
        if (match) {
          expect(call.method).toBe('GET')
          const group = match[1] as Group
          const kind = match[2] as Roster
          const visit = (visits.get(path) ?? 0) + 1
          visits.set(path, visit)
          if (kind !== roster) return jsonResponse(200, payload(group, kind, visit))
          const read = pendingRead(group, kind, visit)
          pending.push(read)
          return read.headers.promise
        }
        // Batch label resolution is a read implemented as POST; no roster writes.
        expect(call.method === 'GET' || (call.method === 'POST' && path === '/api/attendance-admin/users/batch/resolve')).toBe(true)
        return emptyAttendanceResponse()
      })
      container = document.createElement('div')
      document.body.appendChild(container)
    })

    afterEach(async () => {
      // Settle abandoned requests even when an assertion fails, before unmounting.
      for (const read of pending) read.finish()
      await flushUi(16)
      app?.unmount()
      app = null
      container.remove()
      useAuth().clearToken()
      localStorage.clear()
      vi.unstubAllGlobals()
      vi.restoreAllMocks()
      if (scrollDescriptor) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', scrollDescriptor)
      else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
      expect(network).not.toHaveBeenCalled()
    })

    async function mount() {
      app = createApp(AttendanceView, { mode: 'admin', initialSectionId: 'attendance-admin-groups' })
      app.provide(routerKey, undefined)
      app.mount(container)
      await flushUi(24)
      expect(pending.map(read => [read.group, read.visit])).toEqual([['group-a', 1]])
      return pending[0]
    }
    async function select(group: Group) {
      const before = pending.length
      const button = Array.from(container.querySelectorAll<HTMLButtonElement>('.attendance__group-list-main'))
        .find(el => el.querySelector('strong')?.textContent?.trim() === group)
      expect(button, `real group selector ${group}`).toBeTruthy()
      button!.click()
      await flushUi(16)
      expect(pending).toHaveLength(before + 1)
      expect(pending[before].group).toBe(group)
      const people = container.querySelector<HTMLButtonElement>('[data-attendance-group-workflow-step="people"]')
      expect(people, 'real people stage').toBeTruthy()
      people!.click()
      await flushUi(2)
      return pending[before]
    }
    async function expectCurrent(read: ReturnType<typeof pendingRead>, status = 200) {
      await flushUi(16)
      const members = roster === 'members' && status === 403 ? [] : [row(read.group, 'members', read.visit)]
      const managers = roster === 'managers' && status === 403 ? [] : [row(read.group, 'managers', read.visit)]
      expect(snapshot()).toEqual({ selected: read.group, editing: read.group, members, managers,
        total: roster === 'members' && status === 403 ? 0 : total(read.group, read.visit), forbidden: status === 403 })
      expect(state().attendanceSessionGuard.isCurrent()).toBe(true)
      expect(readAuthSessionSignature()).toBe(session)
      if (status === 200) {
        expect(dom()).toEqual({ members: members.map(item => item.userId), managers: managers.map(item => item.userId),
          memberCount: `Showing 1 of ${total(read.group, read.visit)} members`, managerCount: '1 owner(s) · 0 sub-owner(s)' })
      }
    }

    it('selection cleared: cancels pending roster loading and ignores its reply', async () => {
      const old = await mount()
      const create = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
        .find(button => button.textContent?.trim() === 'New group')
      expect(create, 'real new group control').toBeTruthy()
      create!.click()
      await flushUi(16)
      const current = state() as HostState & { attendanceGroupMemberLoading: boolean; attendanceGroupManagerLoading: boolean }
      expect(current.attendanceGroupMemberGroupId).toBe('')
      expect(current.attendanceGroupMemberLoading, 'ROSTER_EMPTY_SELECTION_MEMBER_LOADING').toBe(false)
      expect(current.attendanceGroupManagerLoading, 'ROSTER_EMPTY_SELECTION_MANAGER_LOADING').toBe(false)
      const before = snapshot()
      old.finish()
      await flushUi(16)
      expect(snapshot(), 'ROSTER_EMPTY_SELECTION_LATE_REPLY').toEqual(before)
    })

    it('positive control: B completes while A is pending and renders B rows and counts', async () => {
      await mount()
      const current = await select('group-b')
      current.finish()
      await expectCurrent(current)
    })

    const cases = [
      { name: 'late success headers', bodyFirst: false, oldStatus: 200, currentStatus: 200 },
      { name: 'late success JSON body', bodyFirst: true, oldStatus: 200, currentStatus: 200 },
      { name: 'late 403 headers', bodyFirst: false, oldStatus: 403, currentStatus: 200 },
      { name: 'late success cannot clear current 403', bodyFirst: false, oldStatus: 200, currentStatus: 403 },
    ] as const
    for (const sequence of ['A-B', 'A-B-A'] as const) {
      it.each(cases)(`${sequence}: $name preserves the current group`, async ({ bodyFirst, oldStatus, currentStatus }) => {
        const old = await mount()
        if (bodyFirst) {
          old.reply(200)
          await flushUi(16)
          expect(old.json).toHaveBeenCalledTimes(1)
        }
        let current = await select('group-b')
        if (sequence === 'A-B-A') {
          current.finish()
          await expectCurrent(current) // B-first positive control also covers the return-to-A cases.
          current = await select('group-a')
          expect(current.visit).toBe(2)
        }
        current.finish(currentStatus)
        await expectCurrent(current, currentStatus)
        const before = snapshot()
        const beforeDom = dom()
        old.finish(oldStatus)
        await flushUi(16)
        // Soft state + DOM checks show both effects if the inherited bug is reproduced.
        expect.soft(snapshot(), 'late A must not replace current rows/total/adminForbidden').toEqual(before)
        expect.soft(dom(), 'late A must not alter the actual host roster presentation').toEqual(beforeDom)
        expect(state().attendanceSessionGuard.isCurrent()).toBe(true)
        expect(readAuthSessionSignature()).toBe(session)
      })
    }
  })
}
