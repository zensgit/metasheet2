import { describe, expect, it, vi } from 'vitest'
import { useAttendanceAdminImportWorkflow } from '../src/views/attendance/useAttendanceAdminImportWorkflow'

const tr = (en: string, _zh: string) => en

function jsonResponse(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as unknown as Response
}

function createWorkflow(overrides: Parameters<typeof useAttendanceAdminImportWorkflow>[0] = {}) {
  const setStatus = overrides.setStatus ?? vi.fn()
  const setStatusFromError = overrides.setStatusFromError ?? vi.fn()
  const loadRecords = overrides.loadRecords ?? vi.fn(async () => undefined)
  const loadImportBatches = overrides.loadImportBatches ?? vi.fn(async () => undefined)
  const downloadText = overrides.downloadText ?? vi.fn()
  const apiFetch = overrides.apiFetch ?? vi.fn(async () => {
    throw new Error('Unexpected request')
  })

  const workflow = useAttendanceAdminImportWorkflow({
    tr,
    defaultTimezone: 'Asia/Shanghai',
    getOrgId: () => 'org-1',
    getUserId: () => 'user-1',
    readImportDebugOptions: () => ({
      forceUploadCsv: false,
      forceAsyncImport: false,
      forceTimeoutOnce: false,
      pollIntervalMs: null,
      pollTimeoutMs: null,
    }),
    apiFetch,
    setStatus,
    setStatusFromError,
    downloadText,
    loadRecords,
    loadImportBatches,
    ...overrides,
  })

  return {
    workflow,
    apiFetch,
    downloadText,
    loadImportBatches,
    loadRecords,
    setStatus,
    setStatusFromError,
  }
}

