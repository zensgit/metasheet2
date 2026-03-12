import { computed, ref, watch } from 'vue'
import type { DeepLinkPreset } from './plmPanelModels'

type QueryPatch = Record<string, string | number | boolean | undefined>

type UsePlmDeepLinkStateOptions = {
  builtInPresets: DeepLinkPreset[]
  panelLabels: Record<string, string>
  syncQueryParams: (patch: QueryPatch) => void
  buildDeepLinkUrl: (panelOverride?: string) => string
  formatDeepLinkTargets: (panelOverride?: string) => string
  applyPresetParams?: (preset?: DeepLinkPreset | null) => void
  copyText: (value: string) => Promise<boolean>
  storageKey?: string
}

function sanitizePresetPanels(panels: unknown, panelLabels: Record<string, string>): string[] {
  if (!Array.isArray(panels)) return []
  const allowed = new Set(Object.keys(panelLabels).filter((entry) => entry !== 'all'))
  const normalized = panels
    .map((entry) => String(entry || '').trim().toLowerCase())
    .filter((entry) => entry && allowed.has(entry))
  return Array.from(new Set(normalized))
}

function loadStoredPresets(storageKey: string, panelLabels: Record<string, string>): DeepLinkPreset[] {
  if (typeof localStorage === 'undefined') {
    return []
  }
  try {
    const raw = localStorage.getItem(storageKey)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((entry) => {
        const key = String(entry?.key || '').trim()
        const label = String(entry?.label || '').trim()
        const panels = sanitizePresetPanels(entry?.panels, panelLabels)
        if (!key || !label || !panels.length) return null
        return { key, label, panels }
      })
      .filter(Boolean) as DeepLinkPreset[]
  } catch (_err) {
    return []
  }
}

function persistPresets(storageKey: string, presets: DeepLinkPreset[]) {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(storageKey, JSON.stringify(presets))
  } catch (_err) {
    // ignore storage errors
  }
}

