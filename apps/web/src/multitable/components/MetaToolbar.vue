<template>
  <div class="meta-toolbar" role="toolbar" aria-label="Grid toolbar">
    <div class="meta-toolbar__left">
      <!-- Hide Fields -->
      <div class="meta-toolbar__dropdown">
        <button class="meta-toolbar__btn" @click="showFieldPicker = !showFieldPicker">
          <span class="meta-toolbar__btn-icon">&#x2630;</span> Fields
          <span v-if="hiddenCount" class="meta-toolbar__badge">{{ hiddenCount }}</span>
        </button>
        <div v-if="showFieldPicker" class="meta-toolbar__panel" @keydown.escape="showFieldPicker = false">
          <label v-for="field in fields" :key="field.id" class="meta-toolbar__field-toggle">
            <input type="checkbox" :checked="!hiddenFieldIds.includes(field.id)" @change="emit('toggle-field', field.id)" />
            <span>{{ field.name }}</span>
          </label>
        </div>
      </div>

      <!-- Sort -->
      <div class="meta-toolbar__dropdown">
        <button class="meta-toolbar__btn" @click="showSortPanel = !showSortPanel">
          <span class="meta-toolbar__btn-icon">&#x2195;</span> Sort
          <span v-if="sortRules.length" class="meta-toolbar__badge">{{ sortRules.length }}</span>
        </button>
        <div v-if="showSortPanel" class="meta-toolbar__panel" @keydown.escape="showSortPanel = false">
          <div v-for="(rule, idx) in sortRules" :key="idx" class="meta-toolbar__sort-rule">
            <select :value="rule.fieldId" @change="onSortFieldChange(idx, ($event.target as HTMLSelectElement).value)">
              <option v-for="f in fields" :key="f.id" :value="f.id">{{ f.name }}</option>
            </select>
            <select :value="rule.direction" @change="onSortDirChange(idx, ($event.target as HTMLSelectElement).value as 'asc'|'desc')">
              <option value="asc">A &#x2192; Z</option>
              <option value="desc">Z &#x2192; A</option>
            </select>
            <button class="meta-toolbar__remove" @click="emit('remove-sort', rule.fieldId)">&times;</button>
          </div>
          <button v-if="fields.length" class="meta-toolbar__add" @click="emit('add-sort', { fieldId: fields[0].id, direction: 'asc' })">+ Add sort</button>
          <button v-if="sortRules.length" class="meta-toolbar__apply" @click="emit('apply-sort-filter')">Apply</button>
        </div>
      </div>

      <!-- Filter -->
      <div class="meta-toolbar__dropdown">
        <button class="meta-toolbar__btn" @click="showFilterPanel = !showFilterPanel">
          <span class="meta-toolbar__btn-icon">&#x2A01;</span> Filter
          <span v-if="filterRules.length" class="meta-toolbar__badge">{{ filterRules.length }}</span>
        </button>
        <div v-if="showFilterPanel" class="meta-toolbar__panel meta-toolbar__panel--filter" @keydown.escape="showFilterPanel = false">
          <div v-if="filterRules.length > 1" class="meta-toolbar__conjunction">
            <span>Where</span>
            <select :value="filterConjunction" @change="emit('set-conjunction', ($event.target as HTMLSelectElement).value as 'and'|'or')">
              <option value="and">all</option>
              <option value="or">any</option>
            </select>
            <span>conditions match</span>
          </div>
          <div v-for="(rule, idx) in filterRules" :key="idx" class="meta-toolbar__filter-rule">
            <select :value="rule.fieldId" aria-label="Filter field" @change="onFilterFieldChange(idx, ($event.target as HTMLSelectElement).value)">
              <option v-for="f in fields" :key="f.id" :value="f.id">{{ f.name }}</option>
            </select>
            <span class="meta-toolbar__field-type">{{ getFilterFieldTypeLabel(rule.fieldId) }}</span>
            <select :value="rule.operator" aria-label="Filter operator" @change="onFilterOperatorChange(idx, ($event.target as HTMLSelectElement).value)">
              <option v-for="op in getOperatorsForField(rule.fieldId)" :key="op.value" :value="op.value">{{ op.label }}</option>
            </select>
            <span v-if="isUnaryOp(rule.operator)" class="meta-toolbar__filter-empty-hint">no value needed</span>
            <select
              v-else-if="isSelectLikeField(rule.fieldId)"
              class="meta-toolbar__filter-value"
              :value="String(rule.value ?? '')"
              aria-label="Filter value"
              @change="onFilterValueChange(idx, ($event.target as HTMLSelectElement).value)"
            >
              <option value="" disabled>{{ getSelectOptions(rule.fieldId).length ? 'Choose option...' : 'No options' }}</option>
              <option v-for="option in getSelectOptions(rule.fieldId)" :key="option.value" :value="option.value">{{ option.label }}</option>
            </select>
            <select
              v-else-if="getFieldType(rule.fieldId) === 'boolean'"
              class="meta-toolbar__filter-value"
              :value="String(rule.value ?? 'true')"
              aria-label="Filter value"
              @change="onFilterValueChange(idx, ($event.target as HTMLSelectElement).value)"
            >
              <option value="true">checked / true</option>
              <option value="false">unchecked / false</option>
            </select>
            <input
              v-else
              class="meta-toolbar__filter-value"
              :type="getInputType(rule.fieldId)"
              :placeholder="getValuePlaceholder(rule.fieldId)"
              :value="rule.value ?? ''"
              aria-label="Filter value"
              @change="onFilterValueChange(idx, ($event.target as HTMLInputElement).value)"
            />
            <button class="meta-toolbar__remove" @click="emit('remove-filter', idx)">&times;</button>
          </div>
          <div class="meta-toolbar__filter-actions">
            <button v-if="fields.length" class="meta-toolbar__add" @click="onAddFilter">+ Add filter</button>
            <button v-if="filterRules.length" class="meta-toolbar__add meta-toolbar__add--danger" @click="emit('clear-filters')">Clear all</button>
          </div>
          <button v-if="filterRules.length" class="meta-toolbar__apply" @click="emit('apply-sort-filter')">{{ applyButtonLabel }}</button>
          <p v-if="filterRules.length && sortFilterDirty" class="meta-toolbar__apply-hint">Filter changes are staged until applied.</p>
        </div>
      </div>

      <!-- Group By -->
      <div class="meta-toolbar__dropdown">
        <button class="meta-toolbar__btn" @click="showGroupPanel = !showGroupPanel">
          <span class="meta-toolbar__btn-icon">&#x229E;</span> Group
          <span v-if="groupFieldId" class="meta-toolbar__badge">1</span>
        </button>
        <div v-if="showGroupPanel" class="meta-toolbar__panel" @keydown.escape="showGroupPanel = false">
          <label class="meta-toolbar__field-toggle">
            <input type="radio" name="groupBy" :checked="!groupFieldId" @change="emit('set-group-field', null)" />
            <span class="meta-toolbar__group-none">None</span>
          </label>
          <label v-for="f in groupableFields" :key="f.id" class="meta-toolbar__field-toggle">
            <input type="radio" name="groupBy" :checked="groupFieldId === f.id" @change="emit('set-group-field', f.id)" />
            <span>{{ f.name }}</span>
            <span class="meta-toolbar__field-type">{{ f.type }}</span>
          </label>
        </div>
      </div>

      <!-- Undo/Redo -->
      <button class="meta-toolbar__btn" :disabled="!canUndo" title="Undo (Ctrl+Z)" aria-label="Undo" @click="emit('undo')">&#x21A9;</button>
      <button class="meta-toolbar__btn" :disabled="!canRedo" title="Redo (Ctrl+Y)" aria-label="Redo" @click="emit('redo')">&#x21AA;</button>
    </div>
    <div class="meta-toolbar__right">
      <div class="meta-toolbar__search" :class="{ 'meta-toolbar__search--active': !!searchText }" role="search">
        <span class="meta-toolbar__search-icon" aria-hidden="true">&#x1F50D;</span>
        <input class="meta-toolbar__search-input" type="search" placeholder="Search records..." aria-label="Search records" :value="searchText" @input="emit('update:search-text', ($event.target as HTMLInputElement).value)" />
        <button v-if="searchText" class="meta-toolbar__search-clear" aria-label="Clear search" @click="emit('update:search-text', '')">&times;</button>
      </div>
      <span v-if="totalRows !== undefined" class="meta-toolbar__row-count">{{ totalRows }} rows</span>
      <!-- Row density -->
      <div class="meta-toolbar__dropdown">
        <button class="meta-toolbar__btn" title="Row height" aria-label="Row height" @click="showDensityPanel = !showDensityPanel">&#x2195; Rows</button>
        <div v-if="showDensityPanel" class="meta-toolbar__panel meta-toolbar__panel--density" @keydown.escape="showDensityPanel = false">
          <label v-for="d in DENSITIES" :key="d.value" class="meta-toolbar__field-toggle">
            <input type="radio" name="density" :checked="rowDensity === d.value" @change="emit('set-row-density', d.value); showDensityPanel = false" />
            <span>{{ d.label }}</span>
          </label>
        </div>
      </div>
      <button class="meta-toolbar__btn" title="Auto-fit columns" aria-label="Auto-fit columns" @click="emit('auto-fit-columns')">&#x2194; Fit</button>
      <button class="meta-toolbar__btn" title="Print" aria-label="Print grid" @click="emit('print')">&#x1F5A8; Print</button>
      <button v-if="canCreateRecord" class="meta-toolbar__btn" title="Import records" aria-label="Import records" @click="emit('import')">&#x2B71; Import</button>
      <button v-if="canExport" class="meta-toolbar__btn" title="Export CSV" aria-label="Export CSV" @click="emit('export-csv')">&#x2B73; Export CSV</button>
      <button v-if="canExport" class="meta-toolbar__btn" title="Export Excel (.xlsx)" aria-label="Export Excel" @click="emit('export-xlsx')">&#x2B73; Export XLSX</button>
      <button v-if="canCreateRecord" class="meta-toolbar__btn meta-toolbar__btn--primary" @click="emit('add-record')">+ New Record</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import type { MetaField, RowDensity } from '../types'
