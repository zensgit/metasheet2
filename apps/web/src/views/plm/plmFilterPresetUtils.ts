import type { FilterPreset, PlmTeamFilterPreset } from './plmPanelModels'

export type FilterPresetFieldOption = {
  value: string
}

export type FilterPresetImportEntry = {
  key: string
  label: string
  field: string
  value: string
  group?: string
}

export type FilterPresetShareMode = 'merge' | 'replace'

type StorageReader = Pick<Storage, 'getItem'>
type StorageWriter = Pick<Storage, 'setItem'>

function getStorageReader(storage?: StorageReader | null): StorageReader | null {
  if (storage !== undefined) return storage
  return typeof localStorage !== 'undefined' ? localStorage : null
}

function getStorageWriter(storage?: StorageWriter | null): StorageWriter | null {
  if (storage !== undefined) return storage
  return typeof localStorage !== 'undefined' ? localStorage : null
}

export function createFilterPresetKey(prefix: string): string {
  return `${prefix}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`
}

export function upsertFilterPreset(
  presets: FilterPreset[],
  label: string,
  field: string,
  value: string,
  group: string,
  prefix: string,
): { presets: FilterPreset[]; key: string } {
  const trimmedLabel = label.trim()
  const trimmedValue = value.trim()
  const trimmedGroup = group.trim()
  if (!trimmedLabel || !trimmedValue) {
    return { presets, key: '' }
  }
  const existingIndex = presets.findIndex((preset) => preset.label === trimmedLabel)
  if (existingIndex >= 0) {
    const updated = { ...presets[existingIndex], field, value: trimmedValue, group: trimmedGroup }
    const next = [...presets]
    next[existingIndex] = updated
    return { presets: next, key: updated.key }
  }
  const key = createFilterPresetKey(prefix)
  return {
    presets: [...presets, { key, label: trimmedLabel, field, value: trimmedValue, group: trimmedGroup }],
    key,
  }
}

export function buildDuplicateFilterPresetLabel(
  presets: FilterPreset[],
  label: string,
): string {
  const trimmedLabel = label.trim()
  const labels = new Set(presets.map((preset) => preset.label))
  const base = `${trimmedLabel} 副本`
  if (!labels.has(base)) {
    return base
  }
  let index = 2
  while (labels.has(`${base} ${index}`)) {
    index += 1
  }
  return `${base} ${index}`
}

export function duplicateFilterPreset(
  presets: FilterPreset[],
  key: string,
  prefix: string,
): { presets: FilterPreset[]; preset: FilterPreset | null } {
  const source = applyFilterPreset(presets, key)
  if (!source) {
    return { presets, preset: null }
  }
  const duplicate: FilterPreset = {
    ...source,
    key: createFilterPresetKey(prefix),
    label: buildDuplicateFilterPresetLabel(presets, source.label),
  }
  return {
    presets: [...presets, duplicate],
    preset: duplicate,
  }
}

export function renameFilterPreset(
  presets: FilterPreset[],
  key: string,
  label: string,
): { presets: FilterPreset[]; preset: FilterPreset | null; error?: 'empty' | 'duplicate' } {
  const source = applyFilterPreset(presets, key)
  if (!source) {
    return { presets, preset: null }
  }
  const trimmedLabel = label.trim()
  if (!trimmedLabel) {
    return { presets, preset: source, error: 'empty' }
  }
  const conflict = presets.find((preset) => preset.key !== key && preset.label === trimmedLabel)
  if (conflict) {
    return { presets, preset: source, error: 'duplicate' }
  }
  if (trimmedLabel === source.label) {
    return { presets, preset: source }
  }
  const renamed = { ...source, label: trimmedLabel }
  return {
    presets: presets.map((preset) => (preset.key === key ? renamed : preset)),
    preset: renamed,
  }
}

export function applyFilterPreset(presets: FilterPreset[], key: string): FilterPreset | null {
  return presets.find((entry) => entry.key === key) || null
}

export function loadStoredFilterPresets(
  storageKey: string,
  storage?: StorageReader | null,
): FilterPreset[] {
  const reader = getStorageReader(storage)
  if (!reader) {
    return []
  }
  try {
    const raw = reader.getItem(storageKey)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((entry) => {
        const key = String(entry?.key || '').trim()
        const label = String(entry?.label || '').trim()
        const field = String(entry?.field || '').trim()
        const value = String(entry?.value || '').trim()
        const group = String(entry?.group || '').trim()
        if (!key || !label || !field || !value) return null
        return { key, label, field, value, group }
      })
      .filter(Boolean) as FilterPreset[]
  } catch (_err) {
    return []
  }
}

