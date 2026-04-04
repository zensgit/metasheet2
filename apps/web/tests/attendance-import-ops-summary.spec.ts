import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref, type App } from 'vue'
import AttendanceView from '../src/views/AttendanceView.vue'
import { apiFetch } from '../src/utils/api'

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

function findImportSection(container: HTMLElement): HTMLElement {
  const heading = Array.from(container.querySelectorAll('h4')).find(
    candidate => candidate.textContent?.trim() === 'Import (DingTalk / Manual)',
  )
  expect(heading, 'expected import section heading').toBeTruthy()
  const section = heading?.closest('.attendance__admin-section')
  expect(section, 'expected import section container').toBeTruthy()
  return section as HTMLElement
}

function assignSetupState(target: Record<string, any>, key: string, next: unknown): void {
  const current = target[key]
  if (current && typeof current === 'object' && 'value' in current) {
    current.value = next
    return
  }
  target[key] = next
}

function findPanel(container: HTMLElement, label: string): HTMLElement {
  const panel = Array.from(container.querySelectorAll('.attendance__template-version-panel')).find(
    candidate => candidate.textContent?.includes(label),
  )
  expect(panel, `expected panel containing "${label}"`).toBeTruthy()
  return panel as HTMLElement
}

function findScorecard(panel: HTMLElement, label: string): HTMLElement {
  const card = Array.from(panel.querySelectorAll('.attendance__preview-scorecard')).find(
    candidate => candidate.textContent?.includes(label),
  )
  expect(card, `expected scorecard containing "${label}"`).toBeTruthy()
  return card as HTMLElement
}

describe('Attendance import ops summary', () => {
  let app: App<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    vi.clearAllMocks()
    window.localStorage.setItem('metasheet_locale', 'en')
    vi.mocked(apiFetch).mockImplementation(async () => jsonResponse(200, {
      ok: true,
      data: {
        items: [],
        summary: null,
      },
    }))
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
  })

  it('surfaces a current import plan summary for operator readiness', async () => {
    app = createApp(AttendanceView, { mode: 'admin' })
    const vm = app.mount(container!)
    await flushUi()

    const setupState = (vm as any).$?.setupState as Record<string, any>
    assignSetupState(setupState, 'importMappingProfiles', [{
      id: 'profile-dingtalk',
      name: 'DingTalk',
      requiredFields: ['userId', 'workDate'],
    }])
    assignSetupState(setupState, 'importProfileId', 'profile-dingtalk')
    assignSetupState(setupState, 'importCsvFileName', 'attendance.csv')
    assignSetupState(setupState, 'importCsvFileId', 'csv-upload-1')
    assignSetupState(setupState, 'importCsvFileRowCountHint', 240)
    setupState.importForm.payload = JSON.stringify({ csvFileId: 'csv-upload-1' }, null, 2)
    assignSetupState(setupState, 'importUserMap', {
      '001': { userId: 'user-1' },
      '002': { userId: 'user-2' },
    })
    assignSetupState(setupState, 'importUserMapKeyField', 'empNo')
    assignSetupState(setupState, 'importUserMapSourceFields', '工号, 姓名')
    assignSetupState(setupState, 'importGroupAutoCreate', true)
    assignSetupState(setupState, 'importGroupAutoAssign', true)
    assignSetupState(setupState, 'importGroupTimezone', 'Asia/Shanghai')
    await flushUi()

    const importSection = findImportSection(container!)
    const planPanel = findPanel(importSection, 'Current import plan')
    expect(planPanel.textContent).toContain('uploaded CSV')
    expect(planPanel.textContent).toContain('attendance.csv')
    expect(planPanel.textContent).toContain('240')
    expect(planPanel.textContent).toContain('Preview lane')
    expect(planPanel.textContent).toContain('Import lane')
    expect(planPanel.textContent).toContain('Mapping profile: DingTalk (2 required fields)')
    expect(planPanel.textContent).toContain('User map: 2 entries ready · key empNo · source 工号, 姓名')
    expect(planPanel.textContent).toContain('Group sync')
    expect(planPanel.textContent).toContain('auto-create groups')
    expect(planPanel.textContent).toContain('auto-assign members')
    expect(planPanel.textContent).toContain('UTC+08:00 · Asia/Shanghai')
    expect(planPanel.textContent).toContain('Commit token: not prepared yet')
  })

  it('does not overcount inline csv rows when the payload ends with a trailing newline', async () => {
    app = createApp(AttendanceView, { mode: 'admin' })
    const vm = app.mount(container!)
    await flushUi()

    const setupState = (vm as any).$?.setupState as Record<string, any>
    setupState.importForm.payload = JSON.stringify({
      csvText: 'userId,workDate\nuser-1,2026-04-04\nuser-2,2026-04-05\n',
    }, null, 2)
    await flushUi()

    const importSection = findImportSection(container!)
    const planPanel = findPanel(importSection, 'Current import plan')
    const estimatedRowsCard = findScorecard(planPanel, 'Estimated rows')
    expect(estimatedRowsCard.textContent).toContain('2')
  })

  it('summarizes preview rows, users, warnings, and policies before commit', async () => {
    app = createApp(AttendanceView, { mode: 'admin' })
    const vm = app.mount(container!)
    await flushUi()

    const setupState = (vm as any).$?.setupState as Record<string, any>
    assignSetupState(setupState, 'importPreview', [
      {
        userId: 'user-1',
        workDate: '2026-04-04',
        workMinutes: 480,
        lateMinutes: 12,
        earlyLeaveMinutes: 0,
        status: 'late',
        warnings: ['Missing employee number'],
        appliedPolicies: ['late-guard'],
        userGroups: ['ops'],
      },
      {
        userId: 'user-2',
        workDate: '2026-04-04',
        workMinutes: 420,
        lateMinutes: 0,
        earlyLeaveMinutes: 20,
        status: 'early_leave',
        warnings: ['Needs manager review'],
        appliedPolicies: ['early-leave-guard'],
        userGroups: ['ops'],
      },
    ])
    assignSetupState(setupState, 'importCsvWarnings', ['CSV header mismatch', 'Group sync skipped'])
    assignSetupState(setupState, 'importPreviewTask', {
      mode: 'single',
      status: 'completed',
      totalRows: 3,
      processedRows: 3,
      totalChunks: 1,
      completedChunks: 1,
      message: null,
    })
    await flushUi()

    const importSection = findImportSection(container!)
    const previewPanel = findPanel(importSection, 'Preview outcome')
    expect(previewPanel.textContent).toContain('Preview task is Completed · 3/3')
    expect(previewPanel.textContent).toContain('Preview rows')
    expect(previewPanel.textContent).toContain('2/3')
    expect(previewPanel.textContent).toContain('Users in preview')
    expect(previewPanel.textContent).toContain('Warning signals')
    expect(previewPanel.textContent).toContain('Policies / groups')
    expect(previewPanel.textContent).toContain('4')
    expect(previewPanel.textContent).toContain('3')
    expect(previewPanel.textContent).toContain('Commit token: refreshes automatically on the next preview/import')
  })
})
