import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref, type App } from 'vue'
import AttendanceView from '../src/views/AttendanceView.vue'
import { apiFetch } from '../src/utils/api'
import { useLocale } from '../src/composables/useLocale'
import * as XLSX from 'xlsx'

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

async function flushUi(cycles = 4): Promise<void> {
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

function unwrapRef<T>(value: unknown): T {
  if (value && typeof value === 'object' && 'value' in (value as Record<string, unknown>)) {
    return (value as { value: T }).value
  }
  return value as T
}

describe('Attendance import preview regression', () => {
  let app: App<Element> | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    vi.clearAllMocks()
    window.localStorage.setItem('metasheet_locale', 'en')
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
  })

  it('clears stale preview rows/warnings on preview retry failure and keeps retry action context', async () => {
    const apiFetchMock = vi.mocked(apiFetch)
    let previewRequestCount = 0

    apiFetchMock.mockImplementation(async (path: string) => {
      const url = String(path)
      if (url.startsWith('/api/attendance/import/prepare')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            commitToken: `token-${previewRequestCount + 1}`,
            expiresAt: '2099-01-01T00:00:00.000Z',
          },
        })
      }

      if (url.startsWith('/api/attendance/import/preview')) {
        previewRequestCount += 1
        if (previewRequestCount === 1) {
          return jsonResponse(200, {
            ok: true,
            data: {
              items: [
                {
                  userId: 'user-old',
                  workDate: '2026-03-01',
                  workMinutes: 480,
                  lateMinutes: 5,
                  earlyLeaveMinutes: 0,
                  status: 'late',
                  warnings: ['stale-item-warning'],
                  matchedPolicies: [],
                },
              ],
              csvWarnings: ['stale-csv-warning'],
              groupWarnings: ['stale-group-warning'],
              rowCount: 1,
            },
          })
        }

        return jsonResponse(502, {
          ok: false,
          error: {
            code: 'BAD_GATEWAY',
            message: 'gateway temporarily unavailable',
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
    const vm = app.mount(container!)
    await flushUi(6)

    const importSection = findImportSection(container!)

    findButton(importSection, 'Preview').click()
    await flushUi(6)

    expect(container!.textContent).toContain('user-old')
    expect(container!.textContent).toContain('CSV warnings: stale-csv-warning; stale-group-warning')

    findButton(importSection, 'Preview').click()
    await flushUi(6)

    const setupState = (vm as any).$?.setupState as Record<string, unknown>
    expect(importSection.textContent).toContain('No preview data.')
    expect(importSection.textContent).not.toContain('user-old')
    expect(importSection.textContent).not.toContain('stale-csv-warning')
    expect(container!.textContent).toContain('Import preview request hit a temporary gateway error.')
    expect(container!.textContent).toContain('Code: BAD_GATEWAY')
    expect(container!.textContent).toContain('Retry preview')

    expect(unwrapRef<any[]>(setupState.importPreview)).toHaveLength(0)
    expect(unwrapRef<string[]>(setupState.importCsvWarnings)).toEqual([])
    expect(unwrapRef<Record<string, unknown> | null>(setupState.statusMeta)?.action).toBe('retry-preview-import')
    expect(unwrapRef<Record<string, unknown> | null>(setupState.statusMeta)?.context).toBe('import-preview')

    findButton(container!, 'Retry preview').click()
    await flushUi(6)

    expect(previewRequestCount).toBe(3)
    expect(importSection.textContent).toContain('No preview data.')
    expect(importSection.textContent).not.toContain('user-old')
    expect(importSection.textContent).not.toContain('stale-csv-warning')
    expect(unwrapRef<any[]>(setupState.importPreview)).toHaveLength(0)
    expect(unwrapRef<string[]>(setupState.importCsvWarnings)).toEqual([])
    expect(unwrapRef<Record<string, unknown> | null>(setupState.statusMeta)?.action).toBe('retry-preview-import')
  })

  it('normalizes string CSV template columns before preview submit', async () => {
    const apiFetchMock = vi.mocked(apiFetch)
    let previewPayload: Record<string, any> | null = null

    apiFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      const url = String(path)
      if (url.startsWith('/api/attendance/import/prepare')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            commitToken: 'token-columns',
            expiresAt: '2099-01-01T00:00:00.000Z',
          },
        })
      }

      if (url.startsWith('/api/attendance/import/preview')) {
        previewPayload = JSON.parse(String(init?.body ?? '{}'))
        return jsonResponse(200, {
          ok: true,
          data: {
            items: [],
            csvWarnings: [],
            groupWarnings: [],
            rowCount: 1,
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
    const vm = app.mount(container!)
    await flushUi(6)

    const setupState = (vm as any).$?.setupState as Record<string, any>
    setupState.importForm.payload = JSON.stringify({
      source: 'dingtalk_csv',
      columns: ['日期', 'UserId', '考勤组'],
      csvText: '日期,UserId,考勤组\n2026-03-12,u-1,白班\n',
    }, null, 2)
    await flushUi(2)

    const importSection = findImportSection(container!)
    findButton(importSection, 'Preview').click()
    await flushUi(6)

    expect(previewPayload?.columns).toEqual([
      { id: '日期', name: '日期' },
      { id: 'UserId', name: 'UserId' },
      { id: '考勤组', name: '考勤组' },
    ])
    expect(previewPayload?.csvText).toBe('日期,UserId,考勤组\n2026-03-12,u-1,白班\n')
    expect(apiFetchMock).toHaveBeenCalledWith(
      '/api/attendance/import/preview',
      expect.objectContaining({
        method: 'POST',
      }),
    )
  })

  it('blocks selecting a macro workbook (.xlsm) in the CSV import input: no import API call, actionable zh guidance', async () => {
    const { locale, setLocale } = useLocale()
    const previousLocale = locale.value
    setLocale('zh-CN')
    try {
      const apiFetchMock = vi.mocked(apiFetch)
      apiFetchMock.mockImplementation(async () => jsonResponse(200, {
        ok: true,
        data: { items: [], summary: null },
      }))

      app = createApp(AttendanceView, { mode: 'admin' })
      const vm = app.mount(container!)
      await flushUi(6)
      apiFetchMock.mockClear()

      const input = container!.querySelector('#attendance-import-csv') as HTMLInputElement | null
      expect(input, 'expected csv file input').toBeTruthy()

      const xlsx = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], '6月考勤(5).xlsm', {
        type: 'application/vnd.ms-excel.sheet.macroEnabled.12',
      })
      Object.defineProperty(input!, 'files', { value: [xlsx], configurable: true })
      input!.dispatchEvent(new Event('change'))
      await flushUi(6)

      const importApiCalls = apiFetchMock.mock.calls.filter(call =>
        String(call[0]).includes('/api/attendance/import'))
      expect(importApiCalls).toHaveLength(0)

      const setupState = (vm as any).$?.setupState as Record<string, unknown>
      expect(unwrapRef<File | null>(setupState.importCsvFile)).toBeNull()
      expect(unwrapRef<string>(setupState.importCsvFileName)).toBe('')
      expect(container!.textContent).toContain('检测到 Excel 文件')
      expect(container!.textContent).toContain('另存为')
      expect(unwrapRef<Record<string, unknown> | null>(setupState.statusMeta)?.action).toBe('retry-preview-import')
      expect(container!.querySelector('[data-testid="attendance-import-recognition"]'), 'no recognition panel for a blocked file').toBeNull()
    } finally {
      setLocale(previousLocale)
    }
  })

  it('maps import VALIDATION_ERROR to actionable zh copy per server diagnostic, keeping the code chip', async () => {
    const { locale, setLocale } = useLocale()
    const previousLocale = locale.value
    setLocale('zh-CN')
    try {
      const apiFetchMock = vi.mocked(apiFetch)
      let previewRequestCount = 0
      apiFetchMock.mockImplementation(async (path: string) => {
        const url = String(path)
        if (url.startsWith('/api/attendance/import/prepare')) {
          return jsonResponse(200, {
            ok: true,
            data: { commitToken: 'token-validation', expiresAt: '2099-01-01T00:00:00.000Z' },
          })
        }
        if (url.startsWith('/api/attendance/import/preview')) {
          previewRequestCount += 1
          return jsonResponse(400, {
            ok: false,
            error: {
              code: 'VALIDATION_ERROR',
              message: previewRequestCount === 1
                ? 'No rows to preview. CSV content did not yield any non-empty rows.'
                : 'CSV header must include a work date column and at least one user or attendance column',
            },
          })
        }
        return jsonResponse(200, { ok: true, data: { items: [], summary: null } })
      })

      app = createApp(AttendanceView, { mode: 'admin' })
      app.mount(container!)
      await flushUi(6)

      const zhHeading = Array.from(container!.querySelectorAll('h4')).find(
        candidate => candidate.textContent?.includes('导入（钉钉')
      )
      expect(zhHeading, 'expected zh import section heading').toBeTruthy()
      const importSection = zhHeading!.closest('.attendance__admin-section') as HTMLElement

      // Server "No rows to preview…" → row-specific zh copy + Save-As-CSV hint.
      findButton(importSection, '预览').click()
      await flushUi(6)
      expect(container!.textContent).toContain('文件未解析出可导入的数据行')
      expect(container!.textContent).toContain('另存为 → CSV')
      expect(container!.textContent).toContain('VALIDATION_ERROR')

      // Server header-missing diagnostic → header-specific zh copy.
      findButton(importSection, '预览').click()
      await flushUi(6)
      expect(previewRequestCount).toBe(2)
      expect(container!.textContent).toContain('CSV 表头缺少必需列')
      expect(container!.textContent).toContain('VALIDATION_ERROR')
    } finally {
      setLocale(previousLocale)
    }
  })

  function mockTemplateEndpoint(): ReturnType<typeof vi.mocked<typeof apiFetch>> {
    const apiFetchMock = vi.mocked(apiFetch)
    apiFetchMock.mockImplementation(async (path: string) => {
      const url = String(path)
      if (url.startsWith('/api/attendance/import/template')) {
        return jsonResponse(200, {
          ok: true,
          data: {
            payloadExample: {
              source: 'dingtalk_csv',
              mode: 'override',
              columns: ['日期', '工号', '姓名', '考勤组', '上班1打卡时间', '下班1打卡时间', '考勤结果', '异常原因'],
              requiredFields: ['日期'],
            },
            mappingProfiles: [],
            mapping: {
              columns: [
                { sourceField: '上班1打卡时间', targetField: 'firstInAt' },
                { sourceField: '下班1打卡时间', targetField: 'lastOutAt' },
                { sourceField: '考勤结果', targetField: 'status' },
                { sourceField: '异常原因', targetField: 'exceptionReason' },
                { sourceField: '加班小时', targetField: 'overtimeHours' },
                { sourceField: '考勤组', targetField: 'attendanceGroup' },
              ],
            },
          },
        })
      }
      return jsonResponse(200, { ok: true, data: { items: [], summary: null } })
    })
    return apiFetchMock
  }

  function stubObjectUrl() {
    const createObjectURL = vi.fn(() => 'blob:mock')
    const revokeObjectURL = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true })
    Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true })
    return { createObjectURL, revokeObjectURL }
  }

  it('field picker: load template renders grouped checkboxes and selection drives the header preview + download', async () => {
    mockTemplateEndpoint()
    const { createObjectURL } = stubObjectUrl()

    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi(6)

    const importSection = findImportSection(container!)
    findButton(importSection, 'Load template').click()
    await flushUi(6)

    const picker = container!.querySelector('[data-testid="attendance-import-field-picker"]') as HTMLElement | null
    expect(picker, 'expected field picker card').toBeTruthy()
    expect(picker!.textContent).toContain('Punch times')

    const preview = () => (container!.querySelector('[data-testid="attendance-import-header-preview"]') as HTMLElement).textContent ?? ''
    expect(preview()).toBe('日期,工号,姓名,上班1打卡时间,下班1打卡时间,考勤结果,异常原因,考勤组')

    const overtime = Array.from(picker!.querySelectorAll('label')).find(
      candidate => candidate.textContent?.trim() === '加班小时'
    )
    expect(overtime, 'expected 加班小时 option').toBeTruthy()
    ;(overtime!.querySelector('input') as HTMLInputElement).click()
    await flushUi(2)
    expect(preview()).toContain('加班小时')

    findButton(picker!, 'Download template (selected fields)').click()
    await flushUi(2)
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(container!.textContent).toContain('CSV template downloaded (9 columns).')
  })

  it('one-click template download: works from a cold panel by auto-loading first', async () => {
    const apiFetchMock = mockTemplateEndpoint()
    const { createObjectURL } = stubObjectUrl()

    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi(6)
    apiFetchMock.mockClear()

    const importSection = findImportSection(container!)
    const download = findButton(importSection, 'Download CSV template')
    expect(download.disabled).toBe(false)
    download.click()
    await flushUi(8)

    expect(apiFetchMock.mock.calls.some(call => String(call[0]).startsWith('/api/attendance/import/template'))).toBe(true)
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(container!.textContent).toContain('CSV template downloaded.')
  })

  it('one-click download never destroys a hand-edited payload: errors instead of auto-loading', async () => {
    const apiFetchMock = mockTemplateEndpoint()
    stubObjectUrl()

    app = createApp(AttendanceView, { mode: 'admin' })
    const vm = app.mount(container!)
    await flushUi(6)
    const setupState = (vm as any).$?.setupState as Record<string, unknown>
    const editedPayload = '{"source":"manual","rows":['
    ;(setupState.importForm as { payload: string }).payload = editedPayload
    await flushUi(2)
    apiFetchMock.mockClear()

    const importSection = findImportSection(container!)
    findButton(importSection, 'Download CSV template').click()
    await flushUi(6)

    expect(apiFetchMock.mock.calls.some(call => String(call[0]).startsWith('/api/attendance/import/template'))).toBe(false)
    expect((setupState.importForm as { payload: string }).payload).toBe(editedPayload)
    expect(container!.textContent).toContain('Payload JSON has content but no template columns')
  })

  async function selectImportCsv(content: string, name = 'attendance.csv') {
    const input = container!.querySelector('#attendance-import-csv') as HTMLInputElement
    expect(input, 'expected csv file input').toBeTruthy()
    const file = new File([content], name, { type: 'text/csv' })
    Object.defineProperty(input, 'files', { value: [file], configurable: true })
    input.dispatchEvent(new Event('change'))
    // FileReader (the jsdom read path) resolves on the macrotask queue, so
    // microtask-only flushes are not enough — poll briefly on real timers.
    for (let i = 0; i < 40; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 5))
      await flushUi(2)
      if (container!.querySelector('[data-testid="attendance-import-recognition"]')) break
    }
  }

  it('column recognition: selecting a csv shows green recognized / grey ignored chips at once', async () => {
    mockTemplateEndpoint()

    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi(6)

    await selectImportCsv('姓名,日期,加班小时,自定义列\n张三,2026-06-01,1,x\n')

    const panel = container!.querySelector('[data-testid="attendance-import-recognition"]') as HTMLElement | null
    expect(panel, 'expected recognition panel').toBeTruthy()
    expect(container!.querySelector('[data-testid="attendance-import-recognition-warning"]')).toBeNull()
    const okChipEls = Array.from(panel!.querySelectorAll('.attendance__import-recognition-chip--ok'))
    const okChips = okChipEls.map(chip => chip.textContent?.trim())
    expect(okChips).toContain('加班小时')
    expect(okChips).toContain('日期')
    const overtimeChip = okChipEls.find(chip => chip.textContent?.trim() === '加班小时')
    expect(overtimeChip?.getAttribute('title')).toBe('Imports as a record field')
    const nameChip = okChipEls.find(chip => chip.textContent?.trim() === '姓名')
    expect(nameChip?.getAttribute('title')).toBe('Used for header detection / user matching')
    const greyChips = Array.from(panel!.querySelectorAll('.attendance__import-recognition-chip'))
      .filter(chip => !chip.className.includes('--ok'))
      .map(chip => chip.textContent?.trim())
    expect(greyChips).toEqual(['自定义列'])
  })

  it('column recognition: a csv without a date column shows the red required warning', async () => {
    mockTemplateEndpoint()

    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi(6)

    await selectImportCsv('姓名,加班小时\n张三,1\n')

    const warning = container!.querySelector('[data-testid="attendance-import-recognition-warning"]') as HTMLElement | null
    expect(warning, 'expected required-column warning').toBeTruthy()
    expect(warning!.textContent).toContain('No date column found')
  })

  it('race guard: a stale sniff verdict cannot clobber a newer selection in the shell handler', async () => {
    mockTemplateEndpoint()

    app = createApp(AttendanceView, { mode: 'admin' })
    const vm = app.mount(container!)
    await flushUi(6)
    const setupState = (vm as any).$?.setupState as Record<string, any>

    let releaseSlow!: (buffer: ArrayBuffer) => void
    const slowFile = {
      name: 'slow.csv',
      slice: () => ({ arrayBuffer: () => new Promise<ArrayBuffer>(resolve => { releaseSlow = resolve }) }),
    }
    const fastFile = new File(['姓名,日期\n张三,2026-06-01\n'], 'fast.csv', { type: 'text/csv' })

    const sharedInput = { files: [slowFile], value: 'slow.csv' }
    const pending = setupState.handleImportCsvChange({ target: sharedInput })
    sharedInput.files = [fastFile]
    sharedInput.value = 'fast.csv'
    await setupState.handleImportCsvChange({ target: sharedInput })

    releaseSlow(new Uint8Array([0x50, 0x4b, 0x03, 0x04]).buffer)
    await pending
    await flushUi(4)

    expect(unwrapRef<File | null>(setupState.importCsvFile)).toBe(fastFile)
    expect(unwrapRef<string>(setupState.importCsvFileName)).toBe('fast.csv')
    expect(sharedInput.value).toBe('fast.csv')
    expect(container!.textContent).not.toContain('This looks like an Excel file')
  })

  it('advanced options collapse by default; core fields stay visible; toggle expands', async () => {
    mockTemplateEndpoint()

    app = createApp(AttendanceView, { mode: 'admin' })
    app.mount(container!)
    await flushUi(6)

    const advanced = container!.querySelector('[data-testid="attendance-import-advanced"]') as HTMLElement | null
    expect(advanced, 'expected advanced group container').toBeTruthy()
    expect(advanced!.style.display).toBe('none')
    expect(container!.querySelector('#attendance-import-csv'), 'core csv input stays visible').toBeTruthy()
    expect(advanced!.querySelector('#attendance-import-payload'), 'payload JSON lives in advanced').toBeTruthy()

    const toggle = container!.querySelector('[data-testid="attendance-import-advanced-toggle"]') as HTMLButtonElement
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    toggle.click()
    await flushUi(2)
    expect(advanced!.style.display).not.toBe('none')
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
  })

  it('X1: selecting a real .xlsx converts to CSV — status, hint, recognition, and Load CSV all run on the converted text', async () => {
    mockTemplateEndpoint()

    app = createApp(AttendanceView, { mode: 'admin' })
    const vm = app.mount(container!)
    await flushUi(6)
    const setupState = (vm as any).$?.setupState as Record<string, any>

    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
      ['日期', '工号', '姓名', '加班小时', '自定义列'],
      ['2026-06-01', 'EMP001', '张三', '1', 'x'],
    ]), '打卡日报')
    const buffer = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
    const file = new File([buffer], '6月考勤(5).xlsx', {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    })
    const input = container!.querySelector('#attendance-import-csv') as HTMLInputElement
    Object.defineProperty(input, 'files', { value: [file], configurable: true })
    input.dispatchEvent(new Event('change'))
    for (let i = 0; i < 60; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
      await flushUi(2)
      if (container!.querySelector('[data-testid="attendance-import-recognition"]')) break
    }

    expect(container!.textContent).toContain('Excel converted')
    expect(container!.querySelector('[data-testid="attendance-import-converted-hint"]')?.textContent).toContain('打卡日报')
    const panel = container!.querySelector('[data-testid="attendance-import-recognition"]')
    expect(panel, 'recognition runs on converted text').toBeTruthy()
    expect(panel!.textContent).toContain('加班小时')
    expect(container!.querySelector('[data-testid="attendance-import-recognition-warning"]')).toBeNull()

    findButton(findImportSection(container!), 'Load CSV').click()
    await flushUi(6)
    const payload = JSON.parse((setupState.importForm as { payload: string }).payload)
    expect(String(payload.csvText)).toContain('日期,工号,姓名,加班小时,自定义列')
    expect(String(payload.csvText)).toContain('2026-06-01,EMP001,张三,1,x')
  })
})
