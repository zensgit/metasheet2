<script setup lang="ts">
import { computed, ref, useAttrs } from 'vue'
import { useLocale } from '../../composables/useLocale'
import { timezoneChoiceMatchesQuery, type TimezoneChoice } from './attendanceTimezones'

defineOptions({ inheritAttrs: false })

type TimezoneGroup = {
  id: string
  label?: string
  labelEn?: string
  labelZh?: string
  options: readonly TimezoneChoice[]
}

const props = defineProps<{
  id?: string
  name?: string
  modelValue?: string
  options?: readonly TimezoneChoice[]
  groups?: readonly TimezoneGroup[]
  emptyLabel?: string
  emptyDisabled?: boolean
  tr?: (en: string, zh: string) => string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const attrs = useAttrs()
const { isZh } = useLocale()
const query = ref('')

const placeholder = computed(() => (isZh.value ? '+8、UTC-5 或城市' : '+8, UTC-5, or a city'))
const queryLabel = computed(() => (isZh.value ? '筛选时区' : 'Filter timezones'))

const flatOptions = computed(() => {
  if (props.groups && props.groups.length > 0) {
    return props.groups.flatMap(group => group.options)
  }
  return props.options ?? []
})

function matches(choice: TimezoneChoice): boolean {
  if (choice.value && choice.value === (props.modelValue || '')) return true
  return timezoneChoiceMatchesQuery(choice, query.value)
}

const filteredGroups = computed(() => {
  if (!props.groups || props.groups.length === 0) return []
  return props.groups
    .map(group => ({
      id: group.id,
      label: group.label || (props.tr ? props.tr(group.labelEn || group.id, group.labelZh || group.labelEn || group.id) : (isZh.value ? (group.labelZh || group.labelEn || group.id) : (group.labelEn || group.labelZh || group.id))),
      options: group.options.filter(matches),
    }))
    .filter(group => group.options.length > 0)
})

const filteredOptions = computed(() => (props.options ?? []).filter(matches))

const orphan = computed(() => {
  const value = String(props.modelValue || '').trim()
  if (!value) return false
  return !flatOptions.value.some(option => option.value === value)
})

function emitValue(value: string): void {
  emit('update:modelValue', value)
}

function onSelect(event: Event): void {
  emitValue((event.target as HTMLSelectElement).value)
}

function commitQuery(event?: Event): void {
  const typed = event?.target instanceof HTMLInputElement ? event.target.value : ''
  const text = (typed || query.value).trim()
  if (!text) return
  const exact = flatOptions.value.find(option => option.value.toLowerCase() === text.toLowerCase())
  if (exact) {
    emitValue(exact.value)
    query.value = ''
    return
  }
  const hits = flatOptions.value.filter(option => timezoneChoiceMatchesQuery(option, text))
  if (hits.length === 1) {
    emitValue(hits[0]!.value)
    query.value = ''
    return
  }
  if (hits.length === 0) emitValue(text)
}
</script>

<template>
  <span class="attendance-tz" data-attendance-timezone-field>
    <input
      v-model="query"
      class="attendance-tz__query"
      type="text"
      data-attendance-timezone-query
      :placeholder="placeholder"
      :aria-label="queryLabel"
      autocomplete="off"
      @change="commitQuery"
      @keydown.enter.prevent="commitQuery"
    />
    <select
      :id="id"
      :name="name"
      :value="modelValue ?? ''"
      v-bind="attrs"
      @change="onSelect"
      @input="onSelect"
    >
      <option v-if="emptyLabel !== undefined" value="" :disabled="emptyDisabled || undefined">{{ emptyLabel }}</option>
      <option v-if="orphan" :value="modelValue">{{ modelValue }}</option>
      <template v-if="groups && groups.length">
        <optgroup v-for="group in filteredGroups" :key="group.id" :label="group.label">
          <option v-for="option in group.options" :key="`${group.id}-${option.value}`" :value="option.value">
            {{ option.label }}
          </option>
        </optgroup>
      </template>
      <template v-else>
        <option v-for="option in filteredOptions" :key="option.value" :value="option.value">
          {{ option.label }}
        </option>
      </template>
    </select>
  </span>
</template>

<style scoped>
.attendance-tz {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
  min-width: 0;
}

.attendance-tz__query,
.attendance-tz select {
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
}
</style>
