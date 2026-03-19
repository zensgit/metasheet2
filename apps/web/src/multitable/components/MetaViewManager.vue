<template>
  <div v-if="visible" class="meta-view-mgr__overlay" @click.self="emit('close')">
    <div class="meta-view-mgr">
      <div class="meta-view-mgr__header">
        <h4 class="meta-view-mgr__title">Manage Views</h4>
        <button class="meta-view-mgr__close" @click="emit('close')">&times;</button>
      </div>

      <div class="meta-view-mgr__body">
        <div
          v-for="view in views"
          :key="view.id"
          class="meta-view-mgr__row"
          :class="{ 'meta-view-mgr__row--active': view.id === activeViewId }"
        >
          <span class="meta-view-mgr__icon">{{ VIEW_ICONS[view.type] ?? '?' }}</span>

          <!-- Inline rename -->
          <template v-if="editingId === view.id">
            <input
              class="meta-view-mgr__rename"
              :value="editingName"
              @input="editingName = ($event.target as HTMLInputElement).value"
              @keydown.enter="confirmRename(view.id)"
              @keydown.escape="cancelRename"
            />
            <button class="meta-view-mgr__action meta-view-mgr__action--ok" @click="confirmRename(view.id)">&#x2713;</button>
            <button class="meta-view-mgr__action" @click="cancelRename">&#x2717;</button>
          </template>
          <template v-else>
            <span class="meta-view-mgr__name" :title="view.name">{{ view.name }}</span>
            <span class="meta-view-mgr__type">{{ view.type }}</span>
            <button class="meta-view-mgr__action" title="Rename" @click="startRename(view)">&#x270E;</button>
            <button
              class="meta-view-mgr__action meta-view-mgr__action--danger"
              title="Delete"
              :disabled="views.length <= 1"
              @click="onDeleteView(view)"
            >&#x1F5D1;</button>
          </template>
        </div>

        <div v-if="!views.length" class="meta-view-mgr__empty">No views defined</div>
      </div>

      <!-- Add new view -->
      <div class="meta-view-mgr__add-section">
        <div class="meta-view-mgr__add-row">
          <input
            v-model="newViewName"
            class="meta-view-mgr__input"
            placeholder="View name"
            @keydown.enter="onAddView"
          />
          <select v-model="newViewType" class="meta-view-mgr__select">
            <option v-for="t in VIEW_TYPES" :key="t" :value="t">{{ t }}</option>
          </select>
          <button class="meta-view-mgr__btn-add" :disabled="!newViewName.trim()" @click="onAddView">+ Add</button>
        </div>
      </div>

      <!-- Delete confirmation -->
      <div v-if="deleteTarget" class="meta-view-mgr__confirm">
        <p>Delete view <strong>{{ deleteTarget.name }}</strong>? This cannot be undone.</p>
        <div class="meta-view-mgr__confirm-actions">
          <button class="meta-view-mgr__btn-cancel" @click="deleteTarget = null">Cancel</button>
          <button class="meta-view-mgr__btn-delete" @click="confirmDelete">Delete</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import type { MetaView } from '../types'

const VIEW_TYPES = ['grid', 'form', 'kanban', 'gallery', 'calendar', 'timeline'] as const
const VIEW_ICONS: Record<string, string> = {
  grid: '\u2637', form: '\u2263', kanban: '\u2630', gallery: '\u25A6', calendar: '\u2339', timeline: '\u2500',
}

const props = defineProps<{
  visible: boolean
  views: MetaView[]
  sheetId: string
  activeViewId: string
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'create-view', input: { sheetId: string; name: string; type: string }): void
  (e: 'update-view', viewId: string, input: { name?: string }): void
  (e: 'delete-view', viewId: string): void
}>()

const newViewName = ref('')
const newViewType = ref<string>('grid')
const editingId = ref<string | null>(null)
const editingName = ref('')
const deleteTarget = ref<MetaView | null>(null)

function onAddView() {
  const name = newViewName.value.trim()
  if (!name) return
  emit('create-view', { sheetId: props.sheetId, name, type: newViewType.value })
  newViewName.value = ''
}

