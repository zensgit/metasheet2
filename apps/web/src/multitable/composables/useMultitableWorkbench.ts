import { ref, computed, watch } from 'vue'
import type { MetaSheet, MetaField, MetaView, MetaCapabilities } from '../types'
import { MultitableApiClient, multitableClient } from '../api/client'

const SYSTEM_PEOPLE_SHEET_DESCRIPTION = '__metasheet_system:people__'
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

function filterVisibleSheets(sheets: MetaSheet[]): MetaSheet[] {
  return sheets.filter((sheet) => sheet.description !== SYSTEM_PEOPLE_SHEET_DESCRIPTION)
}

export function useMultitableWorkbench(opts?: {
  initialBaseId?: string
  initialSheetId?: string
  initialViewId?: string
  client?: MultitableApiClient
}) {
  const client = opts?.client ?? multitableClient

  const sheets = ref<MetaSheet[]>([])
  const fields = ref<MetaField[]>([])
  const views = ref<MetaView[]>([])

  const activeBaseId = ref(opts?.initialBaseId ?? '')
  const activeSheetId = ref(opts?.initialSheetId ?? '')
  const activeViewId = ref(opts?.initialViewId ?? '')
  const capabilities = ref<MetaCapabilities>({ ...EMPTY_CAPABILITIES })
  const loading = ref(false)
  const error = ref<string | null>(null)

  const activeView = computed<MetaView | null>(
    () => views.value.find((v) => v.id === activeViewId.value) ?? null,
  )

  function syncContextState(
    ctx: {
      base?: { id?: string | null } | null
      sheet?: MetaSheet | null
      sheets?: MetaSheet[]
      views?: MetaView[]
      capabilities?: MetaCapabilities
    },
    preferredViewId?: string | null,
  ) {
    sheets.value = filterVisibleSheets(ctx.sheets ?? sheets.value)
    views.value = ctx.views ?? []
    capabilities.value = ctx.capabilities ?? { ...EMPTY_CAPABILITIES }
    if (ctx.base?.id) activeBaseId.value = ctx.base.id
    if (ctx.sheet?.baseId) activeBaseId.value = ctx.sheet.baseId
    if (ctx.sheet?.id && ctx.sheet.description !== SYSTEM_PEOPLE_SHEET_DESCRIPTION) {
      activeSheetId.value = ctx.sheet.id
    } else if (!sheets.value.find((sheet) => sheet.id === activeSheetId.value)) {
      activeSheetId.value = sheets.value[0]?.id ?? ''
    }
    const requestedViewId = typeof preferredViewId === 'string' ? preferredViewId.trim() : ''
    if (requestedViewId && views.value.some((view) => view.id === requestedViewId)) {
      activeViewId.value = requestedViewId
    } else if (!views.value.find((view) => view.id === activeViewId.value)) {
      activeViewId.value = views.value[0]?.id ?? ''
    }
  }

  async function loadSheets() {
    loading.value = true
    error.value = null
    const hadActiveSheet = !!activeSheetId.value
    try {
      if (activeBaseId.value) {
        await loadBaseContext(activeBaseId.value, {
          sheetId: activeSheetId.value || undefined,
          viewId: activeViewId.value || undefined,
        })
        return
      }
      const data = await client.listSheets()
      sheets.value = filterVisibleSheets(data.sheets ?? [])
      if (!activeSheetId.value && sheets.value.length) {
        activeSheetId.value = sheets.value[0].id
      }
      const selectedSheet = sheets.value.find((sheet) => sheet.id === activeSheetId.value)
      if (selectedSheet?.baseId) activeBaseId.value = selectedSheet.baseId
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
      syncContextState(ctx, activeViewId.value)
    } catch (e: any) {
      error.value = e.message ?? 'Failed to load sheet metadata'
    }
  }

  async function loadBaseContext(baseId: string, opts?: { sheetId?: string; viewId?: string }) {
    if (!baseId) return
    loading.value = true
    error.value = null
    try {
      const ctx = await client.loadContext({
        baseId,
        sheetId: opts?.sheetId,
        viewId: opts?.viewId,
      })
      syncContextState(ctx, opts?.viewId)
      if (activeSheetId.value) {
        const fData = await client.listFields(activeSheetId.value)
        fields.value = fData.fields ?? []
      } else {
        fields.value = []
      }
    } catch (e: any) {
      error.value = e.message ?? 'Failed to load base metadata'
    } finally {
      loading.value = false
    }
  }

  function selectSheet(sheetId: string) {
    activeSheetId.value = sheetId
    const selectedSheet = sheets.value.find((sheet) => sheet.id === sheetId)
    if (selectedSheet?.baseId) activeBaseId.value = selectedSheet.baseId
    activeViewId.value = ''
  }

  function selectBase(baseId: string) {
    activeBaseId.value = baseId
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
    activeBaseId,
    activeSheetId,
    activeViewId,
    capabilities,
    activeView,
    loading,
    error,
    loadSheets,
    loadBaseContext,
    loadSheetMeta,
    selectBase,
    selectSheet,
    selectView,
  }
}