export function persistFilterPresets(
  storageKey: string,
  presets: FilterPreset[],
  storage?: StorageWriter | null,
) {
  const writer = getStorageWriter(storage)
  if (!writer) return
  try {
    writer.setItem(storageKey, JSON.stringify(presets))
  } catch (_err) {
    // ignore storage errors
  }
}

export function formatPresetLabelPreview(labels: string[]): string {
  if (!labels.length) return ''
  const sample = labels.slice(0, 3).join('、')
  return labels.length > 3 ? `${sample} 等` : sample
}

export function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  const base64 = btoa(binary)
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

export function decodeBase64Url(value: string): string | null {
  if (!value) return null
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const pad = normalized.length % 4
  const padded = pad ? normalized + '='.repeat(4 - pad) : normalized
  try {
    const binary = atob(padded)
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    return new TextDecoder().decode(bytes)
  } catch (_err) {
    return null
  }
}

export function encodeFilterPresetSharePayload(preset: FilterPreset): string {
  const payload = JSON.stringify({
    label: preset.label,
    field: preset.field,
    value: preset.value,
    group: preset.group || '',
  })
  return encodeBase64Url(payload)
}

export function decodeFilterPresetSharePayload(
  raw: string,
  fieldOptions: FilterPresetFieldOption[],
): FilterPresetImportEntry | null {
  const decoded = decodeBase64Url(raw)
  if (!decoded) return null
  try {
    const parsed = JSON.parse(decoded)
    if (!parsed || typeof parsed !== 'object') return null
    const record = parsed as Record<string, unknown>
    const label = String(record.label ?? '').trim()
    const value = String(record.value ?? '').trim()
    if (!label || !value) return null
    const rawField = String(record.field ?? '').trim()
    const allowedFields = new Set(fieldOptions.map((option) => option.value))
    const field = allowedFields.has(rawField) ? rawField : 'all'
    const group = String(record.group ?? '').trim()
    return { key: '', label, field, value, group }
  } catch (_err) {
    return null
  }
}

export function resolveFilterPresetShareMode(value?: string): FilterPresetShareMode {
  if (!value) return 'merge'
  return value.trim().toLowerCase() === 'replace' ? 'replace' : 'merge'
}

export function buildFilterPresetShareUrl(
  kind: 'bom' | 'where-used',
  preset: FilterPreset,
  mode: FilterPresetShareMode,
  basePath: string,
  origin?: string,
  routeContext?: {
    productId?: string | null
    itemNumber?: string | null
    itemType?: string | null
    whereUsedItemId?: string | null
  },
): string {
  const resolvedOrigin = origin ?? (typeof window !== 'undefined' ? window.location.origin : '')
  if (!resolvedOrigin) return ''
  const encoded = encodeFilterPresetSharePayload(preset)
  if (!encoded) return ''
  const base = `${resolvedOrigin}${basePath}`
  const params = new URLSearchParams()
  if (kind === 'bom') {
    params.set('panel', 'product')
    params.set('bomPresetShare', encoded)
    if (mode === 'replace') params.set('bomPresetShareMode', mode)
    if (routeContext?.productId) {
      params.set('productId', routeContext.productId)
    }
    if (routeContext?.itemNumber) {
      params.set('itemNumber', routeContext.itemNumber)
    }
    if (routeContext?.itemType) {
      params.set('itemType', routeContext.itemType)
    }
    if (routeContext?.productId || routeContext?.itemNumber) {
      params.set('autoload', 'true')
    }
  } else {
    params.set('panel', 'where-used')
    params.set('whereUsedPresetShare', encoded)
    if (mode === 'replace') params.set('whereUsedPresetShareMode', mode)
    if (routeContext?.productId) {
      params.set('productId', routeContext.productId)
    }
    if (routeContext?.itemNumber) {
      params.set('itemNumber', routeContext.itemNumber)
    }
    if (routeContext?.itemType) {
      params.set('itemType', routeContext.itemType)
    }
    if (routeContext?.whereUsedItemId) {
      params.set('whereUsedItemId', routeContext.whereUsedItemId)
    }
    if (routeContext?.whereUsedItemId || routeContext?.productId || routeContext?.itemNumber) {
      params.set('autoload', 'true')
    }
  }
  const query = params.toString()
  return query ? `${base}?${query}` : base
}

