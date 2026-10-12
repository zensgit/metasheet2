import { computed, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'
import type { MetaField, MetaRecord } from '../types'
import {
  parseClipboardMatrix, planRangeFill, planRangePaste, rangeContains, rangeFromPoints,
  serializeClipboardMatrix, cloneRangeValue, type CellPoint, type CellRange, type FillMode, type RangeChange,
} from '../utils/grid-range-fill'

interface Options {
  root: Ref<HTMLElement | null>
  enabled: () => boolean
  editing: () => boolean
  rows: () => MetaRecord[]
  fields: () => MetaField[]
  contextKey: () => string
  policyKey: () => string
  canWrite: (recordId: string, field: MetaField) => boolean
  commit: (changes: RangeChange[]) => Promise<unknown>
  focus: (point: CellPoint) => void
}

type Drag = { kind: 'select'; signature: string }
  | { kind: 'fill'; source: CellRange; mode: FillMode; signature: string; rows: MetaRecord[] }

export function useGridRangeSelection(options: Options) {
  const anchor = ref<CellPoint | null>(null)
  const end = ref<CellPoint | null>(null)
  const preview = ref<CellRange | null>(null)
  const mode = ref<FillMode>('copy')
  const busy = ref(false)
  const status = ref('')
  const enabled = computed(options.enabled)
  const selection = computed(() => anchor.value && end.value ? rangeFromPoints(anchor.value, end.value) : null)
  const signature = computed(() => !enabled.value ? 'disabled' : JSON.stringify([
    options.contextKey(), options.policyKey(),
    options.rows().map(row => [row.id, row.version, row.locked]), options.fields(),
  ]))
  let drag: Drag | null = null
  let generation = 0

  function clear() {
    generation++
    drag = null
    anchor.value = end.value = null
    preview.value = null
  }
  watch(signature, () => {
    if (drag || busy.value) status.value = 'STALE'
    clear()
  }, { flush: 'sync' })
  watch(options.editing, editing => { if (editing) clear() })

  function valid(point: CellPoint) {
    return point.row >= 0 && point.col >= 0 && point.row < options.rows().length && point.col < options.fields().length
  }
  function snapshotRows() {
    return options.rows().map(row => ({ ...row, data: Object.fromEntries(
      Object.entries(row.data).map(([fieldId, value]) => [fieldId, cloneRangeValue(value)]),
    ) }))
  }
  function select(point: CellPoint, extend = false) {
    if (!enabled.value || busy.value || options.editing() || !valid(point)) return
    generation++
    if (!extend || !anchor.value) anchor.value = { ...point }
    end.value = { ...point }
    status.value = ''
  }
  function pointerDown(event: MouseEvent, row: number, col: number) {
    if (!enabled.value || busy.value || options.editing() || event.button !== 0) return
    if (event.target instanceof Element && event.target.closest('button, input, select, textarea, a, [contenteditable="true"]')) return
    event.preventDefault()
    const point = { row, col }
    select(point, event.shiftKey)
    options.focus(point)
    options.root.value?.focus({ preventScroll: true })
    if (selection.value) drag = { kind: 'select', signature: signature.value }
  }
  function startFill(event: MouseEvent) {
    if (!enabled.value || busy.value || options.editing() || event.button !== 0 || !selection.value) return
    event.preventDefault()
    generation++
    drag = { kind: 'fill', source: { ...selection.value }, mode: mode.value, signature: signature.value, rows: snapshotRows() }
    preview.value = { ...selection.value }
    status.value = ''
    options.root.value?.focus({ preventScroll: true })
  }
  function fillTarget(source: CellRange, point: CellPoint): CellRange {
    const vertical = Math.max(source.top - point.row, point.row - source.bottom, 0)
    const horizontal = Math.max(source.left - point.col, point.col - source.right, 0)
    return vertical >= horizontal
      ? { ...source, top: Math.min(source.top, point.row), bottom: Math.max(source.bottom, point.row) }
      : { ...source, left: Math.min(source.left, point.col), right: Math.max(source.right, point.col) }
  }
  function pointerEnter(row: number, col: number) {
    if (!drag || !valid({ row, col })) return
    if (drag.kind === 'select') end.value = { row, col }
    else preview.value = fillTarget(drag.source, { row, col })
  }
  function reportError(error: unknown) {
    const code = error && typeof error === 'object' && 'code' in error
      ? String(error.code) : error instanceof Error ? error.message : ''
    status.value = ['INVALID_RANGE', 'TOO_LARGE', 'INVALID_CLIPBOARD', 'OUT_OF_BOUNDS', 'READ_ONLY',
      'INVALID_VALUE', 'INCOMPATIBLE_TYPE', 'INVALID_SERIES', 'RANGE_STALE', 'RANGE_READ_ONLY', 'RANGE_BUSY'].includes(code)
      ? code : 'FAILED'
  }
  async function commit(changes: RangeChange[], context: string) {
    if (!changes.length) return
    try {
      await options.commit(changes)
    } catch (error) {
      // The write succeeded but its read-back failed. Do not invite replaying an already saved batch.
      if (error instanceof Error && error.message === 'RANGE_REFRESH_REQUIRED') {
        if (options.contextKey() === context) status.value = 'RANGE_REFRESH_REQUIRED'
        return
      }
      throw error
    }
    // A successful projection can change row versions and clear selection; do not label it stale.
    if (options.contextKey() === context) status.value = 'DONE'
  }
  async function pointerUp(event: MouseEvent) {
    if (event.button !== 0) return
    const pending = drag
    if (!pending) return
    const cell = event.target instanceof Element
      ? event.target.closest<HTMLElement>('[data-range-row][data-range-col]') : null
    if (!cell || !options.root.value?.contains(cell) || pending.signature !== signature.value) { clear(); return }
    const point = { row: Number(cell.dataset.rangeRow), col: Number(cell.dataset.rangeCol) }
    if (!valid(point)) { clear(); return }
    pointerEnter(point.row, point.col)
    drag = null
    const target = preview.value
    preview.value = null
    if (pending.kind !== 'fill' || !target) return
    busy.value = true
    try {
      const changes = planRangeFill({ rows: pending.rows, fields: options.fields(), source: pending.source,
        target, mode: pending.mode, canWrite: options.canWrite })
      await commit(changes, options.contextKey())
    } catch (error) {
      if (pending.signature === signature.value) reportError(error)
    } finally { busy.value = false }
  }
  async function copy() {
    if (!enabled.value || busy.value || options.editing() || !selection.value) return
    const target = selection.value
    const matrix = options.rows().slice(target.top, target.bottom + 1).map(row =>
      options.fields().slice(target.left, target.right + 1).map(field => row.data[field.id]))
    let text: string
    try { text = serializeClipboardMatrix(matrix) } catch (error) { reportError(error); return }
    const before = signature.value
    const epoch = generation
    busy.value = true
    try {
      await navigator.clipboard.writeText(text)
      if (epoch === generation && before === signature.value) status.value = 'COPIED'
    } catch {
      if (epoch === generation && before === signature.value) status.value = 'CLIPBOARD'
    } finally { busy.value = false }
  }
  async function paste() {
    if (!enabled.value || busy.value || options.editing() || !selection.value) return
    const target = { ...selection.value }
    const rows = snapshotRows()
    const before = signature.value
    const epoch = generation
    const context = options.contextKey()
    busy.value = true
    try {
      const text = await navigator.clipboard.readText()
      if (epoch !== generation || before !== signature.value || !enabled.value || options.editing()) {
        status.value = 'STALE'
        return
      }
      const changes = planRangePaste({ rows, fields: options.fields(), target,
        matrix: parseClipboardMatrix(text), canWrite: options.canWrite })
      await commit(changes, context)
    } catch (error) {
      if (epoch === generation && before === signature.value) reportError(error)
    } finally { busy.value = false }
  }
  function keydown(event: KeyboardEvent, focus: CellPoint) {
    if (!enabled.value || options.editing()) return false
    const mod = event.ctrlKey || event.metaKey
    if (mod && ['c', 'v'].includes(event.key.toLowerCase())) {
      event.preventDefault()
      if (!selection.value) select(focus)
      void (event.key.toLowerCase() === 'c' ? copy() : paste())
      return true
    }
    if (event.key === 'Escape') { clear(); return false }
    if (event.shiftKey && !mod && !event.altKey && event.key.startsWith('Arrow')) {
      event.preventDefault()
      if (busy.value) return true
      if (!anchor.value) select(focus)
      const point = { ...(end.value ?? focus) }
      if (event.key === 'ArrowDown') point.row++
      if (event.key === 'ArrowUp') point.row--
      if (event.key === 'ArrowRight') point.col++
      if (event.key === 'ArrowLeft') point.col--
      if (valid(point)) { select(point, true); options.focus(point) }
      return true
    }
    return false
  }
  function selected(row: number, col: number) {
    return enabled.value && !!selection.value && rangeContains(selection.value, { row, col })
  }
  function previewed(row: number, col: number) {
    return enabled.value && !!preview.value && rangeContains(preview.value, { row, col })
  }
  function handleAt(row: number, col: number) {
    return enabled.value && !busy.value && !options.editing() && selection.value?.bottom === row && selection.value?.right === col
  }
  function cancelDrag() { if (drag) clear() }
  onMounted(() => { window.addEventListener('mouseup', pointerUp); window.addEventListener('blur', cancelDrag) })
  onBeforeUnmount(() => { clear(); window.removeEventListener('mouseup', pointerUp); window.removeEventListener('blur', cancelDrag) })
  return { enabled, selection, mode, busy, status, clear, select, pointerDown, pointerEnter, startFill,
    copy, paste, keydown, selected, previewed, handleAt }
}
