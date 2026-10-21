import { ref, computed, toRaw, watch } from 'vue'
import { useLocale } from '../../composables/useLocale'
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
import { workbenchLabel } from '../utils/workbench-labels'

const SYSTEM_PEOPLE_SHEET_DESCRIPTION = '__metasheet_system:people__'
const EMPTY_CAPABILITIES: MetaCapabilities = {
  canRead: false,
  canCreateRecord: false,
  canEditRecord: false,
  canDeleteRecord: false,
  canManageFields: false,
  canManageSheetAccess: false,
  pitResetEnabled: false,
  sheetRevertEnabled: false,
  personalViewsEnabled: false,
  canManageViews: false,
  canComment: false,
  canManageAutomation: false,
  canExport: false,
  canSendNotification: false,
  canSubmitApproval: false,
}

function filterVisibleSheets(sheets: MetaSheet[]): MetaSheet[] {
  return sheets.filter((sheet) => sheet.description !== SYSTEM_PEOPLE_SHEET_DESCRIPTION)
}

// #5743: key-sorted stringify so two structurally identical meta payloads (or two snapshots of the
// workbench state) hash to the same string regardless of JSON key order. Inputs are server JSON and
// state derived from it — no cycles, functions or Dates to worry about.
// `undefined` gets its own token: JSON-parsed server answers can never produce one, but an injected
// client (tests, a future embed host) can, and `{x: null}` colliding with `{x: undefined}` would
// make the skip below swallow a real change.
function stableStringify(value: unknown): string {
  if (value === undefined) return 'undef'
  if (value === null) return 'null'
  if (typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`
}

export function useMultitableWorkbench(opts?: {
  initialBaseId?: string
  initialSheetId?: string
  initialViewId?: string
  client?: MultitableApiClient
}) {
  const client = opts?.client ?? multitableClient
  const { isZh } = useLocale()
  const fallback = (key: Parameters<typeof workbenchLabel>[0]) => workbenchLabel(key, isZh.value)

  const sheets = ref<MetaSheet[]>([])
  const fields = ref<MetaField[]>([])
  const views = ref<MetaView[]>([])
  // Slice 3: view ids the server reports as having a personal override for this actor (from /context).
  // Drives the FE "My view" toggle's initial state so it reflects the persisted server row, not local guesswork.
  const personalOverrideViewIds = ref<string[]>([])

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
  let contextLoadGeneration = 0

  // A newer load or a user selection owns the context, even if an older request finishes last.
  function currentContextRequest(generation = contextLoadGeneration): () => boolean {
    const baseId = activeBaseId.value
    const sheetId = activeSheetId.value
    const viewId = activeViewId.value
    return () => generation === contextLoadGeneration
      && baseId === activeBaseId.value && sheetId === activeSheetId.value && viewId === activeViewId.value
  }
  // #5743: the meta payload last APPLIED by loadSheetMeta, plus a fingerprint of the state that
  // apply produced. A reload whose payload AND whose still-current state both match is a no-op, so
  // the writes are skipped — otherwise every refresh hands fresh object identities to
  // sheets/views/fields/capabilities/permissions and re-runs every identity-keyed watcher
  // downstream (the manager-dialog keep-alive made that a per-tick cost, #5743).
  // The state half is what keeps this honest without touching the other writers (loadBaseContext /
  // loadSheets / restoreSnapshot / any caller assigning the refs directly): as soon as state
  // diverges from what this cache recorded, the skip cannot fire.
  let lastAppliedSheetMeta: { sheetId: string; viewId: string; payload: string; state: string } | null = null
  // #5750: the (baseId, sheetId, viewId) syncExternalContext was last ASKED for, together with the
  // active triple that request actually produced. An embedding host re-sends `mt:navigate` /
  // `external-context-result` on a timer, so the SAME request arrives once a second; without this
  // memo none of the guards below can recognise it, because the loaded CONTEXT -- not the caller --
  // decides the active triple (syncContextState overwrites activeBaseId with ctx.base.id /
  // ctx.sheet.baseId, and falls activeViewId back to views[0] when the requested view is not in
  // ctx.views), so the state can never equal what the caller asked for and every repeat refetches.
  // The recorded RESULT is what keeps this honest: any other writer (selectSheet / selectView /
  // selectBase / loadSheets / restoreSnapshot / a later sync) moves the active triple away and the
  // skip stops firing. FAILED syncs are deliberately NOT memoized -- a repeat is the only recovery
  // path for a transient error.
  let lastExternalContextSync: {
    baseId: string
    sheetId: string
    viewId: string
    resultBaseId: string
    resultSheetId: string
    resultViewId: string
  } | null = null
  // #5750 follow-up: the syncs currently IN FLIGHT. Each one keeps the FIRST context application
  // that lands while it runs -- which is its own, because one syncExternalContext applies state at
  // most once. Anything applied after that belongs to SOMEONE ELSE, and the memo above must never
  // record another writer's result as this request's: loadBaseContext applies the context and only
  // THEN awaits /fields, so a rail click (selectSheet -> loadSheetMeta) or a second overlapping
  // sync can move the active triple inside that window. Reading the live refs after the await would
  // then memoize (request = sheet A) -> (result = sheet B, which is on screen), and every later
  // repeat of that request would report success without ever navigating back to sheet A.
  const inFlightExternalSyncs = new Set<{ applied: { baseId: string; sheetId: string; viewId: string } | null }>()

  function noteContextApplication() {
    if (!inFlightExternalSyncs.size) return
    const applied = {
      baseId: activeBaseId.value,
      sheetId: activeSheetId.value,
      viewId: activeViewId.value,
    }
    for (const sync of inFlightExternalSyncs) {
      if (!sync.applied) sync.applied = applied
    }
  }

  // toRaw: these refs hold DEEP-reactive proxies, so walking them through the proxy traps costs
  // several times the raw walk and materialises a proxy for every nested object (option lists on a
  // wide sheet). The raw graph is the same content, and both the record pass and the compare pass
  // read it the same way, so the comparison is unaffected.
  function currentMetaStateFingerprint(): string {
    return stableStringify({
      activeBaseId: activeBaseId.value,
      activeSheetId: activeSheetId.value,
      activeViewId: activeViewId.value,
      sheets: toRaw(sheets.value),
      fields: toRaw(fields.value),
      views: toRaw(views.value),
      capabilities: toRaw(capabilities.value),
      capabilityOrigin: toRaw(capabilityOrigin.value),
      fieldPermissions: toRaw(fieldPermissions.value),
      viewPermissions: toRaw(viewPermissions.value),
      personalOverrideViewIds: toRaw(personalOverrideViewIds.value),
    })
  }

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
      personalOverrideViewIds?: string[]
    },
    preferredViewId?: string | null,
  ) {
    sheets.value = filterVisibleSheets(ctx.sheets ?? sheets.value)
    views.value = ctx.views ?? []
    personalOverrideViewIds.value = ctx.personalOverrideViewIds ?? []
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
    noteContextApplication()
  }

  async function loadSheets() {
    if (activeBaseId.value) {
      await loadBaseContext(activeBaseId.value, {
        sheetId: activeSheetId.value || undefined,
        viewId: activeViewId.value || undefined,
      })
      return
    }
    const generation = ++contextLoadGeneration
    const isCurrent = currentContextRequest(generation)
    loading.value = true
    error.value = null
    const hadActiveSheet = !!activeSheetId.value
    try {
      const data = await client.listSheets()
      if (!isCurrent()) return
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
      if (isCurrent()) error.value = e.message ?? fallback('error.loadSheets')
    } finally {
      if (generation === contextLoadGeneration) loading.value = false
    }
  }

  async function loadSheetMeta(sheetId: string, opts?: { viewId?: string }): Promise<boolean> {
    if (!sheetId) return false
    const generation = ++contextLoadGeneration
    const isCurrent = currentContextRequest(generation)
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
      if (!isCurrent()) return false
      // #5743: the requests always go out (callers reload precisely to SEE server-side changes),
      // but an unchanged answer must not churn the refs. Everything syncContextState reads goes
      // into the payload fingerprint. requestedViewId is NOT in it — it steers which view wins, so
      // it is compared separately in the guard below and must stay part of that guard.
      // #5750 narrows that "always go out" one layer UP, and only there: syncExternalContext skips
      // this call for an identical repeat of the request it last applied, so an embedding host's
      // timer re-send stops doubling as a schema poll. Every DIRECT caller of loadSheetMeta
      // (manager-dialog keep-alive, explicit refresh, sheet/view switches) still fetches.
      const payloadFingerprint = stableStringify({
        fields: fData.fields ?? [],
        base: ctx?.base ?? null,
        sheet: ctx?.sheet ?? null,
        sheets: ctx?.sheets ?? null,
        views: ctx?.views ?? null,
        capabilities: ctx?.capabilities ?? null,
        capabilityOrigin: ctx?.capabilityOrigin ?? null,
        fieldPermissions: ctx?.fieldPermissions ?? null,
        viewPermissions: ctx?.viewPermissions ?? null,
        personalOverrideViewIds: ctx?.personalOverrideViewIds ?? null,
      })
      if (
        lastAppliedSheetMeta
        && lastAppliedSheetMeta.sheetId === sheetId
        && lastAppliedSheetMeta.viewId === (requestedViewId ?? '')
        && lastAppliedSheetMeta.payload === payloadFingerprint
        && lastAppliedSheetMeta.state === currentMetaStateFingerprint()
      ) {
        noteContextApplication()
        return true
      }
      fields.value = fData.fields ?? []
      syncContextState(ctx, requestedViewId)
      lastAppliedSheetMeta = {
        sheetId,
        viewId: requestedViewId ?? '',
        payload: payloadFingerprint,
        state: currentMetaStateFingerprint(),
      }
      return true
    } catch (e: any) {
      if (isCurrent()) error.value = e.message ?? fallback('error.loadSheetMetadata')
      return false
    } finally {
      if (generation === contextLoadGeneration) loading.value = false
    }
  }

  async function loadBaseContext(baseId: string, opts?: { sheetId?: string; viewId?: string }): Promise<boolean> {
    if (!baseId) return false
    const generation = ++contextLoadGeneration
    const isCurrent = currentContextRequest(generation)
    loading.value = true
    error.value = null
    try {
      const ctx = await client.loadContext({
        baseId,
        sheetId: opts?.sheetId,
        viewId: opts?.viewId,
      })
      if (!isCurrent()) return false
      const visibleSheets = filterVisibleSheets(ctx.sheets ?? sheets.value)
      const sheetId = ctx.sheet?.id && ctx.sheet.description !== SYSTEM_PEOPLE_SHEET_DESCRIPTION
        ? ctx.sheet.id
        : visibleSheets.find((sheet) => sheet.id === activeSheetId.value)?.id ?? visibleSheets[0]?.id ?? ''
      const fData = sheetId ? await client.listFields(sheetId) : { fields: [] }
      if (!isCurrent()) return false
      syncContextState(ctx, opts?.viewId)
      fields.value = fData.fields ?? []
      return true
    } catch (e: any) {
      if (isCurrent()) error.value = e.message ?? fallback('error.loadBaseMetadata')
      return false
    } finally {
      if (generation === contextLoadGeneration) loading.value = false
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
    const pending = loadBaseContext(baseId, {
      sheetId: requestedSheetId || undefined,
      viewId: requestedViewId || undefined,
    })
    const isCurrent = currentContextRequest()
    const ok = await pending
    if (ok) return true
    if (!isCurrent()) return false
    const failureMessage = error.value
    restoreSnapshot(snapshot)
    error.value = failureMessage ?? fallback('error.loadBaseMetadata')
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

    // #5750: an identical repeat of the last SUCCESSFUL request, with nothing having moved the
    // workbench since -- the fetch would only re-derive the state that is already on screen.
    if (
      lastExternalContextSync
      && lastExternalContextSync.baseId === nextBaseId
      && lastExternalContextSync.sheetId === nextSheetId
      && lastExternalContextSync.viewId === nextViewId
      && lastExternalContextSync.resultBaseId === activeBaseId.value
      && lastExternalContextSync.resultSheetId === activeSheetId.value
      && lastExternalContextSync.resultViewId === activeViewId.value
    ) {
      return true
    }

    const inFlight: { applied: { baseId: string; sheetId: string; viewId: string } | null } = { applied: null }
    inFlightExternalSyncs.add(inFlight)
    let ok = false
    try {
      ok = await runExternalContextSync(nextBaseId, nextSheetId, nextViewId)
    } finally {
      inFlightExternalSyncs.delete(inFlight)
    }
    if (!ok) return false
    const applied = inFlight.applied
    // Memoize only THIS sync's own result, and only while it is still the state on screen. A null
    // `applied` means nothing was loaded (a guard in runExternalContextSync already recognised the
    // repeat, so there is no fetch to save); a mismatch means another writer moved the workbench
    // while this sync was awaiting, so the state on screen is not this request's result and must not
    // be recorded as one -- the repeat has to re-fetch, which is what carries the workbench back.
    if (
      applied
      && applied.baseId === activeBaseId.value
      && applied.sheetId === activeSheetId.value
      && applied.viewId === activeViewId.value
    ) {
      lastExternalContextSync = {
        baseId: nextBaseId,
        sheetId: nextSheetId,
        viewId: nextViewId,
        resultBaseId: applied.baseId,
        resultSheetId: applied.sheetId,
        resultViewId: applied.viewId,
      }
    }
    return true
  }

  async function runExternalContextSync(
    nextBaseId: string,
    nextSheetId: string,
    nextViewId: string,
  ): Promise<boolean> {
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
      loading.value = true
      const pending = loadSheetMeta(nextSheetId, { viewId: nextViewId || undefined })
      const isCurrent = currentContextRequest()
      const ok = await pending
      if (ok) return true
      if (!isCurrent()) return false
      const failureMessage = error.value
      restoreSnapshot(snapshot)
      error.value = failureMessage ?? fallback('error.loadSheetMetadata')
      return false
    }

    if (nextViewId && nextViewId !== activeViewId.value && activeSheetId.value) {
      const snapshot = snapshotState()
      loading.value = true
      const pending = loadSheetMeta(activeSheetId.value, { viewId: nextViewId })
      const isCurrent = currentContextRequest()
      const ok = await pending
      if (ok) return true
      if (!isCurrent()) return false
      const failureMessage = error.value
      restoreSnapshot(snapshot)
      error.value = failureMessage ?? fallback('error.loadSheetMetadata')
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
    personalOverrideViewIds,
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
