<template>
  <Teleport to="body">
    <div v-if="visible" class="meta-import-overlay" @click.self="emit('close')">
      <div class="meta-import-modal">
        <div class="meta-import__header">
          <strong>Import Records</strong>
          <button class="meta-import__close" @click="emit('close')">&times;</button>
        </div>

        <!-- Step 1: Paste -->
        <div v-if="step === 'paste'" class="meta-import__body">
          <p class="meta-import__hint">Paste tab-separated data from Excel or Google Sheets (first row = headers):</p>
          <textarea
            ref="textareaRef"
            class="meta-import__textarea"
            placeholder="Name&#x9;Age&#x9;Email&#x0A;Alice&#x9;30&#x9;alice@example.com"
            :value="rawText"
            @input="rawText = ($event.target as HTMLTextAreaElement).value"
          ></textarea>
          <div class="meta-import__actions">
            <button class="meta-import__btn" @click="emit('close')">Cancel</button>
            <button class="meta-import__btn meta-import__btn--primary" :disabled="!rawText.trim()" @click="parseAndPreview">Preview</button>
          </div>
        </div>

        <!-- Step 2: Preview & Map -->
        <div v-else-if="step === 'preview'" class="meta-import__body">
          <p class="meta-import__hint">{{ parsedRows.length }} record(s) detected. Map columns to fields:</p>
          <div class="meta-import__mapping">
            <div v-for="(header, i) in parsedHeaders" :key="i" class="meta-import__map-row">
              <span class="meta-import__col-name">{{ header }}</span>
              <span class="meta-import__arrow">&rarr;</span>
              <select class="meta-import__field-select" :value="fieldMapping[i] ?? ''" @change="fieldMapping[i] = ($event.target as HTMLSelectElement).value">
                <option value="">(skip)</option>
                <option v-for="f in fields" :key="f.id" :value="f.id">{{ f.name }}</option>
              </select>
            </div>
          </div>
          <div v-if="parsedRows.length" class="meta-import__preview-table">
            <table>
              <thead><tr><th v-for="(h, i) in parsedHeaders" :key="i">{{ h }}</th></tr></thead>
              <tbody>
                <tr v-for="(row, ri) in parsedRows.slice(0, 5)" :key="ri">
                  <td v-for="(cell, ci) in row" :key="ci">{{ cell }}</td>
                </tr>
                <tr v-if="parsedRows.length > 5"><td :colspan="parsedHeaders.length" class="meta-import__more">... and {{ parsedRows.length - 5 }} more</td></tr>
              </tbody>
            </table>
          </div>
          <div class="meta-import__actions">
            <button class="meta-import__btn" @click="step = 'paste'">Back</button>
            <button class="meta-import__btn meta-import__btn--primary" :disabled="!hasMappedFields" @click="doImport">
              Import {{ parsedRows.length }} record(s)
            </button>
          </div>
        </div>

        <!-- Step 3: Importing -->
        <div v-else class="meta-import__body meta-import__importing">
          <div class="meta-import__spinner"></div>
          <p>Importing {{ importProgress }} / {{ parsedRows.length }}...</p>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import type { MetaField } from '../types'

const props = defineProps<{
  visible: boolean
  fields: MetaField[]
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'import', records: Array<Record<string, unknown>>): void
}>()

const step = ref<'paste' | 'preview' | 'importing'>('paste')
const rawText = ref('')
const parsedHeaders = ref<string[]>([])
const parsedRows = ref<string[][]>([])
const fieldMapping = ref<Record<number, string>>({})
const importProgress = ref(0)
const textareaRef = ref<HTMLTextAreaElement | null>(null)

const hasMappedFields = computed(() => Object.values(fieldMapping.value).some((v) => v))

watch(() => props.visible, (v) => {
  if (v) {
    step.value = 'paste'
    rawText.value = ''
    parsedHeaders.value = []
    parsedRows.value = []
    fieldMapping.value = {}
    importProgress.value = 0
    nextTick(() => textareaRef.value?.focus())
  }
})