import type { SortRule, FilterRule, FilterConjunction } from '../composables/useMultitableGrid'
import { FILTER_OPERATORS_BY_TYPE } from '../composables/useMultitableGrid'

const props = defineProps<{
  fields: MetaField[]
  hiddenFieldIds: string[]
  sortRules: SortRule[]
  filterRules: FilterRule[]
  filterConjunction: FilterConjunction
  canCreateRecord: boolean
  canExport?: boolean
  canUndo: boolean
  canRedo: boolean
  groupFieldId?: string | null
  searchText?: string
  totalRows?: number
  rowDensity?: RowDensity
  sortFilterDirty?: boolean
}>()

const emit = defineEmits<{
  (e: 'toggle-field', fieldId: string): void
  (e: 'add-sort', rule: SortRule): void
  (e: 'remove-sort', fieldId: string): void
  (e: 'update-sort', index: number, rule: SortRule): void
  (e: 'add-filter', rule: FilterRule): void
  (e: 'update-filter', index: number, rule: FilterRule): void
  (e: 'remove-filter', index: number): void
  (e: 'clear-filters'): void
  (e: 'set-conjunction', conj: FilterConjunction): void
  (e: 'apply-sort-filter'): void
  (e: 'add-record'): void
  (e: 'undo'): void
  (e: 'redo'): void
  (e: 'set-group-field', fieldId: string | null): void
  (e: 'export-csv'): void
  (e: 'export-xlsx'): void
  (e: 'import'): void
  (e: 'update:search-text', text: string): void
  (e: 'print'): void
  (e: 'set-row-density', density: RowDensity): void
  (e: 'auto-fit-columns'): void
}>()

