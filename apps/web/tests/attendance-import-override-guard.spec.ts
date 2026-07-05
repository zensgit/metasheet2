// Override import guard (frontend-only, 2026-07-05 design-lock, posture A — forced
// preview-first). See
// docs/development/attendance-override-import-guard-design-lock-20260705.md (PR #3597,
// RATIFIED).
//
// G1: override submits are gated behind (i) a forced-fresh-Preview (submit disabled
// without one; file/mode/key-param edits invalidate it), (ii) an in-DOM two-step confirm
// restating mode + the Preview's rowCount/date-range/distinct-user set + a GENERIC
// irreversible-rollback warning (deliberately never a precise overwrite count — design-lock
// §4 hard boundary), a mandatory checkbox, and a one-click "export backup first" action
// that calls the existing read-only GET /api/attendance/export (zero backend changes).
// G2: merge mode never gates (non-destructive union) and stays one-click.
// G3: the manual (negative) balance-adjustment confirm gets an extra ledger-irreversibility
// line (pure copy).
//
// Mirrors the mount/mock harness used by the sibling
// attendance-import-preview-regression.spec.ts / attendance-import-ops-summary.spec.ts /
// attendance-admin-regressions.spec.ts (annual ops section) specs.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { ref } from 'vue'
import AttendanceView from '../src/views/AttendanceView.vue'
import { apiFetch } from '../src/utils/api'
import {
  buildImportBackupExportQuery,
  buildImportOverrideConfirmLines,
  buildImportOverrideConfirmCheckboxLabel,
  buildImportOverrideWarningText,
  buildManualAdjustDeductionLedgerLine,
  isOverrideSubmitBlocked,
  resolveImportBackupTargetUserId,
  summarizeImportPreviewRange,
} from '../src/views/attendance/importOverrideGuard'

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

function textResponse(status: number, text: string, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: async () => JSON.parse(text),
    text: async () => text,
    blob: async () => new Blob([text], { type: headers['Content-Type'] || 'text/plain' }),
  } as unknown as Response
}

async function flushUi(cycles = 6): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function findButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find(
    candidate => candidate.textContent?.trim() === label
  )
  expect(button, `expected button "${label}"`).toBeTruthy()
  return button as HTMLButtonElement
}

function findImportSection(container: HTMLElement): HTMLElement {
  const heading = Array.from(container.querySelectorAll('h4')).find(
    candidate => candidate.textContent?.trim() === 'Import (DingTalk / Manual)'
  )
  expect(heading, 'expected import section heading').toBeTruthy()
  const section = heading!.closest('.attendance__admin-section')
  expect(section, 'expected import section container').toBeTruthy()
  return section as HTMLElement
}

function setInput(container: HTMLElement, selector: string, value: string): void {
  const input = container.querySelector<HTMLInputElement>(selector)
  expect(input, `expected input ${selector}`).toBeTruthy()
  input!.value = value
  input!.dispatchEvent(new Event('input', { bubbles: true }))
}

function selectOption(container: HTMLElement, selector: string, value: string): void {
  const select = container.querySelector<HTMLSelectElement>(selector)
  expect(select, `expected select ${selector}`).toBeTruthy()
  select!.value = value
  select!.dispatchEvent(new Event('change', { bubbles: true }))
}

/** `orgId` is only rendered in the DOM for `mode: 'overview' | 'reports'` (the filters bar
 *  is `v-if="showOverview || showReports"`) — in `mode: 'admin'` it must be set directly via
 *  the exposed setup state, mirroring attendance-import-ops-summary.spec.ts's helper. */
function assignSetupState(target: Record<string, any>, key: string, next: unknown): void {
  const current = target[key]
  if (current && typeof current === 'object' && 'value' in current) {
    current.value = next
    return
  }
  target[key] = next
}

interface PreviewFixture { items: Array<{ userId: string; workDate: string }>; rowCount: number }

/** Shared route table: prepare (commit token) + preview + commit + export + a generic
 *  fallback for every other background call the mounted view makes (settings, rule sets,
 *  batches, etc.) — same fallback shape used by the sibling import spec files. */