export function buildTeamFilterPresetShareUrl(
  kind: 'bom' | 'where-used',
  preset: PlmTeamFilterPreset,
  basePath: string,
  panel?: string,
  origin?: string,
  routeContext?: {
    productId?: string | null
    itemNumber?: string | null
    itemType?: string | null
    whereUsedItemId?: string | null
  },
): string {
  const resolvedOrigin = origin ?? (typeof window !== 'undefined' ? window.location.origin : '')
  if (!resolvedOrigin) return ''
  const base = `${resolvedOrigin}${basePath}`
  const params = new URLSearchParams()
  const normalizedPanel = kind === 'bom' && panel === 'bom' ? 'product' : panel

  if (normalizedPanel) {
    params.set('panel', normalizedPanel)
  }

  if (kind === 'bom') {
    params.set('bomTeamPreset', preset.id)
    params.set('bomFilter', preset.state.value)
    if (preset.state.field && preset.state.field !== 'all') {
      params.set('bomFilterField', preset.state.field)
    }
    if (routeContext?.productId) {
      params.set('productId', routeContext.productId)
    }
    if (routeContext?.itemNumber) {
      params.set('itemNumber', routeContext.itemNumber)
    }
    if (routeContext?.itemType) {
      params.set('itemType', routeContext.itemType)
    }
    if (routeContext?.productId || routeContext?.itemNumber) {
      params.set('autoload', 'true')
    }
  } else {
    params.set('whereUsedTeamPreset', preset.id)
    params.set('whereUsedFilter', preset.state.value)
    if (preset.state.field && preset.state.field !== 'all') {
      params.set('whereUsedFilterField', preset.state.field)
    }
    if (routeContext?.productId) {
      params.set('productId', routeContext.productId)
    }
    if (routeContext?.itemNumber) {
      params.set('itemNumber', routeContext.itemNumber)
    }
    if (routeContext?.itemType) {
      params.set('itemType', routeContext.itemType)
    }
    if (routeContext?.whereUsedItemId) {
      params.set('whereUsedItemId', routeContext.whereUsedItemId)
    }
    if (routeContext?.whereUsedItemId || routeContext?.productId || routeContext?.itemNumber) {
      params.set('autoload', 'true')
    }
  }

  const query = params.toString()
  return query ? `${base}?${query}` : base
}

export function resolveFilterPresetCatalogDraftState(input: {
  availablePresets: Array<Pick<FilterPreset, 'key'>>
  selectedPresetKey: string
  routePresetKey?: string
  nameDraft?: string
  groupDraft?: string
  selectionKeys?: string[]
  batchGroupDraft?: string
}) {
  const availablePresetKeys = new Set(
    input.availablePresets
      .map((preset) => preset.key.trim())
      .filter(Boolean),
  )
  const selectedPresetKey = input.selectedPresetKey.trim()
  const routePresetKey = String(input.routePresetKey || '').trim()
  const nextSelectedPresetKey = (
    selectedPresetKey && availablePresetKeys.has(selectedPresetKey)
      ? selectedPresetKey
      : ''
  )
  const nextRoutePresetKey = (
    routePresetKey && availablePresetKeys.has(routePresetKey)
      ? routePresetKey
      : ''
  )
  const nextSelectionKeys = Array.from(new Set(
    (input.selectionKeys || [])
      .map((key) => key.trim())
      .filter((key) => key && availablePresetKeys.has(key)),
  ))
  const shouldPreserveDrafts = Boolean(nextSelectedPresetKey)
  const shouldPreserveBatchGroup = nextSelectionKeys.length > 0

  return {
    nextSelectedPresetKey,
    nextRoutePresetKey,
    nextNameDraft: shouldPreserveDrafts ? input.nameDraft || '' : '',
    nextGroupDraft: shouldPreserveDrafts ? input.groupDraft || '' : '',
    nextSelectionKeys,
    nextBatchGroupDraft: shouldPreserveBatchGroup ? input.batchGroupDraft || '' : '',
  }
}

