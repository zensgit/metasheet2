<template>
  <Teleport to="body">
    <div v-if="visible" class="meta-export-overlay" @click.self="onCancel">
      <div class="meta-export-modal" role="dialog" :aria-label="l('export.title')">
        <div class="meta-export__header">
          <strong>{{ l('export.title') }}</strong>
          <button class="meta-export__close" :aria-label="l('export.close')" @click="onCancel">&times;</button>
        </div>

        <div class="meta-export__body">
          <!-- Columns -->
          <div class="meta-export__row">
            <div class="meta-export__row-head">
              <span class="meta-export__label">{{ l('export.columns') }}</span>
              <span class="meta-export__bulk">
                <button type="button" class="meta-export__link" @click="selectAll">{{ l('export.selectAll') }}</button>
                <button type="button" class="meta-export__link" @click="clearAll">{{ l('export.clearAll') }}</button>
              </span>
            </div>
            <ul class="meta-export__cols" role="group" :aria-label="l('export.columns')">
              <li v-for="field in fields" :key="field.id" class="meta-export__col">
                <label class="meta-export__col-label">
                  <input
                    type="checkbox"
                    :checked="checked.has(field.id)"
                    @change="toggle(field.id)"
                  />
                  <span class="meta-export__col-name">{{ field.name }}</span>
                </label>
              </li>
            </ul>
            <p v-if="!canExport" class="meta-export__hint meta-export__hint--warn" role="alert">{{ l('export.noColumns') }}</p>
          </div>

          <!-- Row scope -->
          <div class="meta-export__row">
            <span class="meta-export__label">{{ l('export.rowScope') }}</span>
            <label class="meta-export__opt">
              <input type="radio" value="all" :checked="rowScope === 'all'" @change="rowScope = 'all'" />
              <span>{{ l('export.allRows') }}</span>
            </label>
            <label class="meta-export__opt" :class="{ 'meta-export__opt--disabled': selectedRowCount === 0 }">
              <input
                type="radio"
                value="selected"
                :checked="rowScope === 'selected'"
                :disabled="selectedRowCount === 0"
                @change="rowScope = 'selected'"
              />
              <span>{{ l('export.selectedRows') }}</span>
              <span v-if="selectedRowCount > 0" class="meta-export__count">{{ selectedCount(selectedRowCount, isZh) }}</span>
            </label>
          </div>

          <!-- Format -->
          <div class="meta-export__row">
            <span class="meta-export__label">{{ l('export.format') }}</span>
            <label class="meta-export__opt">
              <input type="radio" value="xlsx" :checked="format === 'xlsx'" @change="format = 'xlsx'" />
              <span>{{ l('export.formatXlsx') }}</span>
            </label>
            <label class="meta-export__opt">
              <input type="radio" value="csv" :checked="format === 'csv'" @change="format = 'csv'" />
              <span>{{ l('export.formatCsv') }}</span>
            </label>
          </div>
        </div>

        <div class="meta-export__actions">
          <button class="meta-export__btn" @click="onCancel">{{ l('export.cancel') }}</button>
          <button
            class="meta-export__btn meta-export__btn--primary"
            :disabled="!canExport"
            @click="onConfirm"
          >
            {{ l('export.confirm') }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useLocale } from '../../composables/useLocale'
import { metaCoreLabel, selectedCount, type MetaCoreLabelKey } from '../utils/meta-core-labels'

export interface ExportColumn {
  id: string
  name: string
}

export interface ExportConfirmPayload {
  fieldIds: string[]
  rowScope: 'all' | 'selected'
  format: 'csv' | 'xlsx'
}

const props = defineProps<{
  visible: boolean
  fields: ExportColumn[]
  /** Number of currently-selected rows; 0 disables the "selected rows only" scope. */
  selectedRowCount: number
  /** Format to preselect when the dialog opens (the toolbar's CSV vs XLSX button). */
  initialFormat?: 'csv' | 'xlsx'
}>()

const emit = defineEmits<{
  (e: 'confirm', payload: ExportConfirmPayload): void
  (e: 'cancel'): void
}>()

