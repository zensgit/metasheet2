import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref, type App } from 'vue'
import AttendanceView from '../src/views/AttendanceView.vue'
import { apiFetch } from '../src/utils/api'

vi.mock('../src/composables/usePlugins', () => ({
  usePlugins: () => ({
    plugins: ref([{ name: 'plugin-attendance', status: 'active' }]),
    views: ref([]), navItems: ref([]), loading: ref(false), error: ref(null),
    fetchPlugins: vi.fn().mockResolvedValue(undefined),
  }),
}))
vi.mock('../src/utils/api', () => ({ apiFetch: vi.fn() }))

const saved = {
  id: '00000000-0000-4000-8000-000000029821',
  name: 'Synthetic saved rules', scope: 'org', version: 1, isDefault: false,
  config: { source: 'saved-source', rule: { timezone: 'UTC', workStartTime: '08:00', workEndTime: '17:00', workingDays: [1, 2, 3, 4, 5] } },
}
const json = (data: unknown): Response => ({
  ok: true, status: 200, json: async () => ({ ok: true, data }),
} as Response)
const flush = async () => {
  for (let i = 0; i < 6; i += 1) { await Promise.resolve(); await nextTick() }
}

describe('Attendance rule-set current-draft preview', () => {
  let app: App<Element> | null
  let host: HTMLDivElement
  let calls: Array<{ method: string; path: string; body: Record<string, unknown> | null }>
  let originalScroll: typeof HTMLElement.prototype.scrollIntoView

  beforeEach(() => {
    app = null
    host = document.createElement('div')
    document.body.appendChild(host)
    originalScroll = HTMLElement.prototype.scrollIntoView
    HTMLElement.prototype.scrollIntoView = vi.fn()
    window.localStorage.clear()
    window.localStorage.setItem('metasheet_locale', 'en')
    window.history.replaceState({}, '', '/attendance')
    calls = []
    vi.mocked(apiFetch).mockReset()
    vi.mocked(apiFetch).mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.url
      const path = new URL(url, 'http://unit.invalid').pathname
      const method = init?.method || 'GET'
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : null
      calls.push({ method, path, body })
      if (path === '/api/attendance/rule-sets/preview') {
        // Match the actual registered route: a supplied saved ID takes precedence over config.
        const config = body?.ruleSetId ? saved.config : body?.config
        return json({ ruleSetId: body?.ruleSetId || null, config, preview: [], totalEvents: 0, notes: [] })
      }
      if (path === '/api/attendance/rule-sets') return json({ items: [saved], total: 1 })
      if (path === '/api/attendance/rule-templates') return json({ system: [], library: [], versions: [] })
      if (path === '/api/attendance/settings') return json({})
      if (path === '/api/attendance/rules/default') return json({
        id: 'default', name: 'Synthetic default', timezone: 'UTC', workStartTime: '09:00', workEndTime: '18:00',
        workingDays: [1, 2, 3, 4, 5], lateGraceMinutes: 0, earlyGraceMinutes: 0, roundingMinutes: 0,
      })
      return json({ items: [], total: 0 })
    })
  })

  afterEach(() => {
    app?.unmount()
    host.remove()
    HTMLElement.prototype.scrollIntoView = originalScroll
    window.history.replaceState({}, '', '/attendance')
    window.localStorage.clear()
  })

  const button = (root: ParentNode, name: string): HTMLButtonElement => {
    const matches = [...root.querySelectorAll<HTMLButtonElement>('button')].filter(b => b.textContent?.trim() === name)
    expect(matches).toHaveLength(1)
    return matches[0]!
  }
  const type = async (root: ParentNode, selector: string, value: string) => {
    const input = root.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)
    expect(input).toBeTruthy()
    input!.value = value
    input!.dispatchEvent(new Event('input', { bubbles: true }))
    await flush()
  }

  for (const entry of [
    { label: 'new unsaved rule positive control', editing: false, events: false },
    { label: 'existing rule uses edited builder instead of saved ID', editing: true, events: false },
    { label: 'existing rule preserves sample events without saved-ID override', editing: true, events: true },
  ]) {
    it(entry.label, async () => {
      app = createApp(AttendanceView, { mode: 'admin', initialSectionId: 'attendance-admin-rule-sets' })
      app.mount(host)
      await flush()
      const section = host.querySelector<HTMLElement>('#attendance-admin-rule-sets')!
      expect(section).toBeTruthy()
      if (entry.editing) {
        const row = [...section.querySelectorAll('tbody tr')].find(r => r.textContent?.includes(saved.name))
        expect(row).toBeTruthy()
        button(row!, 'Edit').click()
        await flush()
        expect(button(section, 'Update rule set')).toBeTruthy()
      } else expect(button(section, 'Create rule set')).toBeTruthy()
      await type(section, '#attendance-rule-builder-source', 'edited-source')
      const events = [{ eventType: 'check_in', workDate: '2026-10-26', occurredAt: '2026-10-26T10:00' }]
      if (entry.events) await type(section, '#attendance-rule-preview-events', JSON.stringify(events))
      const shownDraft = JSON.parse(section.querySelector('.attendance__preview-config-panels pre')!.textContent || '{}') as Record<string, unknown>
      expect(shownDraft.source).toBe('edited-source')
      button(section, 'Preview rule set').click()
      await flush()
      const posts = calls.filter(c => c.method !== 'GET')
      expect(posts).toEqual([{
        method: 'POST', path: '/api/attendance/rule-sets/preview',
        body: { config: shownDraft, ...(entry.events ? { events } : {}) },
      }])
      const resolved = [...section.querySelectorAll('.attendance__template-version-panel')]
        .find(p => p.querySelector('.attendance__field-label')?.textContent?.trim() === 'Resolved config')
      expect(resolved).toBeTruthy()
      expect(JSON.parse(resolved!.querySelector('pre')!.textContent || '{}')).toEqual(shownDraft)
      expect(section.querySelector<HTMLInputElement>('#attendance-rule-builder-source')?.value).toBe('edited-source')
      if (entry.editing) expect(button(section, 'Update rule set')).toBeTruthy()
    })
  }
})