export function confirmFilterPresetImport(
  label: string,
  mode: FilterPresetShareMode,
  existingLabels: string[],
  conflictLabels: string[],
): boolean {
  if (typeof window === 'undefined') return true
  if (mode === 'replace' && existingLabels.length) {
    const sample = formatPresetLabelPreview(existingLabels)
    const hint = sample ? `（如：${sample}）` : ''
    return window.confirm(`将覆盖现有 ${existingLabels.length} 条${label}过滤预设${hint}，继续导入？`)
  }
  if (mode === 'merge' && conflictLabels.length) {
    const sample = formatPresetLabelPreview(conflictLabels)
    const hint = sample ? `（如：${sample}）` : ''
    return window.confirm(`检测到 ${conflictLabels.length} 条同名${label}过滤预设${hint}，将覆盖现有预设。是否继续？`)
  }
  return true
}

export function parseFilterPresetImport(
  raw: string,
  fieldOptions: FilterPresetFieldOption[],
): {
  entries: FilterPresetImportEntry[]
  skippedInvalid: number
  skippedMissing: number
  duplicateCount: number
} {
  const allowedFields = new Set(fieldOptions.map((option) => option.value))
  const map = new Map<string, FilterPresetImportEntry>()
  let skippedInvalid = 0
  let skippedMissing = 0
  let validCount = 0
  const parsed = JSON.parse(raw)
  if (!Array.isArray(parsed)) {
    throw new Error('not-array')
  }
  for (const entry of parsed) {
    const isObject = entry && typeof entry === 'object'
    if (!isObject) {
      skippedInvalid += 1
      continue
    }
    const record = entry as Record<string, unknown>
    const label = String(record.label ?? '').trim()
    const value = String(record.value ?? '').trim()
    if (!label || !value) {
      skippedMissing += 1
      continue
    }
    const rawField = String(record.field ?? '').trim()
    const field = allowedFields.has(rawField) ? rawField : 'all'
    const key = String(record.key ?? '').trim()
    const group = String(record.group ?? '').trim()
    validCount += 1
    map.set(label, { key, label, field, value, group })
  }
  return {
    entries: Array.from(map.values()),
    skippedInvalid,
    skippedMissing,
    duplicateCount: Math.max(0, validCount - map.size),
  }
}

export function mergeImportedFilterPresets(
  entries: FilterPresetImportEntry[],
  presets: FilterPreset[],
  prefix: string,
  mode: FilterPresetShareMode,
): { presets: FilterPreset[]; added: number; updated: number } {
  const next = mode === 'replace' ? [] : [...presets]
  const usedKeys = new Set(next.map((preset) => preset.key))
  let added = 0
  let updated = 0
  const ensureKey = (rawKey: string): string => {
    let key = rawKey || createFilterPresetKey(prefix)
    while (usedKeys.has(key)) {
      key = createFilterPresetKey(prefix)
    }
    usedKeys.add(key)
    return key
  }
  for (const entry of entries) {
    const label = entry.label
    const value = entry.value
    const field = entry.field
    const group = String(entry.group || '').trim()
    const rawKey = entry.key
    const existingIndex = next.findIndex((preset) => preset.label === label)
    if (existingIndex >= 0) {
      next[existingIndex] = { ...next[existingIndex], field, value, group }
      updated += 1
      continue
    }
    next.push({ key: ensureKey(rawKey), label, field, value, group })
    added += 1
  }
  return { presets: next, added, updated }
}

export function exportFilterPresetsFile(
  presets: FilterPreset[],
  filenamePrefix: string,
  documentRef?: Document,
  urlRef?: Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'>,
): boolean {
  if (!presets.length) return false
  const doc = documentRef ?? (typeof document !== 'undefined' ? document : undefined)
  const urlApi = urlRef ?? (typeof URL !== 'undefined' ? URL : undefined)
  if (!doc || !urlApi) return false
  const payload = JSON.stringify(presets, null, 2)
  const blob = new Blob([payload], { type: 'application/json;charset=utf-8;' })
  const link = doc.createElement('a')
  link.href = urlApi.createObjectURL(blob)
  link.download = `${filenamePrefix}-${Date.now()}.json`
  link.click()
  urlApi.revokeObjectURL(link.href)
  return true
}