const { isZh } = useLocale()
const l = (key: MetaCoreLabelKey) => metaCoreLabel(key, isZh.value)

const checked = ref<Set<string>>(new Set())
const rowScope = ref<'all' | 'selected'>('all')
const format = ref<'csv' | 'xlsx'>('xlsx')

// Reset to a clean default state every time the dialog opens (all columns
// checked, all rows, xlsx). Preserves field ORDER via the emit below (the Set
// is membership only; order comes from props.fields at confirm time).
watch(
  () => props.visible,
  (open) => {
    if (!open) return
    checked.value = new Set(props.fields.map((f) => f.id))
    rowScope.value = 'all'
    format.value = props.initialFormat ?? 'xlsx'
  },
  { immediate: true },
)

const canExport = computed(() => checked.value.size > 0)

function toggle(fieldId: string) {
  const next = new Set(checked.value)
  if (next.has(fieldId)) next.delete(fieldId)
  else next.add(fieldId)
  checked.value = next
}

function selectAll() {
  checked.value = new Set(props.fields.map((f) => f.id))
}

function clearAll() {
  checked.value = new Set()
}

function onConfirm() {
  if (!canExport.value) return
  // Preserve the on-screen column order: filter props.fields by membership
  // rather than emitting the Set's insertion order.
  const fieldIds = props.fields.filter((f) => checked.value.has(f.id)).map((f) => f.id)
  emit('confirm', { fieldIds, rowScope: rowScope.value, format: format.value })
}

function onCancel() {
  emit('cancel')
}
</script>

<style scoped>
.meta-export-overlay { position: fixed; inset: 0; z-index: 110; background: rgba(0,0,0,.3); display: flex; align-items: center; justify-content: center; }
.meta-export-modal { background: #fff; border-radius: 6px; min-width: 420px; max-width: 540px; box-shadow: 0 10px 40px rgba(0,0,0,.18); display: flex; flex-direction: column; max-height: 80vh; }
.meta-export__header { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid #ebedf0; }
.meta-export__close { background: transparent; border: none; font-size: 22px; line-height: 1; cursor: pointer; color: #909399; }
.meta-export__close:hover { color: #303133; }
.meta-export__body { padding: 16px; display: flex; flex-direction: column; gap: 16px; overflow-y: auto; }
.meta-export__row { display: flex; flex-direction: column; gap: 6px; }
.meta-export__row-head { display: flex; align-items: center; justify-content: space-between; }
.meta-export__label { font-size: 12px; color: #909399; }
.meta-export__bulk { display: flex; gap: 12px; }
.meta-export__link { background: none; border: none; padding: 0; color: #409eff; font-size: 12px; cursor: pointer; }
.meta-export__link:hover { text-decoration: underline; }
.meta-export__cols { list-style: none; margin: 0; padding: 4px; border: 1px solid #dcdfe6; border-radius: 4px; max-height: 220px; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }
.meta-export__col-label { display: flex; align-items: center; gap: 8px; padding: 4px 6px; cursor: pointer; font-size: 14px; border-radius: 3px; }
.meta-export__col-label:hover { background: #f5f7fa; }
.meta-export__col-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meta-export__opt { display: flex; align-items: center; gap: 8px; font-size: 14px; cursor: pointer; }
.meta-export__opt--disabled { color: #c0c4cc; cursor: not-allowed; }
.meta-export__count { color: #909399; font-size: 12px; }
.meta-export__hint { font-size: 13px; margin: 0; }
.meta-export__hint--warn { color: #e6a23c; }
.meta-export__actions { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 16px; border-top: 1px solid #ebedf0; }
.meta-export__btn { background: #fff; border: 1px solid #dcdfe6; padding: 6px 14px; border-radius: 4px; cursor: pointer; font-size: 14px; }
.meta-export__btn:hover:not(:disabled) { border-color: #c0c4cc; }
.meta-export__btn:disabled { opacity: .55; cursor: not-allowed; }
.meta-export__btn--primary { background: #409eff; color: #fff; border-color: #409eff; }
.meta-export__btn--primary:hover:not(:disabled) { background: #66b1ff; border-color: #66b1ff; }
</style>
