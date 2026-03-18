<template>
  <div v-if="visible" class="meta-field-mgr__overlay" @click.self="emit('close')">
    <div class="meta-field-mgr">
      <div class="meta-field-mgr__header">
        <h4 class="meta-field-mgr__title">Manage Fields</h4>
        <button class="meta-field-mgr__close" @click="emit('close')">&times;</button>
      </div>

      <div class="meta-field-mgr__body">
        <!-- Existing fields -->
        <div
          v-for="(field, idx) in fields"
          :key="field.id"
          class="meta-field-mgr__row"
        >
          <span class="meta-field-mgr__icon">{{ FIELD_ICONS[field.type] ?? '?' }}</span>

          <!-- Inline rename -->
          <template v-if="editingId === field.id">
            <input
              ref="renameRef"
              class="meta-field-mgr__rename"
              :value="editingName"
              @input="editingName = ($event.target as HTMLInputElement).value"
              @keydown.enter="confirmRename(field.id)"
              @keydown.escape="cancelRename"
            />
            <button class="meta-field-mgr__action meta-field-mgr__action--ok" @click="confirmRename(field.id)">&#x2713;</button>
            <button class="meta-field-mgr__action" @click="cancelRename">&#x2717;</button>
          </template>
          <template v-else>
            <span class="meta-field-mgr__name" :title="field.name">{{ field.name }}</span>
            <span class="meta-field-mgr__type">{{ field.type }}</span>
            <button class="meta-field-mgr__action" title="Rename" @click="startRename(field)">&#x270E;</button>
            <!-- Reorder -->
            <button class="meta-field-mgr__action" :disabled="idx === 0" title="Move up" @click="moveField(field.id, idx - 1)">&#x25B2;</button>
            <button class="meta-field-mgr__action" :disabled="idx === fields.length - 1" title="Move down" @click="moveField(field.id, idx + 1)">&#x25BC;</button>
            <button class="meta-field-mgr__action meta-field-mgr__action--danger" title="Delete" @click="onDeleteField(field)">&#x1F5D1;</button>
          </template>
        </div>

        <div v-if="!fields.length" class="meta-field-mgr__empty">No fields defined</div>
      </div>

      <!-- Add new field -->
      <div class="meta-field-mgr__add-section">
        <div class="meta-field-mgr__add-row">
          <input
            v-model="newFieldName"
            class="meta-field-mgr__input"
            placeholder="Field name"
            @keydown.enter="onAddField"
          />
          <select v-model="newFieldType" class="meta-field-mgr__select">
            <option v-for="t in FIELD_TYPES" :key="t" :value="t">{{ t }}</option>
          </select>
          <button class="meta-field-mgr__btn-add" :disabled="!newFieldName.trim()" @click="onAddField">+ Add</button>
        </div>
      </div>

      <!-- Delete confirmation -->
      <div v-if="deleteTarget" class="meta-field-mgr__confirm">
        <p>Delete field <strong>{{ deleteTarget.name }}</strong>? This cannot be undone.</p>
        <div class="meta-field-mgr__confirm-actions">
          <button class="meta-field-mgr__btn-cancel" @click="deleteTarget = null">Cancel</button>
          <button class="meta-field-mgr__btn-delete" @click="confirmDelete">Delete</button>
        </div>
      </div>

      <!-- Loading / error -->
      <div v-if="loading" class="meta-field-mgr__status">Saving...</div>
      <div v-if="error" class="meta-field-mgr__error">{{ error }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import type { MetaField, MetaFieldType } from '../types'

const FIELD_TYPES: MetaFieldType[] = ['string', 'number', 'boolean', 'date', 'select', 'link', 'formula', 'lookup', 'rollup']
const FIELD_ICONS: Record<string, string> = {
  string: 'Aa', number: '#', boolean: '\u2611', date: '\u{1F4C5}', select: '\u25CF',
  link: '\u21C4', lookup: '\u2197', rollup: '\u03A3', formula: 'fx',
}

const props = defineProps<{
  visible: boolean
  fields: MetaField[]
  sheetId: string
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'create-field', input: { sheetId: string; name: string; type: string }): void
  (e: 'update-field', fieldId: string, input: { name?: string; order?: number }): void
  (e: 'delete-field', fieldId: string): void
}>()

const newFieldName = ref('')
const newFieldType = ref<MetaFieldType>('string')
const editingId = ref<string | null>(null)
const editingName = ref('')
const deleteTarget = ref<MetaField | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)

