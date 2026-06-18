<template>
  <div v-if="visible" class="meta-person-picker__overlay" @click.self="emit('close')">
    <div class="meta-person-picker" @keydown.esc.stop.prevent="emit('close')" @keydown.enter.stop.prevent="onConfirm">
      <div class="meta-person-picker__header">
        <h4 class="meta-person-picker__title">{{ titleText }}</h4>
        <button class="meta-person-picker__close" :aria-label="pp('personPicker.close')" @click="emit('close')">&times;</button>
      </div>
      <div class="meta-person-picker__search">
        <input v-model="search" class="meta-person-picker__input" :placeholder="searchPlaceholder" @input="onSearch" />
      </div>
      <div v-if="selectedSummaries.length" class="meta-person-picker__selected">
        <div class="meta-person-picker__selected-header">
          <span class="meta-person-picker__selected-label">{{ pp('personPicker.selected') }}</span>
          <button class="meta-person-picker__clear" @click="clearSelection">{{ pp('personPicker.clear') }}</button>
        </div>
        <div class="meta-person-picker__chips">
          <span v-for="item in selectedSummaries" :key="item.id" class="meta-person-picker__chip">
            <span>{{ item.display || item.id }}</span>
            <button type="button" class="meta-person-picker__chip-remove" @click="removeSelected(item.id)">&times;</button>
          </span>
        </div>
      </div>
      <div class="meta-person-picker__body">
        <div v-if="loading" class="meta-person-picker__loading">{{ pp('personPicker.loading') }}</div>
        <div v-else-if="errorMessage" class="meta-person-picker__error">{{ errorMessage }}</div>
        <label v-for="member in members" :key="member.id" class="meta-person-picker__item" data-test="person-picker-member">
          <input type="checkbox" :checked="selected.has(member.id)" @change="toggleSelect(member.id)" />
          <span class="meta-person-picker__item-label">{{ member.display }}</span>
          <span v-if="member.subtitle" class="meta-person-picker__item-sub">{{ member.subtitle }}</span>
        </label>
        <div v-if="!loading && !errorMessage && !members.length" class="meta-person-picker__empty">{{ pp('personPicker.empty') }}</div>
      </div>
      <div class="meta-person-picker__footer">
        <span class="meta-person-picker__count">{{ selectedCountText }}</span>
        <div class="meta-person-picker__actions">
          <button class="meta-person-picker__cancel" @click="emit('close')">{{ pp('personPicker.cancel') }}</button>
          <button class="meta-person-picker__confirm" data-test="person-picker-confirm" @click="onConfirm">{{ pp('personPicker.confirm') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useLocale } from '../../composables/useLocale'
import type { MetaField, PersonSummary } from '../types'
import { multitableClient } from '../api/client'
import { isPersonSingleRecordField } from '../utils/person-fields'
import {
  personPickerLabel,
  personPickerSelectedCount,
  personPickerTitle,
  type MetaPersonPickerLabelKey,
} from '../utils/meta-person-picker-labels'

// Native person (人员) picker. The offered set is the field's assignable member-group DIRECTORY
// (2c-S3, GET .../person-fields/:fieldId/directory) — the SAME active, member-group-scoped set the
// write-time validator accepts (display parity). Stored chips render independently of this list, so
// historical inactive / out-of-restriction values are never dropped (their display polish is 2c-S4).
// Emits userId[] (NOT recordIds) + a personSummaries echo so the chip renders immediately.
const props = defineProps<{
  visible: boolean
  field?: MetaField | null
  sheetId: string
  currentValue?: unknown
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'confirm', payload: { userIds: string[]; summaries: PersonSummary[] }): void
}>()

type PersonMember = { id: string; display: string; subtitle?: string | null }

const search = ref('')
const members = ref<PersonMember[]>([])
const loading = ref(false)
const errorMessage = ref('')
const selected = reactive(new Set<string>())
const summaryById = reactive<Record<string, PersonSummary>>({})
const { isZh } = useLocale()
const pp = (key: MetaPersonPickerLabelKey) => personPickerLabel(key, isZh.value)

// limitSingleRecord default TRUE (matches the codec / legacy person) → single-select unless
// explicitly multi. (No FE permission mirror; the server re-validates membership + the cap.)
const singleSelect = computed(() => isPersonSingleRecordField(props.field))
const titleText = computed(() => personPickerTitle(props.field?.name, isZh.value))
const searchPlaceholder = computed(() => pp('personPicker.searchPlaceholder'))
const selectedCountText = computed(() => personPickerSelectedCount(selected.size, isZh.value))

watch(() => props.visible, async (visible) => {
  if (!visible) {
    if (debounceTimer) clearTimeout(debounceTimer)
    return
  }
  selected.clear()
  Object.keys(summaryById).forEach((id) => delete summaryById[id])
  const currentValue = props.currentValue
  const ids = Array.isArray(currentValue) ? currentValue.map(String) : currentValue ? [String(currentValue)] : []
  ids.forEach((id) => {
    selected.add(id)
    summaryById[id] = { id, display: id }
  })
  search.value = ''
  await loadMembers()
})

