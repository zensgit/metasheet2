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
    loadRecords,
    loadImportBatches,
    ...overrides,
  })

  return {
    workflow,
    apiFetch,
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
              { id: 'profile-a', name: 'DingTalk', source: 'dingtalk_csv' },
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
    expect(workflow.importMappingProfiles.value.map((item) => item.id)).toEqual(['profile-a'])
    expect(setStatus).toHaveBeenCalledWith('Import template loaded.', 'info', undefined)
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