function baseApiFetchRouter(overrides: {
  preview?: PreviewFixture
  commitImported?: number
  commitStatus?: number
  exportText?: string
  exportFilename?: string
} = {}) {
  return async (path: string, init?: RequestInit): Promise<Response> => {
    const url = String(path)
    if (url.startsWith('/api/attendance/import/prepare')) {
      return jsonResponse(200, { ok: true, data: { commitToken: 'token-1', expiresAt: '2099-01-01T00:00:00.000Z' } })
    }
    if (url.startsWith('/api/attendance/import/preview')) {
      const preview = overrides.preview ?? { items: [], rowCount: 0 }
      return jsonResponse(200, {
        ok: true,
        data: { items: preview.items, csvWarnings: [], groupWarnings: [], rowCount: preview.rowCount },
      })
    }
    if (url.startsWith('/api/attendance/import/commit')) {
      if (overrides.commitStatus && overrides.commitStatus >= 400) {
        return jsonResponse(overrides.commitStatus, { ok: false, error: { code: 'IMPORT_COMMIT_FAILED', message: 'boom' } })
      }
      return jsonResponse(200, { ok: true, data: { imported: overrides.commitImported ?? 0, meta: {} } })
    }
    if (url.startsWith('/api/attendance/export')) {
      return textResponse(200, overrides.exportText ?? 'work_date,user_id\n2026-04-04,user-1\n', {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="${overrides.exportFilename ?? 'attendance-override-backup.csv'}"`,
      })
    }
    return jsonResponse(200, { ok: true, data: { items: [], summary: null } })
  }
}

describe('Attendance override-import guard (pure module)', () => {
  const tr = (en: string, _zh: string) => en

  it('importModeRequiresConfirm / isOverrideSubmitBlocked: only override gates, and only without a fresh preview', () => {
    expect(isOverrideSubmitBlocked('override', false)).toBe(true)
    expect(isOverrideSubmitBlocked('override', true)).toBe(false)
    expect(isOverrideSubmitBlocked('merge', false)).toBe(false)
    expect(isOverrideSubmitBlocked('merge', true)).toBe(false)
  })

  it('summarizeImportPreviewRange: derives min/max workDate and a de-duplicated, order-stable user list', () => {
    expect(summarizeImportPreviewRange([])).toEqual({ from: null, to: null, userIds: [] })
    expect(summarizeImportPreviewRange([
      { userId: 'user-2', workDate: '2026-04-06' },
      { userId: 'user-1', workDate: '2026-04-04' },
      { userId: 'user-2', workDate: '2026-04-05' }, // duplicate user, distinct date
    ])).toEqual({ from: '2026-04-04', to: '2026-04-06', userIds: ['user-2', 'user-1'] })
  })

  it('buildImportOverrideConfirmLines: 4 base lines (mode/rowCount/date-range/user-count) + a sample-truncated line ONLY when flagged — never an overwrite-count line', () => {
    const truncatedLines = buildImportOverrideConfirmLines(
      {
        rowCount: 5,
        range: { from: '2026-04-04', to: '2026-04-06', userIds: ['a', 'b'] },
        sampleTruncated: { shown: 2, total: 5 },
      },
      tr,
    )
    expect(truncatedLines).toHaveLength(5)
    expect(truncatedLines[4].label).toBe('Sample truncated')
    expect(truncatedLines[4].value).toContain('2/5 rows loaded')
    // the truncated line talks about the SAMPLE, never about overwritten/existing rows
    expect(truncatedLines[4].value).not.toMatch(/overwrit|existing/i)

    const lines = buildImportOverrideConfirmLines(
      { rowCount: 5, range: { from: '2026-04-04', to: '2026-04-06', userIds: ['a', 'b'] } },
      tr,
    )
    expect(lines).toHaveLength(4)
    expect(lines.map(l => l.label)).toEqual([
      'Mode',
      'Parsed rows (preview)',
      'Date range (preview)',
      'Distinct users (preview)',
    ])
    expect(lines.find(l => l.label === 'Parsed rows (preview)')?.value).toBe('5')
    expect(lines.find(l => l.label === 'Date range (preview)')?.value).toBe('2026-04-04 ~ 2026-04-06')
    expect(lines.find(l => l.label === 'Distinct users (preview)')?.value).toBe('2')
  })

  it('buildImportOverrideConfirmLines: falls back to an honest "unknown" date range when no preview rows are loaded', () => {
    const lines = buildImportOverrideConfirmLines({ rowCount: 0, range: { from: null, to: null, userIds: [] } }, tr)
    expect(lines.find(l => l.label === 'Date range (preview)')?.value).toBe('unknown (no preview rows loaded)')
  })

  it('the warning + checkbox copy is generic and never contains a digit (no precise overwrite count)', () => {
    const warning = buildImportOverrideWarningText(tr)
    const checkboxLabel = buildImportOverrideConfirmCheckboxLabel(tr)
    expect(warning).toBe('Overwritten rows cannot be restored via rollback.')
    expect(checkboxLabel).toContain('cannot be restored via rollback')
    expect(warning).not.toMatch(/\d/)
    expect(checkboxLabel).not.toMatch(/\d/)
  })

  it('G3: the manual-adjustment ledger line is pure copy about reverse adjustment, not a new behavior', () => {
    const line = buildManualAdjustDeductionLedgerLine(tr)
    expect(line.value).toContain('reverse adjustment')
    expect(line.value).toContain('cannot be undone directly')
  })

  it('resolveImportBackupTargetUserId: form userId wins; single-sample auto-resolve only when NOT truncated (review P3-1)', () => {
    expect(resolveImportBackupTargetUserId('', ['only-user'], true)).toBe(null) // truncated sample: never auto-resolve
    expect(resolveImportBackupTargetUserId(' explicit ', ['a', 'b'], true)).toBe('explicit') // explicit form intent still wins

    expect(resolveImportBackupTargetUserId('user-1', [])).toBe('user-1')
    expect(resolveImportBackupTargetUserId('  ', ['solo-user'])).toBe('solo-user')
    expect(resolveImportBackupTargetUserId('', ['user-a', 'user-b'])).toBeNull()
    expect(resolveImportBackupTargetUserId('', [])).toBeNull()
  })

  it('buildImportBackupExportQuery: exact wire shape, omitting unset fields', () => {
    expect(buildImportBackupExportQuery({
      orgId: 'org-1',
      targetUserId: 'user-1',
      range: { from: '2026-04-04', to: '2026-04-05', userIds: [] },
    })).toEqual({ format: 'csv', orgId: 'org-1', userId: 'user-1', from: '2026-04-04', to: '2026-04-05' })

    expect(buildImportBackupExportQuery({
      orgId: '',
      targetUserId: 'user-1',
      range: { from: null, to: null, userIds: [] },
    })).toEqual({ format: 'csv', userId: 'user-1' })
  })
})

describe('Attendance override-import guard (wired UI)', () => {
  let app: App<Element> | null = null
  let container: HTMLDivElement | null = null
  let originalScrollIntoView: typeof HTMLElement.prototype.scrollIntoView | undefined

  beforeEach(() => {
    vi.clearAllMocks()
    window.localStorage.setItem('metasheet_locale', 'en')
    vi.mocked(apiFetch).mockImplementation(baseApiFetchRouter())
    container = document.createElement('div')
    document.body.appendChild(container)
    originalScrollIntoView = HTMLElement.prototype.scrollIntoView
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
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

  it('override: Import stays disabled until a fresh Preview completes, then enables', async () => {
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi(8)

    const importSection = findImportSection(container!)
    const importBtn = importSection.querySelector<HTMLButtonElement>('[data-import-run]')!
    expect(importBtn.disabled).toBe(true)
    expect(importSection.textContent).toContain('override mode requires a fresh Preview')

    vi.mocked(apiFetch).mockImplementation(baseApiFetchRouter({
      preview: { items: [{ userId: 'user-1', workDate: '2026-04-04' }], rowCount: 1 },
    }))
    findButton(importSection, 'Preview').click()
    await flushUi(6)

    expect(importBtn.disabled).toBe(false)
    expect(importSection.textContent).not.toContain('override mode requires a fresh Preview')
  })

  it('override: clicking Import after a fresh Preview opens the in-DOM confirm with mode/rowCount/date-range/user-count — no precise overwrite count', async () => {
    vi.mocked(apiFetch).mockImplementation(baseApiFetchRouter({
      // rowCount (5) intentionally exceeds items.length (2) — simulates a truncated preview
      // sample; the modal's rowCount line must reflect the backend's resolved total, while
      // the date-range/user-count lines are honestly derived from just the loaded sample.
      preview: {
        items: [
          { userId: 'user-1', workDate: '2026-04-04' },
          { userId: 'user-2', workDate: '2026-04-06' },
        ],
        rowCount: 5,
      },
    }))
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi(8)

    const importSection = findImportSection(container!)
    findButton(importSection, 'Preview').click()
    await flushUi(6)
    importSection.querySelector<HTMLButtonElement>('[data-import-run]')!.click()
    await flushUi(4)

    const modal = container!.querySelector('[data-import-override-confirm]')
    expect(modal, 'expected the override confirm modal to open').toBeTruthy()

    const rows = Array.from(modal!.querySelectorAll('table tr')).map(row => ({
      label: row.querySelector('th')?.textContent?.trim(),
      value: row.querySelector('td')?.textContent?.trim(),
    }))
    expect(rows).toEqual([
      { label: 'Mode', value: 'override (overwrite same user/date)' },
      { label: 'Parsed rows (preview)', value: '5' },
      { label: 'Date range (preview)', value: '2026-04-04 ~ 2026-04-06' },
      { label: 'Distinct users (preview)', value: '2' },
      // rowCount(5) > loaded items(2) → the modal must disclose the truncated sample (P3-1)
      { label: 'Sample truncated', value: '2/5 rows loaded — the date-range/user figures above reflect the loaded sample only' },
    ])

    const warningEl = modal!.querySelector('[data-import-override-warning]')
    expect(warningEl?.textContent?.trim()).toBe('⚠ Overwritten rows cannot be restored via rollback.')
    // The generic warning line itself must never carry a digit (no precise overwrite count).
    expect(warningEl?.textContent).not.toMatch(/\d/)
  })

  it('override: confirm-submit stays disabled until the mandatory checkbox is checked, then proceeds to the real import commit', async () => {
    const apiFetchMock = vi.mocked(apiFetch)
    apiFetchMock.mockImplementation(baseApiFetchRouter({
      preview: { items: [{ userId: 'user-1', workDate: '2026-04-04' }], rowCount: 1 },
      commitImported: 1,
    }))

    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi(8)

    const importSection = findImportSection(container!)
    findButton(importSection, 'Preview').click()
    await flushUi(8)
    importSection.querySelector<HTMLButtonElement>('[data-import-run]')!.click()
    await flushUi(6)

    const modal = container!.querySelector('[data-import-override-confirm]')!
    expect(modal, 'expected the override confirm modal to open').toBeTruthy()
    const submitBtn = modal.querySelector<HTMLButtonElement>('[data-import-override-confirm-submit]')!
    expect(submitBtn.disabled).toBe(true)

    const checkbox = modal.querySelector<HTMLInputElement>('[data-import-override-extra-confirm] input[type="checkbox"]')!
    checkbox.checked = true
    checkbox.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi(2)
    expect(submitBtn.disabled).toBe(false)

    const commitCalledBefore = apiFetchMock.mock.calls.some(([url]) => String(url).startsWith('/api/attendance/import/commit'))
    expect(commitCalledBefore).toBe(false)
    submitBtn.click()
    await flushUi(8)

    const commitCalledAfter = apiFetchMock.mock.calls.some(([url]) => String(url).startsWith('/api/attendance/import/commit'))
    expect(commitCalledAfter).toBe(true)
    expect(container!.querySelector('[data-import-override-confirm]')).toBeFalsy() // modal closes after confirm
  })

  it('override: editing a key import param after a fresh Preview invalidates it again (Import re-disables)', async () => {
    vi.mocked(apiFetch).mockImplementation(baseApiFetchRouter({
      preview: { items: [{ userId: 'user-1', workDate: '2026-04-04' }], rowCount: 1 },
    }))
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi(8)

    const importSection = findImportSection(container!)
    findButton(importSection, 'Preview').click()
    await flushUi(6)
    const importBtn = importSection.querySelector<HTMLButtonElement>('[data-import-run]')!
    expect(importBtn.disabled).toBe(false)

    setInput(importSection, '#attendance-import-user', 'a-different-user')
    await flushUi(2)

    expect(importBtn.disabled).toBe(true)
    expect(importSection.textContent).toContain('override mode requires a fresh Preview')
  })

  // [P1 TOCTOU golden] The confirm-modal path must ALSO be freshness-gated at CONFIRM
  // time: runImport() rebuilds the payload from the live form, so editing anything after
  // the modal opened would otherwise submit a never-previewed payload (the Import-button
  // disable above only guards modal OPENING, not an already-open modal).
  it('override: editing the form while the confirm modal is open makes Confirm a no-op that requires a fresh Preview (no commit call)', async () => {
    const apiFetchMock = vi.mocked(apiFetch)
    apiFetchMock.mockImplementation(baseApiFetchRouter({
      preview: { items: [{ userId: 'user-1', workDate: '2026-04-04' }], rowCount: 1 },
      commitImported: 1,
    }))

    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi(8)

    const importSection = findImportSection(container!)
    findButton(importSection, 'Preview').click()
    await flushUi(8)
    importSection.querySelector<HTMLButtonElement>('[data-import-run]')!.click()
    await flushUi(6)

    const modal = container!.querySelector('[data-import-override-confirm]')!
    expect(modal, 'expected the override confirm modal to open').toBeTruthy()

    // Edit a payload-feeding field AFTER the modal is open (the TOCTOU window).
    setInput(importSection, '#attendance-import-user', 'a-user-never-previewed')
    await flushUi(2)

    const checkbox = modal.querySelector<HTMLInputElement>('[data-import-override-extra-confirm] input[type="checkbox"]')!
    checkbox.checked = true
    checkbox.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi(2)
    modal.querySelector<HTMLButtonElement>('[data-import-override-confirm-submit]')!.click()
    await flushUi(8)

    // Confirm must NOT have committed the drifted, never-previewed payload…
    const commitCalled = apiFetchMock.mock.calls.some(([url]) => String(url).startsWith('/api/attendance/import/commit'))
    expect(commitCalled).toBe(false)
    // …the modal is closed (stale confirmation context must not linger)…
    expect(container!.querySelector('[data-import-override-confirm]')).toBeFalsy()
    // …and the operator is told to re-run Preview.
    expect(container!.textContent).toContain('Import settings changed after Preview')
  })

  it('override: flipping the mode selector to merge while the confirm modal is open is also a drifted-confirm no-op', async () => {
    const apiFetchMock = vi.mocked(apiFetch)
    apiFetchMock.mockImplementation(baseApiFetchRouter({
      preview: { items: [{ userId: 'user-1', workDate: '2026-04-04' }], rowCount: 1 },
      commitImported: 1,
    }))

    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi(8)

    const importSection = findImportSection(container!)
    findButton(importSection, 'Preview').click()
    await flushUi(8)
    importSection.querySelector<HTMLButtonElement>('[data-import-run]')!.click()
    await flushUi(6)

    const modal = container!.querySelector('[data-import-override-confirm]')!
    expect(modal, 'expected the override confirm modal to open').toBeTruthy()

    // Mode is part of the payload fingerprint: flipping it mid-modal is drift too —
    // the confirmed-as-override submission must not silently run as a merge (or any
    // other un-previewed shape).
    selectOption(importSection, '#attendance-import-mode', 'merge')
    await flushUi(2)

    const checkbox = modal.querySelector<HTMLInputElement>('[data-import-override-extra-confirm] input[type="checkbox"]')!
    checkbox.checked = true
    checkbox.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi(2)
    modal.querySelector<HTMLButtonElement>('[data-import-override-confirm-submit]')!.click()
    await flushUi(8)

    const commitCalled = apiFetchMock.mock.calls.some(([url]) => String(url).startsWith('/api/attendance/import/commit'))
    expect(commitCalled).toBe(false)
    expect(container!.querySelector('[data-import-override-confirm]')).toBeFalsy()
  })

  it('merge: Import never opens the confirm modal and submits directly, even with no prior Preview', async () => {
    const apiFetchMock = vi.mocked(apiFetch)
    apiFetchMock.mockImplementation(baseApiFetchRouter({ commitImported: 0 }))

    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi(8)

    const importSection = findImportSection(container!)
    selectOption(importSection, '#attendance-import-mode', 'merge')
    await flushUi(2)

    const importBtn = importSection.querySelector<HTMLButtonElement>('[data-import-run]')!
    expect(importBtn.disabled).toBe(false) // merge never requires a preview

    importBtn.click()
    await flushUi(8)

    expect(container!.querySelector('[data-import-override-confirm]')).toBeFalsy()
    const commitCalled = apiFetchMock.mock.calls.some(([url]) => String(url).startsWith('/api/attendance/import/commit'))
    expect(commitCalled).toBe(true)
  })

  it('export backup: calls the existing GET /api/attendance/export with an exact org/user/date-range query, and updates the status indicator', async () => {
    // jsdom has no URL.createObjectURL/revokeObjectURL — stub them exactly like the existing
    // exportCsv()/exportAuditLogsCsv() coverage in attendance-admin-regressions.spec.ts does,
    // since exportImportOverrideBackup() reuses the same downloadCsvText() helper.
    const originalCreateObjectURL = URL.createObjectURL
    const originalRevokeObjectURL = URL.revokeObjectURL
    const createObjectURL = vi.fn(() => 'blob:attendance-override-backup')
    const revokeObjectURL = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL })

    try {
      vi.mocked(apiFetch).mockImplementation(baseApiFetchRouter({
        preview: {
          items: [
            { userId: 'user-1', workDate: '2026-04-04' },
            { userId: 'user-1', workDate: '2026-04-05' },
          ],
          rowCount: 2,
        },
      }))
      app = createApp(AttendanceView, { mode: 'admin' })
      const vm = app.mount(container!)
      await flushUi(8)

      const importSection = findImportSection(container!)
      // orgId's own input only renders in mode: 'overview' | 'reports' — set it directly here.
      assignSetupState((vm as any).$?.setupState as Record<string, any>, 'orgId', 'org-guard-1')
      setInput(importSection, '#attendance-import-user', 'user-1')
      await flushUi(2)

      findButton(importSection, 'Preview').click()
      await flushUi(6)
      importSection.querySelector<HTMLButtonElement>('[data-import-run]')!.click()
      await flushUi(4)

      const modal = container!.querySelector('[data-import-override-confirm]')!
      const backupBtn = modal.querySelector<HTMLButtonElement>('[data-import-override-export-backup]')!
      expect(backupBtn.disabled).toBe(false) // a single target user (form field) resolved
      expect(modal.querySelector('[data-import-override-backup-status]')?.textContent).toBe('Not exported yet')

      const apiFetchMock = vi.mocked(apiFetch)
      backupBtn.click()
      await flushUi(6)

      const exportCall = apiFetchMock.mock.calls.find(([url]) => String(url).startsWith('/api/attendance/export'))
      expect(exportCall, 'expected a GET /api/attendance/export call').toBeTruthy()
      const [calledUrl, calledInit] = exportCall!
      expect(calledInit).toBeUndefined() // a plain GET, mirrors exportCsv()'s single-argument call
      const query = new URLSearchParams(String(calledUrl).split('?')[1] ?? '')
      expect(query.get('format')).toBe('csv')
      expect(query.get('orgId')).toBe('org-guard-1')
      expect(query.get('userId')).toBe('user-1')
      expect(query.get('from')).toBe('2026-04-04')
      expect(query.get('to')).toBe('2026-04-05')

      expect(modal.querySelector('[data-import-override-backup-status]')?.textContent).toBe('Backup exported')
      expect(createObjectURL).toHaveBeenCalledTimes(1)
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:attendance-override-backup')
    } finally {
      Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: originalCreateObjectURL })
      Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: originalRevokeObjectURL })
    }
  })

  it('export backup: disables the button and explains why when no single target user can be resolved', async () => {
    vi.mocked(apiFetch).mockImplementation(baseApiFetchRouter({
      preview: {
        items: [
          { userId: 'user-1', workDate: '2026-04-04' },
          { userId: 'user-2', workDate: '2026-04-05' },
        ],
        rowCount: 2,
      },
    }))
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi(8)

    const importSection = findImportSection(container!)
    // deliberately leave the top-level "User ID" field blank — two distinct users in the
    // preview means there is no single honest backup target.
    findButton(importSection, 'Preview').click()
    await flushUi(6)
    importSection.querySelector<HTMLButtonElement>('[data-import-run]')!.click()
    await flushUi(4)

    const modal = container!.querySelector('[data-import-override-confirm]')!
    const backupBtn = modal.querySelector<HTMLButtonElement>('[data-import-override-export-backup]')!
    expect(backupBtn.disabled).toBe(true)
    expect(modal.querySelector('[data-import-override-backup-hint]')?.textContent).toContain('needs a single target user')
  })

  it('P2-1 fix: a failed merge import switched to override cannot commit via Retry — the retry action passes the same gate', async () => {
    const apiFetchMock = vi.mocked(apiFetch)
    apiFetchMock.mockImplementation(baseApiFetchRouter({ commitStatus: 500 }))
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi(8)

    const importSection = findImportSection(container!)
    const modeSelect = importSection.querySelector<HTMLSelectElement>('#attendance-import-mode')!
    modeSelect.value = 'merge'
    modeSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi(2)

    // merge is one-click; the commit fails → the status area offers "Retry import"
    importSection.querySelector<HTMLButtonElement>('[data-import-run]')!.click()
    await flushUi(8)
    const commitCallsAfterMerge = apiFetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/attendance/import/commit')).length
    expect(commitCallsAfterMerge).toBe(1)
    const retryBtn = Array.from(container!.querySelectorAll<HTMLButtonElement>('button'))
      .find(btn => btn.textContent?.trim() === 'Retry import')
    expect(retryBtn, 'expected the failed import to surface a Retry action').toBeTruthy()

    // operator flips the selector to override, then clicks Retry: the OLD code committed
    // directly (never-confirmed override submit); the gate must block it instead —
    // no fresh Preview exists, so no modal, no commit, and the preview-required hint shows.
    modeSelect.value = 'override'
    modeSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi(2)
    retryBtn!.click()
    await flushUi(6)

    const commitCallsAfterRetry = apiFetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/attendance/import/commit')).length
    expect(commitCallsAfterRetry).toBe(1) // unchanged — the bypass is closed
    expect(container!.querySelector('[data-import-override-confirm]')).toBeFalsy()
    expect(importSection.textContent).toContain('override mode requires a fresh Preview')
  })

  it('P2-1 fix: a failed override import re-opens the confirm modal on Retry instead of re-committing directly', async () => {
    const apiFetchMock = vi.mocked(apiFetch)
    apiFetchMock.mockImplementation(baseApiFetchRouter({
      preview: { items: [{ userId: 'user-1', workDate: '2026-04-04' }], rowCount: 1 },
      commitStatus: 500,
    }))
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi(8)

    const importSection = findImportSection(container!)
    findButton(importSection, 'Preview').click()
    await flushUi(8)
    importSection.querySelector<HTMLButtonElement>('[data-import-run]')!.click()
    await flushUi(4)
    const modal = container!.querySelector('[data-import-override-confirm]')!
    const checkbox = modal.querySelector<HTMLInputElement>('[data-import-override-extra-confirm] input[type="checkbox"]')!
    checkbox.checked = true
    checkbox.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi(2)
    modal.querySelector<HTMLButtonElement>('[data-import-override-confirm-submit]')!.click()
    await flushUi(8)

    const commitCalls = () => apiFetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/attendance/import/commit')).length
    expect(commitCalls()).toBe(1) // the confirmed submit failed server-side

    const retryBtn = Array.from(container!.querySelectorAll<HTMLButtonElement>('button'))
      .find(btn => btn.textContent?.trim() === 'Retry import')
    expect(retryBtn, 'expected the failed import to surface a Retry action').toBeTruthy()
    retryBtn!.click()
    await flushUi(6)

    // Security invariant (the whole point of P2-1): Retry must NOT silently re-commit an
    // override. It routes through requestRunImport(), so the operator faces the gate again —
    // either the confirm modal re-opens (if the preview is still fresh) or the
    // preview-required hint (if the failed commit invalidated the payload fingerprint). In
    // NEITHER case does a commit fire without a fresh, re-confirmed submit.
    expect(commitCalls()).toBe(1) // no bypass commit
    const gateSection = findImportSection(container!)
    const modalReopened = container!.querySelector('[data-import-override-confirm]') !== null
    const previewGateShown = gateSection.textContent!.includes('override mode requires a fresh Preview')
    expect(modalReopened || previewGateShown, 'retry must re-present the override gate, never a silent commit').toBe(true)
  })

  it('P3-1 fix: a truncated preview sample suppresses single-user backup auto-resolution until User ID is explicit', async () => {
    vi.mocked(apiFetch).mockImplementation(baseApiFetchRouter({
      // single distinct user in the LOADED sample, but rowCount says there are more rows
      preview: { items: [{ userId: 'user-1', workDate: '2026-04-04' }], rowCount: 9 },
    }))
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi(8)

    const importSection = findImportSection(container!)
    findButton(importSection, 'Preview').click()
    await flushUi(6)
    importSection.querySelector<HTMLButtonElement>('[data-import-run]')!.click()
    await flushUi(4)

    const modal = container!.querySelector('[data-import-override-confirm]')!
    expect(modal.textContent).toContain('Sample truncated')
    const backupBtn = modal.querySelector<HTMLButtonElement>('[data-import-override-export-backup]')!
    expect(backupBtn.disabled).toBe(true) // sample-derived single user is NOT trusted
    expect(modal.querySelector('[data-import-override-backup-hint]')?.textContent).toContain('truncated preview sample')

    // explicit operator intent still enables the backup
    ;(container!.querySelector('[data-import-override-confirm] .attendance__admin-actions button') as HTMLButtonElement).click() // cancel
    await flushUi(2)
    setInput(importSection, '#attendance-import-user', 'user-1')
    findButton(importSection, 'Preview').click()
    await flushUi(6)
    importSection.querySelector<HTMLButtonElement>('[data-import-run]')!.click()
    await flushUi(4)
    const modal2 = container!.querySelector('[data-import-override-confirm]')!
    expect(modal2.querySelector<HTMLButtonElement>('[data-import-override-export-backup]')!.disabled).toBe(false)
  })

  it('G2: the mode-selector hint states the override/merge tradeoff (overwrite+non-recoverable vs. non-destructive union)', async () => {
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi(8)

    const importSection = findImportSection(container!)
    const hint = importSection.querySelector('[data-import-mode-compare-hint]')
    expect(hint?.textContent).toContain('cannot be restored via rollback')
    expect(hint?.textContent).toContain('non-destructive')
  })
})

describe('Attendance override-import guard — G3 manual-adjustment ledger note', () => {
  let app: App<Element> | null = null
  let container: HTMLDivElement | null = null
  let originalScrollIntoView: typeof HTMLElement.prototype.scrollIntoView | undefined

  const enabledPolicySettings = () => jsonResponse(200, {
    ok: true,
    data: { annualLeavePolicy: { enabled: true, tenureMode: 'cumulative_service', standardDayMinutes: 480, tiers: [{ minYears: 1, maxYears: null, days: 5 }], carryover: { enabled: false }, timezone: 'Asia/Shanghai' } },
  })

  beforeEach(() => {
    vi.clearAllMocks()
    window.localStorage.setItem('metasheet_locale', 'en')
    container = document.createElement('div')
    document.body.appendChild(container)
    originalScrollIntoView = HTMLElement.prototype.scrollIntoView
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
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

  async function openAdjustConfirm(deltaMinutes: string) {
    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi(8)

    container!.querySelector<HTMLButtonElement>('[data-admin-anchor="attendance-admin-annual-leave-operations"]')!.click()
    await flushUi(4)
    const section = container!.querySelector<HTMLElement>('#attendance-admin-annual-leave-operations')!
    const card = section.querySelector<HTMLElement>('[data-annual-ops-card="adjust"]')!
    const inputs = card.querySelectorAll<HTMLInputElement>('input')
    inputs[0].value = 'u1'; inputs[0].dispatchEvent(new Event('input'))
    inputs[1].value = deltaMinutes; inputs[1].dispatchEvent(new Event('input'))
    inputs[2].value = 'correction'; inputs[2].dispatchEvent(new Event('input'))
    await flushUi(2)
    Array.from(card.querySelectorAll<HTMLButtonElement>('button')).find(b => b.textContent?.includes('Adjust balance'))!.click()
    await flushUi(2)
    return section
  }

  it('a negative (deduction) adjustment adds the reverse-adjustment ledger note to the confirm lines', async () => {
    vi.mocked(apiFetch).mockImplementation(async (input: string) => {
      const url = String(input)
      if (url.includes('/api/attendance/settings')) return enabledPolicySettings()
      return jsonResponse(200, { ok: true, data: { items: [], summary: null } })
    })

    const section = await openAdjustConfirm('-120')

    const confirmModal = section.querySelector('[data-annual-ops-confirm]')
    expect(confirmModal, 'expected the shared annualOpsConfirm modal to open').toBeTruthy()
    expect(confirmModal!.textContent).toContain('The deduction is written to the ledger')
    expect(confirmModal!.textContent).toContain('reverse adjustment')
    expect(confirmModal!.textContent).toContain('cannot be undone directly')
  })

  it('a positive (grant) adjustment does NOT add the ledger note', async () => {
    vi.mocked(apiFetch).mockImplementation(async (input: string) => {
      const url = String(input)
      if (url.includes('/api/attendance/settings')) return enabledPolicySettings()
      return jsonResponse(200, { ok: true, data: { items: [], summary: null } })
    })

    const section = await openAdjustConfirm('120')

    const confirmModal = section.querySelector('[data-annual-ops-confirm]')
    expect(confirmModal, 'expected the shared annualOpsConfirm modal to open').toBeTruthy()
    expect(confirmModal!.textContent).not.toContain('reverse adjustment')
    expect(confirmModal!.textContent).not.toContain('written to the ledger')
  })
})