const showFieldPicker = ref(false)
const showSortPanel = ref(false)
const showFilterPanel = ref(false)
const showGroupPanel = ref(false)
const showDensityPanel = ref(false)
const DENSITIES: Array<{ value: RowDensity; label: string }> = [
  { value: 'compact', label: 'Compact' },
  { value: 'normal', label: 'Normal' },
  { value: 'expanded', label: 'Expanded' },
]
const GROUPABLE_TYPES = new Set(['select', 'string', 'boolean', 'number', 'date'])
const groupableFields = computed(() => props.fields.filter((f) => GROUPABLE_TYPES.has(f.type)))
const hiddenCount = computed(() => props.hiddenFieldIds.length)
const UNARY = new Set(['isEmpty', 'isNotEmpty'])
const isUnaryOp = (op: string) => UNARY.has(op)
const getField = (id: string) => props.fields.find((f) => f.id === id)
const getFieldType = (id: string) => getField(id)?.type ?? 'string'
const isSelectLikeField = (id: string) => {
  const type = String(getFieldType(id))
  return type === 'select' || type === 'multiSelect'
}
const getOperatorsForField = (id: string) => {
  const type = String(getFieldType(id))
  if (type === 'multiSelect') {
    return FILTER_OPERATORS_BY_TYPE.multiSelect ?? FILTER_OPERATORS_BY_TYPE.select
  }
  return FILTER_OPERATORS_BY_TYPE[type] ?? FILTER_OPERATORS_BY_TYPE.string
}
const applyButtonLabel = computed(() => props.sortFilterDirty ? 'Apply filter changes' : 'Apply filters')
const getInputType = (id: string) => {
  const t = getFieldType(id)
  if (t === 'number') return 'number'
  if (t === 'date') return 'date'
  return 'text'
}
const getFilterFieldTypeLabel = (id: string) => {
  const labels: Record<string, string> = {
    string: 'text',
    longText: 'long text',
    number: 'number',
    boolean: 'checkbox',
    select: 'select',
    multiSelect: 'multi-select',
    date: 'date',
  }
  return labels[getFieldType(id)] ?? getFieldType(id)
}
const getValuePlaceholder = (id: string) => {
  const t = getFieldType(id)
  if (t === 'number') return 'Enter a number'
  if (t === 'date') return 'Pick a date'
  return 'Enter filter text'
}
function getSelectOptions(id: string): Array<{ value: string; label: string }> {
  const field = getField(id)
  const rawOptions = field?.options ?? (Array.isArray(field?.property?.options) ? field.property.options : [])
  return rawOptions
    .map((option) => {
      if (typeof option === 'string') return { value: option, label: option }
      if (option && typeof option === 'object' && 'value' in option) {
        const value = String((option as { value?: unknown }).value ?? '')
        return value ? { value, label: value } : null
      }
      return null
    })
    .filter((option): option is { value: string; label: string } => option !== null)
}
function getDefaultFilterValue(fieldId: string): unknown {
  const type = getFieldType(fieldId)
  if (String(type) === 'select' || String(type) === 'multiSelect') return getSelectOptions(fieldId)[0]?.value ?? ''
  if (type === 'boolean') return true
  return ''
}