describe('useAttendanceAdminImportWorkflow', () => {
  it('loads template and seeds payload, mode, and mapping profiles', async () => {
    const { workflow, apiFetch, setStatus } = createWorkflow({
      apiFetch: vi.fn(async (input: string) => {
        expect(input).toBe('/api/attendance/import/template')
        return jsonResponse(200, {
          ok: true,
          data: {
            payloadExample: {
              source: 'dingtalk_csv',
              mode: 'merge',
              columns: ['userId'],
            },
            mappingProfiles: [
              {
                id: 'profile-a',
                name: 'DingTalk',
                source: 'dingtalk_csv',
                description: 'Maps DingTalk CSV headers to attendance fields.',
                requiredFields: ['userId', 'workDate'],
                userMapKeyField: 'empNo',
                userMapSourceFields: ['工号', '姓名'],
                mapping: {
                  userId: '工号',
                  workDate: '日期',
                },
              },
            ],
          },
        })
      }),
    })

    await workflow.loadImportTemplate()

    expect(apiFetch).toHaveBeenCalledTimes(1)
    expect(workflow.importMode.value).toBe('merge')
    expect(JSON.parse(workflow.importForm.payload)).toEqual({
      source: 'dingtalk_csv',
      mode: 'merge',
      columns: ['userId'],
    })
    expect(workflow.importTemplateGuide.value).toEqual({
      source: 'dingtalk_csv',
      mode: 'merge',
      columns: ['userId'],
      requiredFields: [],
      sampleHeader: 'userId',
      fieldGuides: [
        { field: 'source', meaningEn: 'Import source that selects the parser and mapping path.', meaningZh: '导入来源，用于选择解析器和映射路径。' },
        { field: 'mode', meaningEn: 'Import behavior. override replaces matching user/date rows; merge keeps existing values when new fields are missing.', meaningZh: '导入行为。override 会覆盖同用户同日期记录；merge 在缺少新字段时保留已有值。' },
        { field: 'columns', meaningEn: 'Source column names or column definitions used by the template.', meaningZh: '模板使用的源列名或列定义。' },
      ],
    })
    expect(workflow.importMappingProfiles.value.map((item) => item.id)).toEqual(['profile-a'])
    expect(setStatus).toHaveBeenCalledWith('Import template loaded.', 'info', undefined)
  })

  it('downloads a CSV template using the loaded template guide', async () => {
    const { workflow, downloadText, setStatus } = createWorkflow({
      apiFetch: vi.fn(async () => jsonResponse(200, {
        ok: true,
        data: {
          payloadExample: {
            source: 'dingtalk_csv',
            mode: 'merge',
            columns: ['userId', 'workDate', 'firstInAt'],
          },
          mappingProfiles: [],
        },
      })),
    })

    await workflow.downloadImportTemplateCsv()

    expect(downloadText).toHaveBeenCalledWith(
      'attendance-import-template-dingtalk_csv.csv',
      'userId,workDate,firstInAt\n,,\n',
      'text/csv;charset=utf-8',
    )
    expect(setStatus).toHaveBeenLastCalledWith('CSV template downloaded.', 'info', undefined)
  })

  it('builds a selected profile guide with readable field meanings', async () => {
    const { workflow } = createWorkflow({
      apiFetch: vi.fn(async () => jsonResponse(200, {
        ok: true,
        data: {
          payloadExample: {
            source: 'dingtalk_csv',
            mode: 'override',
            columns: ['userId', 'workDate', 'firstInAt'],
          },
          mappingProfiles: [
            {
              id: 'profile-a',
              name: 'DingTalk',
              source: 'dingtalk_csv',
              description: 'Maps DingTalk CSV headers to attendance fields.',
              requiredFields: ['userId', 'workDate'],
              userMapKeyField: 'empNo',
              userMapSourceFields: ['工号', '姓名'],
              mapping: {
                userId: '工号',
                workDate: '日期',
                firstInAt: '上班打卡',
              },
            },
          ],
        },
      })),
    })

    await workflow.loadImportTemplate()
    workflow.importProfileId.value = 'profile-a'

    expect(workflow.selectedImportProfileGuide.value).toEqual({
      name: 'DingTalk',
      description: 'Maps DingTalk CSV headers to attendance fields.',
      requiredFields: ['userId', 'workDate'],
      userMapKeyField: 'empNo',
      userMapSourceFields: ['工号', '姓名'],
      mappingEntries: [
        {
          field: 'userId',
          targetField: 'userId',
          sourceField: '工号',
          meaningEn: 'Target attendance user ID.',
          meaningZh: '考勤目标用户 ID。',
        },
        {
          field: 'workDate',
          targetField: 'workDate',
          sourceField: '日期',
          meaningEn: 'Attendance date for the imported record.',
          meaningZh: '导入记录对应的考勤日期。',
        },
        {
          field: 'firstInAt',
          targetField: 'firstInAt',
          sourceField: '上班打卡',
          meaningEn: 'First clock-in timestamp for the day.',
          meaningZh: '当天第一次打卡时间。',
        },
      ],
    })
  })

  it('applies the selected mapping profile into the payload', () => {
    const { workflow, setStatus } = createWorkflow()

    workflow.importForm.payload = JSON.stringify({}, null, 2)
    workflow.importMappingProfiles.value = [
      {
        id: 'profile-a',
        name: 'DingTalk',
        source: 'dingtalk_csv',
        mapping: { userId: '工号', inAt: '上班打卡' },
      },
    ]
    workflow.importProfileId.value = 'profile-a'
    workflow.importMode.value = 'merge'

    workflow.applyImportProfile()

    expect(JSON.parse(workflow.importForm.payload)).toEqual({
      mappingProfileId: 'profile-a',
      mapping: { userId: '工号', inAt: '上班打卡' },
      mode: 'merge',
      source: 'dingtalk_csv',
    })
    expect(setStatus).toHaveBeenCalledWith('Applied mapping profile: DingTalk', 'info', undefined)
  })

  it('loads a small CSV via local file text and writes csvText into payload', async () => {
    const readFileText = vi.fn(async () => 'userId,workDate\nu-1,2026-03-12\n')
    const { workflow, apiFetch, setStatus } = createWorkflow({ readFileText })
    const file = new File(['userId,workDate\nu-1,2026-03-12\n'], 'attendance.csv', { type: 'text/csv' })

    workflow.importForm.payload = JSON.stringify({ source: 'manual' }, null, 2)
    workflow.importMode.value = 'override'
    workflow.setImportCsvFile(file)

    await workflow.applyImportCsvFile()

    const payload = JSON.parse(workflow.importForm.payload)
    expect(apiFetch).not.toHaveBeenCalled()
    expect(readFileText).toHaveBeenCalledWith(file)
    expect(payload.orgId).toBe('org-1')
    expect(payload.csvText).toBe('userId,workDate\nu-1,2026-03-12\n')
    expect(payload.source).toBe('manual')
    expect(payload.mode).toBe('override')
    expect(payload.csvFileId).toBeUndefined()
    expect(setStatus).toHaveBeenCalledWith('CSV loaded: attendance.csv', 'info', undefined)
  })

  it('clears stale preview state and reports through setStatusFromError on preview failure', async () => {
    const setStatusFromError = vi.fn()
    const { workflow } = createWorkflow({
      setStatusFromError,
      apiFetch: vi.fn(async (input: string) => {
        if (input === '/api/attendance/import/prepare') {
          return jsonResponse(200, {
            ok: true,
            data: { commitToken: 'token-1', expiresAt: '2026-03-12T01:00:00.000Z' },
          })
        }
        if (input === '/api/attendance/import/preview') {
          return jsonResponse(500, {
            ok: false,
            error: { code: 'PREVIEW_FAILED', message: 'preview failed hard' },
          })
        }
        throw new Error(`Unexpected request: ${input}`)
      }),
    })

    workflow.importForm.payload = JSON.stringify({
      source: 'manual',
      rows: [{ userId: 'u-1', workDate: '2026-03-12' }],
    })
    workflow.importPreview.value = [
      {
        userId: 'stale-user',
        workDate: '2026-03-10',
        workMinutes: 480,
        lateMinutes: 0,
        earlyLeaveMinutes: 0,
        status: 'normal',
      },
    ]
    workflow.importCsvWarnings.value = ['stale warning']

    await workflow.previewImport()

    expect(workflow.importPreview.value).toEqual([])
    expect(workflow.importCsvWarnings.value).toEqual([])
    expect(workflow.importPreviewTask.value?.status).toBe('failed')
    expect(setStatusFromError).toHaveBeenCalledTimes(1)
    expect(setStatusFromError.mock.calls[0]?.[1]).toBe('Failed to preview import')
    expect(setStatusFromError.mock.calls[0]?.[2]).toBe('import-preview')
  })

  it.each([
    {
      name: 'preview invalid JSON',
      invoke: async (workflow: ReturnType<typeof useAttendanceAdminImportWorkflow>) => workflow.previewImport(),
      expectedMeta: {
        context: 'import-preview',
        hint: 'Fix JSON syntax in payload and retry preview.',
        action: 'retry-preview-import',
      },
    },
    {
      name: 'run invalid JSON',
      invoke: async (workflow: ReturnType<typeof useAttendanceAdminImportWorkflow>) => workflow.runImport(),
      expectedMeta: {
        context: 'import-run',
        hint: 'Fix JSON syntax in payload and retry import.',
        action: 'retry-run-import',
      },
    },
  ])('reports retry metadata for $name', async ({ invoke, expectedMeta }) => {
    const { workflow, apiFetch, setStatus } = createWorkflow()

    workflow.importForm.payload = '{'

    await invoke(workflow)

    expect(apiFetch).not.toHaveBeenCalled()
    expect(setStatus).toHaveBeenCalledWith(
      'Invalid JSON payload for import.',
      'error',
      expectedMeta,
    )
  })

  it('refreshes records and batches after a successful import commit', async () => {
    const loadRecords = vi.fn(async () => undefined)
    const loadImportBatches = vi.fn(async () => undefined)
    const { workflow, apiFetch, setStatus } = createWorkflow({
      loadRecords,
      loadImportBatches,
      apiFetch: vi.fn(async (input: string, init?: RequestInit) => {
        const url = String(input)
        if (url === '/api/attendance/import/prepare') {
          return jsonResponse(200, {
            ok: true,
            data: { commitToken: 'token-1', expiresAt: '2026-03-12T01:00:00.000Z' },
          })
        }
        if (url === '/api/attendance/import/commit' && init?.method === 'POST') {
          return jsonResponse(200, {
            ok: true,
            data: {
              imported: 2,
              processedRows: 2,
              failedRows: 0,
              meta: { groupCreated: 0, groupMembersAdded: 0 },
            },
          })
        }
        throw new Error(`Unexpected request: ${url}`)
      }),
    })

    workflow.importForm.payload = JSON.stringify({
      source: 'manual',
      rows: [
        { userId: 'u-1', workDate: '2026-03-11' },
        { userId: 'u-2', workDate: '2026-03-12' },
      ],
    })

    await workflow.runImport()

    expect(apiFetch).toHaveBeenCalledTimes(2)
    expect(loadRecords).toHaveBeenCalledTimes(1)
    expect(loadImportBatches).toHaveBeenCalledWith({ orgId: 'org-1' })
    expect(workflow.importCommitToken.value).toBe('')
    expect(workflow.importCommitTokenExpiresAt.value).toBe('')
    expect(setStatus).toHaveBeenCalledWith('Imported 2 rows. (processed=2, failed=0, elapsedMs=0)', 'info', undefined)
  })
})