async function loadMembers() {
  if (!props.sheetId) return
  const fieldId = props.field?.id
  // Field-aware directory (2c-S3): the offered set is the field's assignable member-group directory —
  // exactly what the write validator accepts. An unsaved field (no id) has no directory yet; stored
  // chips still render from `selected` / `summaryById`, so nothing already-set is dropped.
  if (!fieldId) {
    members.value = []
    return
  }
  loading.value = true
  errorMessage.value = ''
  try {
    const data = await multitableClient.listPersonFieldDirectory(props.sheetId, fieldId, {
      q: search.value || undefined,
    })
    members.value = (data.items ?? []).map((item) => ({
      id: item.userId,
      display: item.name || item.email || item.userId,
      subtitle: item.email ?? null,
    }))
    for (const member of members.value) {
      if (selected.has(member.id) || summaryById[member.id]) {
        summaryById[member.id] = { id: member.id, display: member.display }
      }
    }
  } catch (error: any) {
    members.value = []
    errorMessage.value = error?.message ?? pp('personPicker.errorLoad')
  } finally {
    loading.value = false
  }
}

let debounceTimer: ReturnType<typeof setTimeout> | null = null
function onSearch() {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => loadMembers(), 300)
}

function toggleSelect(id: string) {
  if (selected.has(id)) {
    selected.delete(id)
    return
  }
  if (singleSelect.value) selected.clear()
  selected.add(id)
  const member = members.value.find((item) => item.id === id)
  if (member) summaryById[id] = { id, display: member.display }
}

const selectedSummaries = computed<PersonSummary[]>(() =>
  Array.from(selected).map((id) => summaryById[id] ?? { id, display: id }),
)

function clearSelection() {
  selected.clear()
}

function removeSelected(id: string) {
  selected.delete(id)
}

function onConfirm() {
  const userIds = Array.from(selected)
  emit('confirm', {
    userIds,
    summaries: userIds.map((id) => summaryById[id] ?? { id, display: id }),
  })
}
</script>

<style scoped>
.meta-person-picker__overlay { position: fixed; inset: 0; background: rgba(0,0,0,.3); z-index: 100; display: flex; align-items: center; justify-content: center; }
.meta-person-picker { width: 480px; max-height: 70vh; background: #fff; border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,.15); display: flex; flex-direction: column; }
.meta-person-picker__header { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; border-bottom: 1px solid #eee; }
.meta-person-picker__title { font-size: 14px; font-weight: 600; margin: 0; }
.meta-person-picker__close { border: none; background: none; font-size: 20px; cursor: pointer; color: #999; }
.meta-person-picker__search { padding: 8px 16px; }
.meta-person-picker__input { width: 100%; padding: 6px 10px; border: 1px solid #ddd; border-radius: 4px; font-size: 13px; }
.meta-person-picker__selected { padding: 0 16px 8px; border-bottom: 1px solid #f0f0f0; }
.meta-person-picker__selected-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.meta-person-picker__selected-label { font-size: 12px; font-weight: 600; color: #606266; }
.meta-person-picker__clear { border: none; background: none; color: #909399; font-size: 12px; cursor: pointer; }
.meta-person-picker__chips { display: flex; flex-wrap: wrap; gap: 6px; }
.meta-person-picker__chip { display: inline-flex; align-items: center; gap: 6px; padding: 2px 8px; border-radius: 999px; background: #ecf5ff; color: #409eff; font-size: 12px; }
.meta-person-picker__chip-remove { border: none; background: none; color: inherit; cursor: pointer; font-size: 14px; line-height: 1; padding: 0; }
.meta-person-picker__body { flex: 1; overflow-y: auto; padding: 0 16px; max-height: 300px; }
.meta-person-picker__item { display: flex; align-items: center; gap: 8px; padding: 6px 0; font-size: 13px; cursor: pointer; }
.meta-person-picker__item-sub { color: #909399; font-size: 12px; margin-left: auto; }
.meta-person-picker__loading, .meta-person-picker__empty, .meta-person-picker__error { text-align: center; padding: 20px; color: #999; font-size: 13px; }
.meta-person-picker__error { color: #f56c6c; }
.meta-person-picker__footer { display: flex; justify-content: space-between; align-items: center; padding: 10px 16px; border-top: 1px solid #eee; }
.meta-person-picker__count { font-size: 12px; color: #666; }
.meta-person-picker__actions { display: flex; gap: 8px; }
.meta-person-picker__cancel { padding: 6px 12px; background: #fff; color: #606266; border: 1px solid #dcdfe6; border-radius: 4px; cursor: pointer; font-size: 13px; }
.meta-person-picker__confirm { padding: 6px 18px; background: #409eff; color: #fff; border: none; border-radius: 4px; cursor: pointer; font-size: 13px; }
.meta-person-picker__confirm:hover { background: #66b1ff; }
</style>
