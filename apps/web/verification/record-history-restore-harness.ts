import { createApp, defineComponent, h, ref } from 'vue'

import type { RestorePreviewResult } from '../src/multitable/api/client'
import MetaRecordInspector from '../src/multitable/components/MetaRecordInspector.vue'
import RestorePreviewDialog from '../src/multitable/components/RestorePreviewDialog.vue'
import type { MetaField, MetaRecord, MetaRecordRevision } from '../src/multitable/types'
import '../src/styles/tokens.css'

const SHEET_ID = 'sheet_history'
const RECORD_ID = 'rec_history'
const FIELD_ID = 'fld_title'

const fields = [
  { id: FIELD_ID, name: '标题', type: 'string', property: {} },
] as unknown as MetaField[]

function revision(
  version: number,
  value: string,
  overrides: Partial<MetaRecordRevision> = {},
): MetaRecordRevision {
  return {
    id: `rev_${version}`,
    sheetId: SHEET_ID,
    recordId: RECORD_ID,
    version,
    action: 'update',
    source: 'rest',
    actorId: 'user_history',
    actorName: '历史用户',
    changedFieldIds: [FIELD_ID],
    createdAt: `2026-08-30T00:00:0${version}.000Z`,
    patch: { [FIELD_ID]: value },
    snapshot: { [FIELD_ID]: value },
    ...overrides,
  } as unknown as MetaRecordRevision
}

createApp(defineComponent({
  setup() {
    const record = ref({
      id: RECORD_ID,
      version: 3,
      data: { [FIELD_ID]: '当前内容' },
    } as unknown as MetaRecord)
    const preview = ref<RestorePreviewResult | null>(null)
    const previewVisible = ref(false)
    const status = ref('ready')
    const calls = ref<string[]>([])
    let pendingRestore: {
      recordId: string
      targetVersion: number
      expectedVersion: number
      fieldIds?: string[]
    } | null = null

    const apiClient = {
      async listRecordHistory(sheetId: string, recordId: string) {
        calls.value.push(`history:${sheetId}:${recordId}:v${record.value.version}`)
        if (record.value.version === 4) {
          return [
            revision(4, '较早内容', { restoredFromVersion: 2 }),
            revision(3, '当前内容'),
            revision(2, '较早内容'),
          ]
        }
        return [
          revision(3, '当前内容'),
          revision(2, '较早内容'),
          revision(1, '初始内容', { action: 'create' }),
        ]
      },
      async getRecordSubscriptionStatus() {
        return { subscribed: false, subscription: null }
      },
      async restorePreviewRecord(
        sheetId: string,
        recordId: string,
        targetVersion: number,
        fieldIds?: string[],
      ): Promise<RestorePreviewResult> {
        calls.value.push(`preview:${sheetId}:${recordId}:v${targetVersion}:${fieldIds?.join(',') ?? 'all'}`)
        return {
          changes: [{ fieldId: FIELD_ID, op: 'set', value: '较早内容' }],
          visibleAffectedFieldCount: 1,
          schemaDrift: false,
          targetVersion,
          previewIdentity: 'preview_history',
        }
      },
      async restoreExecuteRecord(
        sheetId: string,
        recordId: string,
        targetVersion: number,
        expectedVersion: number,
        previewIdentity: string,
        fieldIds?: string[],
      ) {
        calls.value.push(`execute:${sheetId}:${recordId}:v${targetVersion}:expected${expectedVersion}:${previewIdentity}:${fieldIds?.join(',') ?? 'all'}`)
        return { recordId, newVersion: 4, noop: false, restoredFieldIds: [FIELD_ID] }
      },
    }

    async function requestRestore(payload: NonNullable<typeof pendingRestore>): Promise<void> {
      pendingRestore = payload
      status.value = 'previewing'
      preview.value = await apiClient.restorePreviewRecord(
        SHEET_ID,
        payload.recordId,
        payload.targetVersion,
        payload.fieldIds,
      )
      previewVisible.value = true
      status.value = 'preview-ready'
    }

    async function confirmRestore(): Promise<void> {
      const request = pendingRestore
      const currentPreview = preview.value
      if (!request || !currentPreview?.previewIdentity) return
      const result = await apiClient.restoreExecuteRecord(
        SHEET_ID,
        request.recordId,
        request.targetVersion,
        request.expectedVersion,
        currentPreview.previewIdentity,
        request.fieldIds,
      )
      record.value = {
        id: RECORD_ID,
        version: result.newVersion,
        data: { [FIELD_ID]: '较早内容' },
      } as unknown as MetaRecord
      previewVisible.value = false
      status.value = `restored-v${result.newVersion}`
    }

    return () => h('main', { style: 'padding:24px;max-width:960px;margin:0 auto' }, [
      h('h1', { style: 'font-size:20px;margin:0 0 12px' }, '记录历史恢复验收'),
      h('p', { 'data-test': 'restore-status' }, status.value),
      h('p', { 'data-test': 'record-value' }, String(record.value.data[FIELD_ID])),
      h('pre', { 'data-test': 'api-calls' }, calls.value.join('\n')),
      h(MetaRecordInspector, {
        visible: true,
        record: record.value,
        fields,
        canEdit: true,
        canComment: false,
        canDelete: false,
        sheetId: SHEET_ID,
        apiClient: apiClient as never,
        onRestore: requestRestore,
      }),
      h(RestorePreviewDialog, {
        visible: previewVisible.value,
        loading: status.value === 'previewing',
        changes: preview.value?.changes ?? [],
        schemaDrift: preview.value?.schemaDrift ?? false,
        executable: Boolean(preview.value?.previewIdentity),
        fieldName: (fieldId: string) => fields.find((field) => field.id === fieldId)?.name ?? fieldId,
        isZh: true,
        onConfirm: confirmRestore,
        onCancel: () => { previewVisible.value = false },
      }),
    ])
  },
})).mount('#app')