export function usePlmDeepLinkState(options: UsePlmDeepLinkStateOptions) {
  const storageKey = options.storageKey || 'plm_deep_link_presets'

  const deepLinkStatus = ref('')
  const deepLinkError = ref('')
  const deepLinkScope = ref<string[]>([])
  const deepLinkPreset = ref('')
  const customPresetName = ref('')
  const editingPresetLabel = ref('')
  const importPresetText = ref('')
  const importFileInput = ref<HTMLInputElement | null>(null)
  const isPresetDropActive = ref(false)
  const customDeepLinkPresets = ref<DeepLinkPreset[]>(
    loadStoredPresets(storageKey, options.panelLabels),
  )

  const deepLinkPresets = computed<DeepLinkPreset[]>(() => [
    ...options.builtInPresets,
    ...customDeepLinkPresets.value,
  ])

  let deepLinkTimer: number | undefined
  let querySyncTimer: number | undefined
  let querySyncPending: QueryPatch = {}
  let applyingPreset = false
  let presetDropDepth = 0

  function cleanupDeepLinkState() {
    if (typeof window === 'undefined') return
    if (deepLinkTimer) {
      window.clearTimeout(deepLinkTimer)
      deepLinkTimer = undefined
    }
    if (querySyncTimer) {
      window.clearTimeout(querySyncTimer)
      querySyncTimer = undefined
      querySyncPending = {}
    }
  }

  function scheduleQuerySync(patch: QueryPatch) {
    querySyncPending = { ...querySyncPending, ...patch }
    if (typeof window === 'undefined') {
      options.syncQueryParams(querySyncPending)
      querySyncPending = {}
      return
    }
    if (querySyncTimer) {
      window.clearTimeout(querySyncTimer)
    }
    querySyncTimer = window.setTimeout(() => {
      options.syncQueryParams(querySyncPending)
      querySyncPending = {}
      querySyncTimer = undefined
    }, 250)
  }

  function setDeepLinkMessage(message: string, isError = false) {
    if (typeof window !== 'undefined' && deepLinkTimer) {
      window.clearTimeout(deepLinkTimer)
    }
    deepLinkStatus.value = isError ? '' : message
    deepLinkError.value = isError ? message : ''
    if (typeof window === 'undefined') return
    deepLinkTimer = window.setTimeout(() => {
      deepLinkStatus.value = ''
      deepLinkError.value = ''
    }, 4000)
  }

  function resetDeepLinkState() {
    deepLinkStatus.value = ''
    deepLinkError.value = ''
    deepLinkScope.value = []
    deepLinkPreset.value = ''
    customPresetName.value = ''
    editingPresetLabel.value = ''
    importPresetText.value = ''
    isPresetDropActive.value = false
  }

  function clearDeepLinkScope() {
    deepLinkScope.value = []
    deepLinkPreset.value = ''
    customPresetName.value = ''
  }

  function applyDeepLinkPreset() {
    if (!deepLinkPreset.value) {
      deepLinkScope.value = []
      return
    }
    const preset = deepLinkPresets.value.find((entry) => entry.key === deepLinkPreset.value)
    applyingPreset = true
    deepLinkScope.value = preset ? [...preset.panels] : []
    options.applyPresetParams?.(preset || null)
    if (typeof window === 'undefined') {
      applyingPreset = false
      return
    }
    window.setTimeout(() => {
      applyingPreset = false
    }, 0)
  }

  function saveDeepLinkPreset() {
    const name = customPresetName.value.trim()
    if (!name) {
      setDeepLinkMessage('请输入预设名称。', true)
      return
    }
    const panels = sanitizePresetPanels(deepLinkScope.value, options.panelLabels)
    if (!panels.length) {
      setDeepLinkMessage('请选择范围后再保存。', true)
      return
    }
    const preset = { key: `custom:${Date.now()}`, label: name, panels }
    customDeepLinkPresets.value = [...customDeepLinkPresets.value, preset]
    deepLinkPreset.value = preset.key
    applyDeepLinkPreset()
    customPresetName.value = ''
    editingPresetLabel.value = ''
    setDeepLinkMessage('已保存预设。')
  }

  function deleteDeepLinkPreset() {
    if (!deepLinkPreset.value.startsWith('custom:')) return
    customDeepLinkPresets.value = customDeepLinkPresets.value.filter(
      (preset) => preset.key !== deepLinkPreset.value,
    )
    deepLinkPreset.value = ''
    editingPresetLabel.value = ''
    setDeepLinkMessage('已删除预设。')
  }

  function applyPresetRename() {
    if (!deepLinkPreset.value.startsWith('custom:')) return
    const name = editingPresetLabel.value.trim()
    if (!name) {
      setDeepLinkMessage('预设名称不能为空。', true)
      return
    }
    customDeepLinkPresets.value = customDeepLinkPresets.value.map((preset) =>
      preset.key === deepLinkPreset.value ? { ...preset, label: name } : preset,
    )
    setDeepLinkMessage('已更新预设名称。')
  }

  function movePreset(direction: 'up' | 'down') {
    if (!deepLinkPreset.value.startsWith('custom:')) return
    const index = customDeepLinkPresets.value.findIndex((preset) => preset.key === deepLinkPreset.value)
    if (index < 0) return
    const nextIndex = direction === 'up' ? index - 1 : index + 1
    if (nextIndex < 0 || nextIndex >= customDeepLinkPresets.value.length) return
    const next = [...customDeepLinkPresets.value]
    const [current] = next.splice(index, 1)
    next.splice(nextIndex, 0, current)
    customDeepLinkPresets.value = next
  }

  function exportCustomPresets() {
    if (!customDeepLinkPresets.value.length) {
      setDeepLinkMessage('暂无可导出的自定义预设。', true)
      return
    }
    const payload = JSON.stringify(customDeepLinkPresets.value, null, 2)
    const blob = new Blob([payload], { type: 'application/json;charset=utf-8;' })
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = `plm-deep-link-presets-${Date.now()}.json`
    link.click()
    URL.revokeObjectURL(link.href)
    setDeepLinkMessage('已导出自定义预设。')
  }

  function mergeImportedPresets(entries: unknown[]): number {
    const existing = new Map(customDeepLinkPresets.value.map((entry) => [entry.key, entry]))
    let importedCount = 0
    for (const entry of entries) {
      const record = entry as Partial<DeepLinkPreset> | null | undefined
      const key = String(record?.key || '').trim()
      const label = String(record?.label || '').trim()
      const panels = sanitizePresetPanels(record?.panels, options.panelLabels)
      if (!key || !label || !panels.length) continue
      existing.set(key, { key, label, panels })
      importedCount += 1
    }
    customDeepLinkPresets.value = Array.from(existing.values())
    return importedCount
  }

  function importCustomPresetsFromText(raw: string) {
    const trimmed = raw.trim()
    if (!trimmed) {
      setDeepLinkMessage('请粘贴预设 JSON。', true)
      return
    }
    try {
      const parsed = JSON.parse(trimmed)
      if (!Array.isArray(parsed)) {
        setDeepLinkMessage('预设 JSON 需要是数组。', true)
        return
      }
      const importedCount = mergeImportedPresets(parsed)
      importPresetText.value = ''
      if (importedCount) {
        setDeepLinkMessage(`已导入 ${importedCount} 条预设。`)
      } else {
        setDeepLinkMessage('未发现可导入的预设。', true)
      }
    } catch (_err) {
      setDeepLinkMessage('预设 JSON 解析失败。', true)
    }
  }

  function importCustomPresets() {
    importCustomPresetsFromText(importPresetText.value)
  }

  function triggerPresetFileImport() {
    importFileInput.value?.click()
  }

  async function importPresetFile(file: File) {
    if (!file) return
    if (file.type && !file.type.includes('json') && !file.name.endsWith('.json')) {
      setDeepLinkMessage('仅支持 JSON 预设文件。', true)
      return
    }
    try {
      const text = await file.text()
      importCustomPresetsFromText(text)
    } catch (_err) {
      setDeepLinkMessage('读取预设文件失败。', true)
    }
  }

  async function handlePresetFileImport(event: Event) {
    const target = event.target as HTMLInputElement
    const file = target.files?.[0]
    if (!file) return
    await importPresetFile(file)
    target.value = ''
  }

  function handlePresetDragEnter(event: DragEvent) {
    event.preventDefault()
    presetDropDepth += 1
    isPresetDropActive.value = true
  }

  function handlePresetDragOver(event: DragEvent) {
    event.preventDefault()
  }

  function handlePresetDragLeave(event: DragEvent) {
    event.preventDefault()
    presetDropDepth = Math.max(0, presetDropDepth - 1)
    if (presetDropDepth === 0) {
      isPresetDropActive.value = false
    }
  }

  async function handlePresetDrop(event: DragEvent) {
    event.preventDefault()
    presetDropDepth = 0
    isPresetDropActive.value = false
    const file = event.dataTransfer?.files?.[0]
    if (!file) return
    await importPresetFile(file)
  }

  function parseDeepLinkPanels(value?: string): Set<string> {
    const allowed = new Set(Object.keys(options.panelLabels))
    if (!value) return new Set(['all'])
    const raw = value
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)
    const filtered = raw.filter((entry) => allowed.has(entry))
    return filtered.length ? new Set(filtered) : new Set(['all'])
  }

  function resolvePanelOverride(panel?: string): string | undefined {
    if (panel) return panel
    if (!deepLinkScope.value.length) return undefined
    const allowed = new Set(Object.keys(options.panelLabels))
    const selected = Array.from(new Set(deepLinkScope.value))
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry && entry !== 'all' && allowed.has(entry))
    return selected.length ? selected.join(',') : undefined
  }

  async function copyDeepLink(panel?: string) {
    const resolvedPanel = resolvePanelOverride(panel)
    const url = options.buildDeepLinkUrl(resolvedPanel)
    if (!url) {
      setDeepLinkMessage('当前页面无法生成深链接。', true)
      return
    }
    const ok = await options.copyText(url)
    if (!ok) {
      setDeepLinkMessage('复制失败，请手动复制地址栏链接。', true)
      return
    }
    setDeepLinkMessage(`已复制深链接（包含：${options.formatDeepLinkTargets(resolvedPanel)}）。`)
  }

  watch(
    customDeepLinkPresets,
    (value) => {
      persistPresets(storageKey, value)
    },
    { deep: true },
  )

  watch(
    deepLinkScope,
    () => {
      if (applyingPreset) return
      if (deepLinkPreset.value) {
        deepLinkPreset.value = ''
      }
    },
    { deep: true },
  )

  return {
    deepLinkStatus,
    deepLinkError,
    deepLinkScope,
    deepLinkPreset,
    customPresetName,
    editingPresetLabel,
    importPresetText,
    importFileInput,
    isPresetDropActive,
    customDeepLinkPresets,
    deepLinkPresets,
    scheduleQuerySync,
    setDeepLinkMessage,
    resetDeepLinkState,
    clearDeepLinkScope,
    applyDeepLinkPreset,
    saveDeepLinkPreset,
    deleteDeepLinkPreset,
    applyPresetRename,
    movePreset,
    exportCustomPresets,
    importCustomPresets,
    triggerPresetFileImport,
    handlePresetFileImport,
    handlePresetDragEnter,
    handlePresetDragOver,
    handlePresetDragLeave,
    handlePresetDrop,
    parseDeepLinkPanels,
    copyDeepLink,
    cleanupDeepLinkState,
  }
}