function parseAndPreview() {
  const lines = rawText.value.trim().split('\n').map((l) => l.split('\t'))
  if (lines.length < 2) return
  parsedHeaders.value = lines[0]
  parsedRows.value = lines.slice(1).filter((r) => r.some((c) => c.trim()))

  // Auto-map by name match
  fieldMapping.value = {}
  parsedHeaders.value.forEach((header, i) => {
    const lh = header.toLowerCase().trim()
    const match = props.fields.find((f) => f.name.toLowerCase() === lh)
    if (match) fieldMapping.value[i] = match.id
  })
  step.value = 'preview'
}

function doImport() {
  const records: Array<Record<string, unknown>> = []
  for (const row of parsedRows.value) {
    const data: Record<string, unknown> = {}
    for (const [colIdx, fieldId] of Object.entries(fieldMapping.value)) {
      if (!fieldId) continue
      const val = row[Number(colIdx)] ?? ''
      const field = props.fields.find((f) => f.id === fieldId)
      if (field?.type === 'number' && val !== '') data[fieldId] = Number(val)
      else if (field?.type === 'boolean') data[fieldId] = val.toLowerCase() === 'true' || val === '1'
      else if (field?.type === 'date' && val !== '') {
        const d = new Date(val)
        data[fieldId] = !isNaN(d.getTime()) ? d.toISOString().split('T')[0] : val
      } else data[fieldId] = val
    }
    if (Object.keys(data).length) records.push(data)
  }
  step.value = 'importing'
  importProgress.value = records.length
  emit('import', records)
}
</script>

<style scoped>
.meta-import-overlay { position: fixed; inset: 0; z-index: 100; background: rgba(0,0,0,.3); display: flex; align-items: center; justify-content: center; }
.meta-import-modal { background: #fff; border-radius: 8px; width: 560px; max-height: 80vh; display: flex; flex-direction: column; box-shadow: 0 8px 24px rgba(0,0,0,.15); }
.meta-import__header { display: flex; justify-content: space-between; align-items: center; padding: 14px 20px; border-bottom: 1px solid #eee; font-size: 15px; }
.meta-import__close { border: none; background: none; font-size: 20px; cursor: pointer; color: #999; }
.meta-import__body { padding: 16px 20px; overflow-y: auto; }
.meta-import__hint { font-size: 13px; color: #666; margin-bottom: 12px; }
.meta-import__textarea { width: 100%; min-height: 120px; border: 1px solid #ddd; border-radius: 4px; padding: 8px; font-family: monospace; font-size: 12px; resize: vertical; }
.meta-import__textarea:focus { border-color: #409eff; outline: none; }
.meta-import__actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; padding-top: 12px; border-top: 1px solid #f0f0f0; }
.meta-import__btn { padding: 6px 16px; border: 1px solid #ddd; border-radius: 4px; background: #fff; font-size: 13px; cursor: pointer; }
.meta-import__btn:hover { background: #f5f5f5; }
.meta-import__btn--primary { background: #409eff; color: #fff; border-color: #409eff; }
.meta-import__btn--primary:hover { background: #66b1ff; }
.meta-import__btn--primary:disabled { opacity: 0.5; cursor: not-allowed; }
.meta-import__mapping { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; }
.meta-import__map-row { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.meta-import__col-name { min-width: 100px; font-weight: 500; color: #333; }
.meta-import__arrow { color: #999; }
.meta-import__field-select { padding: 3px 8px; border: 1px solid #ddd; border-radius: 3px; font-size: 12px; }
.meta-import__preview-table { max-height: 180px; overflow: auto; border: 1px solid #eee; border-radius: 4px; }
.meta-import__preview-table table { width: 100%; border-collapse: collapse; font-size: 12px; }
.meta-import__preview-table th { background: #f9fafb; padding: 4px 8px; border-bottom: 1px solid #eee; text-align: left; font-weight: 600; color: #666; }
.meta-import__preview-table td { padding: 4px 8px; border-bottom: 1px solid #f5f5f5; }
.meta-import__more { text-align: center; color: #999; font-style: italic; }
.meta-import__importing { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 40px 20px; }
.meta-import__spinner { width: 32px; height: 32px; border: 3px solid #eee; border-top-color: #409eff; border-radius: 50%; animation: meta-import-spin 0.8s linear infinite; }
@keyframes meta-import-spin { to { transform: rotate(360deg); } }
</style>