function startRename(view: MetaView) {
  editingId.value = view.id
  editingName.value = view.name
}

function confirmRename(viewId: string) {
  const name = editingName.value.trim()
  if (name && name !== props.views.find((v) => v.id === viewId)?.name) {
    emit('update-view', viewId, { name })
  }
  cancelRename()
}

function cancelRename() {
  editingId.value = null
  editingName.value = ''
}

function onDeleteView(view: MetaView) {
  deleteTarget.value = view
}

function confirmDelete() {
  if (deleteTarget.value) {
    emit('delete-view', deleteTarget.value.id)
    deleteTarget.value = null
  }
}
</script>

<style scoped>
.meta-view-mgr__overlay { position: fixed; inset: 0; background: rgba(0,0,0,.3); z-index: 100; display: flex; align-items: center; justify-content: center; }
.meta-view-mgr { width: 460px; max-height: 70vh; background: #fff; border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,.15); display: flex; flex-direction: column; }
.meta-view-mgr__header { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; border-bottom: 1px solid #eee; }
.meta-view-mgr__title { font-size: 15px; font-weight: 600; margin: 0; }
.meta-view-mgr__close { border: none; background: none; font-size: 20px; cursor: pointer; color: #999; }
.meta-view-mgr__body { flex: 1; overflow-y: auto; padding: 8px 16px; }
.meta-view-mgr__row { display: flex; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 1px solid #f5f5f5; }
.meta-view-mgr__row--active { background: #f0f7ff; border-radius: 4px; margin: 0 -4px; padding: 6px 4px; }
.meta-view-mgr__icon { width: 24px; text-align: center; color: #999; font-size: 13px; }
.meta-view-mgr__name { flex: 1; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meta-view-mgr__type { font-size: 11px; color: #999; background: #f5f5f5; padding: 1px 6px; border-radius: 3px; }
.meta-view-mgr__rename { flex: 1; padding: 2px 6px; border: 1px solid #409eff; border-radius: 3px; font-size: 13px; }
.meta-view-mgr__action { border: none; background: none; color: #999; cursor: pointer; font-size: 13px; padding: 2px 4px; }
.meta-view-mgr__action:hover { color: #333; }
.meta-view-mgr__action:disabled { opacity: 0.3; cursor: not-allowed; }
.meta-view-mgr__action--ok { color: #67c23a; }
.meta-view-mgr__action--danger:hover { color: #f56c6c; }
.meta-view-mgr__empty { text-align: center; padding: 20px; color: #999; font-size: 13px; }
.meta-view-mgr__add-section { padding: 10px 16px; border-top: 1px solid #eee; }
.meta-view-mgr__add-row { display: flex; gap: 8px; }
.meta-view-mgr__input { flex: 1; padding: 5px 10px; border: 1px solid #ddd; border-radius: 4px; font-size: 13px; }
.meta-view-mgr__select { padding: 5px 8px; border: 1px solid #ddd; border-radius: 4px; font-size: 12px; }
.meta-view-mgr__btn-add { padding: 5px 14px; background: #409eff; color: #fff; border: none; border-radius: 4px; cursor: pointer; font-size: 12px; }
.meta-view-mgr__btn-add:disabled { opacity: 0.4; cursor: not-allowed; }
.meta-view-mgr__btn-add:hover:not(:disabled) { background: #66b1ff; }
.meta-view-mgr__confirm { padding: 12px 16px; border-top: 1px solid #eee; background: #fef0f0; }
.meta-view-mgr__confirm p { margin: 0 0 8px; font-size: 13px; color: #333; }
.meta-view-mgr__confirm-actions { display: flex; gap: 8px; justify-content: flex-end; }
.meta-view-mgr__btn-cancel { padding: 4px 12px; border: 1px solid #ddd; border-radius: 3px; background: #fff; cursor: pointer; font-size: 12px; }
.meta-view-mgr__btn-delete { padding: 4px 12px; background: #f56c6c; color: #fff; border: none; border-radius: 3px; cursor: pointer; font-size: 12px; }
</style>
