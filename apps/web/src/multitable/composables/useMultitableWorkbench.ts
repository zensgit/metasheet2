import { ref, computed, watch } from 'vue'
import type {
  MetaCapabilityOrigin,
  MetaCapabilities,
  MetaField,
  MetaFieldPermission,
  MetaSheet,
  MetaView,
  MetaViewPermission,
} from '../types'
import { MultitableApiClient, multitableClient } from '../api/client'

const SYSTEM_PEOPLE_SHEET_DESCRIPTION = '__metasheet_system:people__'
const EMPTY_CAPABILITIES: MetaCapabilities = {
  canRead: false,
  canCreateRecord: false,
  canEditRecord: false,
  canDeleteRecord: false,
  canManageFields: false,
  canManageSheetAccess: false,
  canManageViews: false,
  canComment: false,
  canManageAutomation: false,
  canExport: false,
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
  const capabilityOrigin = ref<MetaCapabilityOrigin | null>(null)
  const fieldPermissions = ref<Record<string, MetaFieldPermission>>({})
  const viewPermissions = ref<Record<string, MetaViewPermission>>({})
  const loading = ref(false)
  const error = ref<string | null>(null)
  const suppressedSheetMetaReloads = new Set<string>()

  const activeView = computed<MetaView | null>(
    () => views.value.find((v) => v.id === activeViewId.value) ?? null,
  )

  type WorkbenchSnapshot = {
    activeBaseId: string
    activeSheetId: string
    activeViewId: string
    sheets: MetaSheet[]
    fields: MetaField[]
    views: MetaView[]
    capabilities: MetaCapabilities
    capabilityOrigin: MetaCapabilityOrigin | null
    fieldPermissions: Record<string, MetaFieldPermission>
    viewPermissions: Record<string, MetaViewPermission>
  }

  function snapshotState(): WorkbenchSnapshot {
    return {
      activeBaseId: activeBaseId.value,
      activeSheetId: activeSheetId.value,
      activeViewId: activeViewId.value,
      sheets: [...sheets.value],
      fields: [...fields.value],
      views: [...views.value],
      capabilities: { ...capabilities.value },
      capabilityOrigin: capabilityOrigin.value ? { ...capabilityOrigin.value } : null,
      fieldPermissions: { ...fieldPermissions.value },
      viewPermissions: { ...viewPermissions.value },
    }
  }

  function restoreSnapshot(snapshot: WorkbenchSnapshot) {
    activeBaseId.value = snapshot.activeBaseId
    if (snapshot.activeSheetId && snapshot.activeSheetId !== activeSheetId.value) {
      suppressedSheetMetaReloads.add(snapshot.activeSheetId)
    }
    activeSheetId.value = snapshot.activeSheetId
    activeViewId.value = snapshot.activeViewId
    sheets.value = [...snapshot.sheets]
    fields.value = [...snapshot.fields]
    views.value = [...snapshot.views]
    capabilities.value = { ...snapshot.capabilities }
    capabilityOrigin.value = snapshot.capabilityOrigin ? { ...snapshot.capabilityOrigin } : null
    fieldPermissions.value = { ...snapshot.fieldPermissions }
    viewPermissions.value = { ...snapshot.viewPermissions }
  }

  function syncContextState(
    ctx: {
      base?: { id?: string | null } | null
      sheet?: MetaSheet | null
      sheets?: MetaSheet[]
      views?: MetaView[]
      capabilities?: MetaCapabilities
      capabilityOrigin?: MetaCapabilityOrigin | null
      fieldPermissions?: Record<string, MetaFieldPermission>
      viewPermissions?: Record<string, MetaViewPermission>
    },
    preferredViewId?: string | null,
  ) {
    sheets.value = filterVisibleSheets(ctx.sheets ?? sheets.value)
    views.value = ctx.views ?? []
    capabilities.value = ctx.capabilities ?? { ...EMPTY_CAPABILITIES }
    capabilityOrigin.value = ctx.capabilityOrigin ?? null
    fieldPermissions.value = ctx.fieldPermissions ?? {}
    viewPermissions.value = ctx.viewPermissions ?? {}
    if (ctx.base?.id) activeBaseId.value = ctx.base.id
    if (ctx.sheet?.baseId) activeBaseId.value = ctx.sheet.baseId
    if (ctx.sheet?.id && ctx.sheet.description !== SYSTEM_PEOPLE_SHEET_DESCRIPTION) {
      if (ctx.sheet.id !== activeSheetId.value) suppressedSheetMetaReloads.add(ctx.sheet.id)
      activeSheetId.value = ctx.sheet.id
    } else if (!sheets.value.find((sheet) => sheet.id === activeSheetId.value)) {
      const fallbackSheetId = sheets.value[0]?.id ?? ''
      if (fallbackSheetId && fallbackSheetId !== activeSheetId.value) suppressedSheetMetaReloads.add(fallbackSheetId)
      activeSheetId.value = fallbackSheetId
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

  async function loadSheetMeta(sheetId: string, opts?: { viewId?: string }): Promise<boolean> {
    if (!sheetId) return false
    error.value = null
    try {
      const requestedViewId = typeof opts?.viewId === 'string' && opts.viewId.trim()
        ? opts.viewId.trim()
        : activeViewId.value || undefined
      const [fData, ctx] = await Promise.all([
        client.listFields(sheetId),
        client.loadContext({
          sheetId,
          viewId: requestedViewId,
        }),
      ])
      fields.value = fData.fields ?? []
      syncContextState(ctx, requestedViewId)
      return true
    } catch (e: any) {
      error.value = e.message ?? 'Failed to load sheet metadata'
      return false
    }
  }

  async function loadBaseContext(baseId: string, opts?: { sheetId?: string; viewId?: string }): Promise<boolean> {
    if (!baseId) return false
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
      return true
    } catch (e: any) {
      error.value = e.message ?? 'Failed to load base metadata'
      return false
    } finally {
      loading.value = false
    }
  }

  async function switchBase(baseId: string, opts?: { sheetId?: string; viewId?: string }): Promise<boolean> {
    if (!baseId) return false
    const requestedSheetId = opts?.sheetId?.trim() ?? ''
    const requestedViewId = opts?.viewId?.trim() ?? ''
    if (
      baseId === activeBaseId.value &&
      (!requestedSheetId || requestedSheetId === activeSheetId.value) &&
      (!requestedViewId || requestedViewId === activeViewId.value)
    ) {
      return true
    }
    const snapshot = snapshotState()
    activeBaseId.value = baseId
    const ok = await loadBaseContext(baseId, {
      sheetId: requestedSheetId || undefined,
      viewId: requestedViewId || undefined,
    })
    if (ok) return true
    const failureMessage = error.value
    restoreSnapshot(snapshot)
    error.value = failureMessage ?? 'Failed to load base metadata'
    return false
  }

  async function syncExternalContext(params: {
    baseId?: string
    sheetId?: string
    viewId?: string
  }): Promise<boolean> {
    const nextBaseId = params.baseId?.trim() ?? ''
    const nextSheetId = params.sheetId?.trim() ?? ''
    const nextViewId = params.viewId?.trim() ?? ''

    if (nextBaseId) {
      return switchBase(nextBaseId, {
        sheetId: nextSheetId || undefined,
        viewId: nextViewId || undefined,
      })
    }

    if (nextSheetId) {
      if (
        nextSheetId === activeSheetId.value &&
        (!nextViewId || nextViewId === activeViewId.value)
      ) {
        return true
      }
      const snapshot = snapshotState()
      const ok = await loadSheetMeta(nextSheetId, { viewId: nextViewId || undefined })
      if (ok) return true
      const failureMessage = error.value
      restoreSnapshot(snapshot)
      error.value = failureMessage ?? 'Failed to load sheet metadata'
      return false
    }

    if (nextViewId && nextViewId !== activeViewId.value && activeSheetId.value) {
      const snapshot = snapshotState()
      const ok = await loadSheetMeta(activeSheetId.value, { viewId: nextViewId })
      if (ok) return true
      const failureMessage = error.value
      restoreSnapshot(snapshot)
      error.value = failureMessage ?? 'Failed to load sheet metadata'
      return false
    }

    return true
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
    (id) => {
      if (!id) return
      if (suppressedSheetMetaReloads.has(id)) {
        suppressedSheetMetaReloads.delete(id)
        return
      }
      void loadSheetMeta(id)
    },
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
    capabilityOrigin,
    fieldPermissions,
    viewPermissions,
    activeView,
    loading,
    error,
    loadSheets,
    loadBaseContext,
    loadSheetMeta,
    switchBase,
    syncExternalContext,
    selectBase,
    selectSheet,
    selectView,
  }
}
