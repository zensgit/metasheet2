import { ref, computed, watch } from 'vue'
import type { MetaSheet, MetaField, MetaView, MetaCapabilities } from '../types'
import { MultitableApiClient, multitableClient } from '../api/client'

const EMPTY_CAPABILITIES: MetaCapabilities = {
  canRead: false,
  canCreateRecord: false,
  canEditRecord: false,
  canDeleteRecord: false,
  canManageFields: false,
  canManageViews: false,
  canComment: false,
  canManageAutomation: false,
}

export function useMultitableWorkbench(opts?: {
  initialSheetId?: string
  initialViewId?: string
  client?: MultitableApiClient
}) {
  const client = opts?.client ?? multitableClient

  const sheets = ref<MetaSheet[]>([])
  const fields = ref<MetaField[]>([])
  const views = ref<MetaView[]>([])

  const activeSheetId = ref(opts?.initialSheetId ?? '')
  const activeViewId = ref(opts?.initialViewId ?? '')
  const capabilities = ref<MetaCapabilities>({ ...EMPTY_CAPABILITIES })
  const loading = ref(false)
  const error = ref<string | null>(null)

  const activeView = computed<MetaView | null>(
    () => views.value.find((v) => v.id === activeViewId.value) ?? null,
  )

  async function loadSheets() {
    loading.value = true
    error.value = null
    const hadActiveSheet = !!activeSheetId.value
    try {
      const data = await client.listSheets()
      sheets.value = data.sheets ?? []
      if (!activeSheetId.value && sheets.value.length) {
        activeSheetId.value = sheets.value[0].id
      }
      if (hadActiveSheet && activeSheetId.value) {
        await loadSheetMeta(activeSheetId.value)
      }
    } catch (e: any) {
      error.value = e.message ?? 'Failed to load sheets'
    } finally {
      loading.value = false
    }
  }

  async function loadSheetMeta(sheetId: string) {
    if (!sheetId) return
    error.value = null
    try {
      const [fData, ctx] = await Promise.all([
        client.listFields(sheetId),
        client.loadContext({
          sheetId,
          viewId: activeViewId.value || undefined,
        }),
      ])
      fields.value = fData.fields ?? []
      sheets.value = ctx.sheets ?? sheets.value
      views.value = ctx.views ?? []
      capabilities.value = ctx.capabilities ?? { ...EMPTY_CAPABILITIES }
      if (ctx.sheet?.id) {
        activeSheetId.value = ctx.sheet.id
      }
      if (!activeViewId.value && views.value.length) {
        activeViewId.value = views.value[0].id
      }
    } catch (e: any) {
      error.value = e.message ?? 'Failed to load sheet metadata'
    }
  }

  function selectSheet(sheetId: string) {
    activeSheetId.value = sheetId
    activeViewId.value = ''
  }

  function selectView(viewId: string) {
    activeViewId.value = viewId
  }

  watch(
    () => activeSheetId.value,
    (id) => { if (id) loadSheetMeta(id) },
    { immediate: false },
  )

  return {
    client,
    sheets,
    fields,
    views,
    activeSheetId,
    activeViewId,
    capabilities,
    activeView,
    loading,
    error,
    loadSheets,
    loadSheetMeta,
    selectSheet,
    selectView,
  }
}