function onAddField() {
  const name = newFieldName.value.trim()
  if (!name) return
  emit('create-field', { sheetId: props.sheetId, name, type: newFieldType.value })
  newFieldName.value = ''
}

function startRename(field: MetaField) {
  editingId.value = field.id
  editingName.value = field.name
}

function confirmRename(fieldId: string) {
  const name = editingName.value.trim()
  if (name && name !== props.fields.find((f) => f.id === fieldId)?.name) {
    emit('update-field', fieldId, { name })
  }
  cancelRename()
}

function cancelRename() {
  editingId.value = null
  editingName.value = ''
}

function moveField(fieldId: string, newIdx: number) {
  emit('update-field', fieldId, { order: newIdx })
}

function onDeleteField(field: MetaField) {
  deleteTarget.value = field
}

function confirmDelete() {
  if (deleteTarget.value) {
    emit('delete-field', deleteTarget.value.id)
    deleteTarget.value = null
  }
}
</script>

<style scoped>
.meta-field-mgr__overlay { position: fixed; inset: 0; background: rgba(0,0,0,.3); z-index: 100; display: flex; align-items: center; justify-content: center; }
.meta-field-mgr { width: 520px; max-height: 80vh; background: #fff; border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,.15); display: flex; flex-direction: column; }
.meta-field-mgr__header { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; border-bottom: 1px solid #eee; }
.meta-field-mgr__title { font-size: 15px; font-weight: 600; margin: 0; }
.meta-field-mgr__close { border: none; background: none; font-size: 20px; cursor: pointer; color: #999; }
.meta-field-mgr__body { flex: 1; overflow-y: auto; padding: 8px 16px; }
.meta-field-mgr__row { display: flex; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 1px solid #f5f5f5; }
.meta-field-mgr__icon { width: 24px; text-align: center; color: #999; font-size: 13px; }
.meta-field-mgr__name { flex: 1; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meta-field-mgr__type { font-size: 11px; color: #999; background: #f5f5f5; padding: 1px 6px; border-radius: 3px; }
.meta-field-mgr__rename { flex: 1; padding: 2px 6px; border: 1px solid #409eff; border-radius: 3px; font-size: 13px; }
.meta-field-mgr__action { border: none; background: none; color: #999; cursor: pointer; font-size: 13px; padding: 2px 4px; }
.meta-field-mgr__action:hover { color: #333; }
.meta-field-mgr__action:disabled { opacity: 0.3; cursor: not-allowed; }
.meta-field-mgr__action--ok { color: #67c23a; }
.meta-field-mgr__action--danger:hover { color: #f56c6c; }
.meta-field-mgr__empty { text-align: center; padding: 20px; color: #999; font-size: 13px; }
.meta-field-mgr__add-section { padding: 10px 16px; border-top: 1px solid #eee; }
.meta-field-mgr__add-row { display: flex; gap: 8px; }
.meta-field-mgr__input { flex: 1; padding: 5px 10px; border: 1px solid #ddd; border-radius: 4px; font-size: 13px; }
.meta-field-mgr__select { padding: 5px 8px; border: 1px solid #ddd; border-radius: 4px; font-size: 12px; }
.meta-field-mgr__btn-add { padding: 5px 14px; background: #409eff; color: #fff; border: none; border-radius: 4px; cursor: pointer; font-size: 12px; }
.meta-field-mgr__btn-add:disabled { opacity: 0.4; cursor: not-allowed; }
.meta-field-mgr__btn-add:hover:not(:disabled) { background: #66b1ff; }
.meta-field-mgr__confirm { padding: 12px 16px; border-top: 1px solid #eee; background: #fef0f0; }
.meta-field-mgr__confirm p { margin: 0 0 8px; font-size: 13px; color: #333; }
.meta-field-mgr__confirm-actions { display: flex; gap: 8px; justify-content: flex-end; }
.meta-field-mgr__btn-cancel { padding: 4px 12px; border: 1px solid #ddd; border-radius: 3px; background: #fff; cursor: pointer; font-size: 12px; }
.meta-field-mgr__btn-delete { padding: 4px 12px; background: #f56c6c; color: #fff; border: none; border-radius: 3px; cursor: pointer; font-size: 12px; }
.meta-field-mgr__status { padding: 8px 16px; text-align: center; color: #999; font-size: 12px; }
.meta-field-mgr__error { padding: 8px 16px; color: #f56c6c; font-size: 12px; }
</style>