function onSortFieldChange(idx: number, fieldId: string) { emit('update-sort', idx, { ...props.sortRules[idx], fieldId }) }
function onSortDirChange(idx: number, direction: 'asc'|'desc') { emit('update-sort', idx, { ...props.sortRules[idx], direction }) }
function onAddFilter() {
  if (!props.fields.length) return
  const ops = getOperatorsForField(props.fields[0].id)
  emit('add-filter', { fieldId: props.fields[0].id, operator: ops[0]?.value ?? 'is', value: getDefaultFilterValue(props.fields[0].id) })
}
function onFilterFieldChange(idx: number, fieldId: string) {
  const ops = getOperatorsForField(fieldId)
  emit('update-filter', idx, { ...props.filterRules[idx], fieldId, operator: ops[0]?.value ?? 'is', value: getDefaultFilterValue(fieldId) })
}
function onFilterOperatorChange(idx: number, operator: string) {
  const r = { ...props.filterRules[idx], operator }
  if (isUnaryOp(operator)) r.value = undefined
  else if (r.value === undefined) r.value = getDefaultFilterValue(r.fieldId)
  emit('update-filter', idx, r)
}
function onFilterValueChange(idx: number, value: string) {
  const ft = getFieldType(props.filterRules[idx].fieldId)
  let nextValue: unknown = value
  if (ft === 'number' && value !== '') nextValue = Number(value)
  if (ft === 'boolean') nextValue = value === 'true'
  emit('update-filter', idx, { ...props.filterRules[idx], value: nextValue })
}
</script>

