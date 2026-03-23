import { nextTick } from 'vue'
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

function textResponse(status: number, text: string, contentType = 'text/plain'): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) => name.toLowerCase() === 'content-type' ? contentType : null,
    },
    json: async () => {
      throw new Error('Not JSON')
    },
    text: async () => text,
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

  it('downloads a CSV template from the server endpoint', async () => {
    const { workflow, downloadText, setStatus } = createWorkflow({
      apiFetch: vi.fn(async (input: string) => {
        expect(input).toBe('/api/attendance/import/template.csv')
        return textResponse(200, 'userId,workDate,firstInAt\nuser-1,2026-03-23,2026-03-23T09:00:00Z\n', 'text/csv')
      }),
    })

    await workflow.downloadImportTemplateCsv()

    expect(downloadText).toHaveBeenCalledWith(
      'attendance-import-template-attendance.csv',
      'userId,workDate,firstInAt\nuser-1,2026-03-23,2026-03-23T09:00:00Z\n',
      'text/csv;charset=utf-8',
    )
    expect(setStatus).toHaveBeenLastCalledWith('CSV template downloaded.', 'info', undefined)
  })

  it('falls back to the local template guide when the CSV endpoint is unavailable', async () => {
    const apiFetch = vi.fn(async (input: string) => {
      if (input === '/api/attendance/import/template.csv') {
        return jsonResponse(404, {
          ok: false,
          error: {
            code: 'NOT_FOUND',
            message: 'missing',
          },
        })
      }
      if (input === '/api/attendance/import/template') {
        return jsonResponse(200, {
          ok: true,
          data: {
            payloadExample: {
              source: 'dingtalk_csv',
              mode: 'merge',
              columns: ['userId', 'workDate', 'firstInAt'],
            },
            mappingProfiles: [],
          },
        })
      }
      throw new Error(`Unexpected request: ${input}`)
    })

    const { workflow, downloadText, setStatus } = createWorkflow({ apiFetch })

    await workflow.downloadImportTemplateCsv()

    expect(apiFetch).toHaveBeenNthCalledWith(
      1,
      '/api/attendance/import/template.csv',
      expect.objectContaining({
        headers: {
          Accept: 'text/csv',
        },
      }),
    )
    expect(apiFetch).toHaveBeenNthCalledWith(2, '/api/attendance/import/template')
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

  it('backfills group sync and user map controls from payload changes', async () => {
    const { workflow } = createWorkflow()
    const groupRuleSetId = '11111111-1111-1111-1111-111111111111'

    workflow.importForm.payload = JSON.stringify({
      source: 'manual',
      userMapKeyField: 'empNo',
      userMapSourceFields: ['工号', '姓名'],
      userMap: { empNo: { userId: 'u-1' } },
      groupSync: {
        autoCreate: true,
        autoAssignMembers: false,
        ruleSetId: groupRuleSetId,
        timezone: 'Asia/Shanghai',
      },
    })

    await nextTick()

    expect(workflow.importMode.value).toBe('override')
    expect(workflow.importUserMap.value).toEqual({ empNo: { userId: 'u-1' } })
    expect(workflow.importUserMapKeyField.value).toBe('empNo')
    expect(workflow.importUserMapSourceFields.value).toBe('工号, 姓名')
    expect(workflow.importGroupAutoCreate.value).toBe(true)
    expect(workflow.importGroupAutoAssign.value).toBe(false)
    expect(workflow.importGroupRuleSetId.value).toBe(groupRuleSetId)
    expect(workflow.importGroupTimezone.value).toBe('Asia/Shanghai')

    workflow.importForm.payload = JSON.stringify({
      source: 'manual',
    })

    await nextTick()

    expect(workflow.importUserMap.value).toBeNull()
    expect(workflow.importUserMapKeyField.value).toBe('')
    expect(workflow.importUserMapSourceFields.value).toBe('')
    expect(workflow.importGroupAutoCreate.value).toBe(false)
    expect(workflow.importGroupAutoAssign.value).toBe(false)
    expect(workflow.importGroupRuleSetId.value).toBe('')
    expect(workflow.importGroupTimezone.value).toBe('')
  })

  it('builds import payloads from the current UI controls and drops stale group sync data', async () => {
    const { workflow } = createWorkflow()
    const groupRuleSetId = '22222222-2222-2222-2222-222222222222'

    workflow.importForm.payload = JSON.stringify({
      source: 'manual',
      mode: 'merge',
      userMapKeyField: 'empNo',
      userMapSourceFields: ['工号', '姓名'],
      userMap: { empNo: { userId: 'u-1' } },
      groupSync: {
        autoCreate: true,
        autoAssignMembers: true,
        ruleSetId: groupRuleSetId,
        timezone: 'Asia/Shanghai',
      },
    })

    await nextTick()

    const initialPayload = workflow.buildImportPayload()
    expect(initialPayload).toMatchObject({
      source: 'manual',
      mode: 'merge',
      orgId: 'org-1',
      userId: 'user-1',
      userMapKeyField: 'empNo',
      userMapSourceFields: ['工号', '姓名'],
      userMap: { empNo: { userId: 'u-1' } },
      groupSync: {
        autoCreate: true,
        autoAssignMembers: true,
        ruleSetId: groupRuleSetId,
        timezone: 'Asia/Shanghai',
      },
    })

    workflow.importGroupAutoCreate.value = false
    workflow.importGroupAutoAssign.value = false
    workflow.importGroupRuleSetId.value = ''
    workflow.importGroupTimezone.value = ''
    workflow.importUserMap.value = null
    workflow.importUserMapKeyField.value = ''
    workflow.importUserMapSourceFields.value = ''

    const updatedPayload = workflow.buildImportPayload()
    expect(updatedPayload).toMatchObject({
      source: 'manual',
      mode: 'merge',
      orgId: 'org-1',
      userId: 'user-1',
    })
    expect(updatedPayload?.groupSync).toBeUndefined()
    expect(updatedPayload?.userMap).toBeUndefined()
    expect(updatedPayload?.userMapKeyField).toBeUndefined()
    expect(updatedPayload?.userMapSourceFields).toBeUndefined()
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
    expect(workflow.importPayloadRowCountHint.value).toBe(1)
    expect(workflow.importPreviewLane.value).toBe('sync')
    expect(workflow.importCommitLane.value).toBe('sync')
    expect(workflow.importPreviewLaneHint.value).toBe(
      'Preview will stay in one request because 1 rows are below the chunk threshold (10000).'
    )
    expect(workflow.importCommitLaneHint.value).toBe(
      'Import will stay synchronous because 1 rows are below the async threshold (50000).'
    )
    expect(setStatus).toHaveBeenCalledWith('CSV loaded: attendance.csv', 'info', undefined)
  })

  it('uploads a large CSV file and switches preview/import lanes to async', async () => {
    const file = new File(['userId,workDate\nu-1,2026-03-12\n'], 'attendance.csv', { type: 'text/csv' })
    const { workflow, apiFetch, setStatus } = createWorkflow({
      readImportDebugOptions: () => ({
        forceUploadCsv: true,
        forceAsyncImport: false,
        forceTimeoutOnce: false,
        pollIntervalMs: null,
        pollTimeoutMs: null,
      }),
      apiFetch: vi.fn(async (input: string) => {
        expect(input).toContain('/api/attendance/import/upload?')
        return jsonResponse(201, {
          ok: true,
          data: {
            fileId: 'csv-file-1',
            rowCount: 60000,
            bytes: 1024,
            expiresAt: '2026-03-12T10:00:00.000Z',
          },
        })
      }),
    })

    workflow.importForm.payload = JSON.stringify({ source: 'manual' }, null, 2)
    workflow.setImportCsvFile(file)

    await workflow.applyImportCsvFile()

    const payload = JSON.parse(workflow.importForm.payload)
    expect(apiFetch).toHaveBeenCalledTimes(1)
    expect(payload.csvFileId).toBe('csv-file-1')
    expect(payload.csvText).toBeUndefined()
    expect(workflow.importCsvFileId.value).toBe('csv-file-1')
    expect(workflow.importCsvFileRowCountHint.value).toBe(60000)
    expect(workflow.importCsvFileExpiresAt.value).toBe('2026-03-12T10:00:00.000Z')
    expect(workflow.importPayloadRowCountHint.value).toBe(60000)
    expect(workflow.importPreviewLane.value).toBe('async')
    expect(workflow.importCommitLane.value).toBe('async')
    expect(workflow.importPreviewLaneHint.value).toBe(
      'Preview will queue an async job because 60000 rows meet the async threshold (50000).'
    )
    expect(workflow.importCommitLaneHint.value).toBe(
      'Import will queue an async job because 60000 rows meet the async threshold (50000).'
    )
    expect(setStatus).toHaveBeenCalledWith('CSV uploaded: attendance.csv (60000 rows).', 'info', undefined)
  })

  it('marks large inline rows payloads as chunked preview while keeping sync commit below async threshold', () => {
    const { workflow } = createWorkflow({
      thresholds: {
        previewChunkThreshold: 10,
        previewChunkSize: 5,
        previewAsyncThreshold: 50,
        commitAsyncThreshold: 100,
      },
    })

    workflow.importForm.payload = JSON.stringify({
      source: 'manual',
      rows: Array.from({ length: 12 }, (_, index) => ({
        userId: `u-${index + 1}`,
        workDate: '2026-03-12',
      })),
    })

    expect(workflow.importPayloadRowCountHint.value).toBe(12)
    expect(workflow.importPreviewLane.value).toBe('chunked')
    expect(workflow.importCommitLane.value).toBe('sync')
    expect(workflow.importPreviewLaneHint.value).toBe(
      'Preview will split into about 3 chunks because 12 rows exceed the chunk threshold (10).'
    )
    expect(workflow.importCommitLaneHint.value).toBe(
      'Import will stay synchronous because 12 rows are below the async threshold (100).'
    )
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
