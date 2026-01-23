<template>
  <div class="link-picker">
    <select
      class="link-picker__select"
      :multiple="multiple"
      :placeholder="placeholder"
      :value="internalValue"
      @change="handleChange"
    >
      <option v-for="option in options" :key="option.id" :value="option.id">
        {{ option.label }}
      </option>
    </select>
    <div v-if="loading" class="link-picker__status">加载中...</div>
    <div v-else-if="error" class="link-picker__status link-picker__status--error">{{ error }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { apiFetch } from '../utils/api'

export type LinkChangePayload = { ids: string[]; displays: string[] }

const props = withDefaults(
  defineProps<{
    modelValue: string[]
    foreignSheetId: string
    displayFieldId?: string
    multiple?: boolean
    apiPrefix?: string
    placeholder?: string
  }>(),
  {
    modelValue: () => [],
    multiple: true,
    apiPrefix: '/api/univer-meta',
    placeholder: '选择关联记录',
  },
)

const emit = defineEmits<{
  (event: 'update:modelValue', value: string[]): void
  (event: 'change', payload: LinkChangePayload): void
}>()

type Option = { id: string; label: string }
const options = ref<Option[]>([])
const loading = ref(false)
const error = ref('')

const internalValue = computed(() => props.modelValue)

async function loadOptions() {
  if (!props.foreignSheetId) {
    options.value = []
    return
  }
  loading.value = true
  error.value = ''
  try {
    const qs = new URLSearchParams({
      sheetId: props.foreignSheetId,
      limit: '200',
      offset: '0',
    })
    const res = await apiFetch(`${props.apiPrefix}/view?${qs.toString()}`)
    const json = (await res.json().catch(() => ({}))) as {
      ok?: boolean
      data?: { rows?: Array<{ id: string; data?: Record<string, unknown> }>; fields?: Array<{ id: string; name?: string }> }
      error?: { message?: string }
    }
    if (!res.ok || !json.ok || !json.data) {
      throw new Error(json.error?.message || `加载失败 (${res.status})`)
    }
    const rows = json.data.rows ?? []
    const fields = json.data.fields ?? []
    let displayFieldId = props.displayFieldId
    if (!displayFieldId && fields.length > 0) {
      displayFieldId = fields[0]?.id
    }
    options.value = rows.map((row) => {
      const data = row.data || {}
      const label = displayFieldId ? String(data[displayFieldId] ?? row.id) : row.id
      return { id: row.id, label }
    })
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
    options.value = []
  } finally {
    loading.value = false
  }
}

function handleChange(event: Event) {
  const target = event.target as HTMLSelectElement
  const selected = Array.from(target.selectedOptions).map((opt) => opt.value)
  emit('update:modelValue', selected)
  const displays = selected.map((id) => options.value.find((opt) => opt.id === id)?.label || id)
  emit('change', { ids: selected, displays })
}

watch(() => props.foreignSheetId, () => loadOptions(), { immediate: true })

onMounted(() => {
  loadOptions()
})
</script>

<style scoped>
.link-picker {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.link-picker__select {
  min-width: 220px;
  min-height: 32px;
  padding: 6px 8px;
  border: 1px solid #d0d7de;
  border-radius: 6px;
  background: #fff;
  font-size: 13px;
}

.link-picker__status {
  font-size: 12px;
  color: #888;
}

.link-picker__status--error {
  color: #d93025;
}
</style>