<style scoped>
.meta-toolbar { display: flex; justify-content: space-between; align-items: center; padding: 6px 12px; border-bottom: 1px solid #e5e7eb; background: #fff; }
.meta-toolbar__left { display: flex; gap: 4px; align-items: center; }
.meta-toolbar__right { display: flex; gap: 4px; }
.meta-toolbar__btn { display: inline-flex; align-items: center; gap: 4px; padding: 4px 10px; font-size: 13px; border: 1px solid #ddd; border-radius: 4px; background: #fff; cursor: pointer; color: #555; }
.meta-toolbar__btn:hover:not(:disabled) { background: #f5f5f5; border-color: #ccc; }
.meta-toolbar__btn:disabled { opacity: 0.35; cursor: not-allowed; }
.meta-toolbar__btn--primary { background: #409eff; color: #fff; border-color: #409eff; }
.meta-toolbar__btn--primary:hover { background: #66b1ff; }
.meta-toolbar__btn-icon { font-size: 14px; }
.meta-toolbar__badge { font-size: 10px; background: #409eff; color: #fff; padding: 0 5px; border-radius: 8px; min-width: 16px; text-align: center; }
.meta-toolbar__dropdown { position: relative; }
.meta-toolbar__panel { position: absolute; top: 100%; left: 0; z-index: 20; min-width: 200px; background: #fff; border: 1px solid #ddd; border-radius: 4px; box-shadow: 0 4px 12px rgba(0,0,0,.1); padding: 8px; margin-top: 4px; }
.meta-toolbar__panel--filter { min-width: 420px; }
.meta-toolbar__panel--density { min-width: 120px; }
.meta-toolbar__field-toggle { display: flex; align-items: center; gap: 8px; padding: 4px 0; font-size: 13px; cursor: pointer; }
.meta-toolbar__sort-rule, .meta-toolbar__filter-rule { display: flex; gap: 4px; margin-bottom: 4px; align-items: center; }
.meta-toolbar__sort-rule select, .meta-toolbar__filter-rule select { padding: 2px 6px; font-size: 12px; border: 1px solid #ddd; border-radius: 3px; }
.meta-toolbar__filter-value { flex: 1; min-width: 80px; padding: 2px 6px; font-size: 12px; border: 1px solid #ddd; border-radius: 3px; }
.meta-toolbar__filter-empty-hint { flex: 1; min-width: 80px; color: #999; font-size: 12px; }
.meta-toolbar__conjunction { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #666; margin-bottom: 6px; }
.meta-toolbar__conjunction select { padding: 2px 6px; font-size: 12px; border: 1px solid #ddd; border-radius: 3px; }
.meta-toolbar__filter-actions { display: flex; gap: 12px; margin-top: 4px; }
.meta-toolbar__remove { border: none; background: none; color: #999; cursor: pointer; font-size: 16px; }
.meta-toolbar__remove:hover { color: #f56c6c; }
.meta-toolbar__add { border: none; background: none; color: #409eff; cursor: pointer; font-size: 12px; padding: 4px 0; }
.meta-toolbar__add:hover { text-decoration: underline; }
.meta-toolbar__add--danger { color: #f56c6c; }
.meta-toolbar__apply { display: block; width: 100%; margin-top: 8px; padding: 5px 0; background: #409eff; color: #fff; border: none; border-radius: 3px; font-size: 12px; cursor: pointer; }
.meta-toolbar__apply:hover { background: #66b1ff; }
.meta-toolbar__apply-hint { margin: 6px 0 0; color: #777; font-size: 11px; }
.meta-toolbar__group-none { color: #999; }
.meta-toolbar__field-type { font-size: 10px; color: #aaa; margin-left: auto; }
.meta-toolbar__search { display: flex; align-items: center; gap: 4px; border: 1px solid #ddd; border-radius: 4px; padding: 2px 8px; background: #fafafa; transition: border-color 0.2s, background 0.2s; }
.meta-toolbar__search:focus-within { border-color: #409eff; background: #fff; }
.meta-toolbar__search--active { border-color: #409eff; background: #ecf5ff; }
.meta-toolbar__search-icon { font-size: 12px; opacity: 0.5; }
.meta-toolbar__search-input { border: none; outline: none; font-size: 12px; width: 140px; background: transparent; color: #333; }
.meta-toolbar__search-input::placeholder { color: #bbb; }
.meta-toolbar__search-clear { border: none; background: none; color: #999; cursor: pointer; font-size: 14px; padding: 0 2px; line-height: 1; }
.meta-toolbar__search-clear:hover { color: #f56c6c; }
.meta-toolbar__row-count { font-size: 11px; color: #999; white-space: nowrap; }
@media print { .meta-toolbar { display: none !important; } }
</style>
