<script setup lang="ts">
import { computed, onBeforeUnmount, ref, useAttrs, watch } from 'vue'
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
const open = ref(false)
const editing = ref(false)
const query = ref('')
const activeIndex = ref(0)
const root = ref<HTMLElement | null>(null)

const searchPlaceholder = computed(() => (isZh.value ? '+8、UTC-5 或城市' : '+8, UTC-5, or a city'))
const placeholder = computed(() => (!String(props.modelValue || '').trim() && props.emptyLabel) ? props.emptyLabel : searchPlaceholder.value)
const queryLabel = computed(() => (isZh.value ? '搜索时区' : 'Search timezones'))

const flatOptions = computed(() => {
  if (props.groups && props.groups.length > 0) {
    return props.groups.flatMap(group => group.options)
  }
  return props.options ?? []
})

const selectedChoice = computed(() => flatOptions.value.find(option => option.value === (props.modelValue || '')))
const selectedLabel = computed(() => selectedChoice.value?.label || String(props.modelValue || ''))
const displayValue = computed(() => (editing.value ? query.value : selectedLabel.value))

function groupLabel(group: TimezoneGroup): string {
  if (group.label) return group.label
  const en = group.labelEn || group.id
  const zh = group.labelZh || en
  if (props.tr) return props.tr(en, zh)
  return isZh.value ? zh : en
}

function matches(choice: TimezoneChoice): boolean {
  return timezoneChoiceMatchesQuery(choice, query.value)
}

type VisibleGroup = { id: string; label: string; options: TimezoneChoice[] }

const visibleGroups = computed<VisibleGroup[]>(() => {
  if (props.groups && props.groups.length > 0) {
    return props.groups
      .map(group => ({
        id: group.id,
        label: groupLabel(group),
        options: group.options.filter(matches),
      }))
      .filter(group => group.options.length > 0)
  }
  const options = (props.options ?? []).filter(matches)
  return options.length > 0 ? [{ id: 'all', label: '', options: [...options] }] : []
})

const visibleOptions = computed(() => visibleGroups.value.flatMap(group => group.options))

function emitValue(value: string): void {
  emit('update:modelValue', value)
}

function commitFromText(text: string): void {
  const trimmed = text.trim()
  if (!trimmed) return
  const exact = flatOptions.value.find(option => option.value.toLowerCase() === trimmed.toLowerCase())
  if (exact) {
    emitValue(exact.value)
    return
  }
  const hits = flatOptions.value.filter(option => timezoneChoiceMatchesQuery(option, trimmed))
  if (hits.length === 1) {
    emitValue(hits[0]!.value)
    return
  }
  if (hits.length === 0) emitValue(trimmed)
}

function choose(option: TimezoneChoice): void {
  emitValue(option.value)
  editing.value = false
  query.value = ''
  open.value = false
}

function onFocus(): void {
  if (attrs.disabled) return
  editing.value = true
  query.value = ''
  open.value = true
  activeIndex.value = Math.max(0, visibleOptions.value.findIndex(option => option.value === props.modelValue))
}

function onInput(event: Event): void {
  const text = (event.target as HTMLInputElement).value
  editing.value = true
  query.value = text
  open.value = true
  activeIndex.value = 0
  const exact = flatOptions.value.find(option => option.value.toLowerCase() === text.trim().toLowerCase())
  if (exact) emitValue(exact.value)
}

function onChange(event: Event): void {
  const text = (event.target as HTMLInputElement).value
  query.value = text
  editing.value = true
  if (!text.trim()) {
    emitValue('')
    return
  }
  commitFromText(text)
}

function onBlur(): void {
  window.setTimeout(() => {
    if (root.value?.contains(document.activeElement)) return
    if (editing.value) commitFromText(query.value)
    editing.value = false
    query.value = ''
    open.value = false
  }, 0)
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    open.value = true
    activeIndex.value = Math.min(activeIndex.value + 1, Math.max(visibleOptions.value.length - 1, 0))
    return
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault()
    open.value = true
    activeIndex.value = Math.max(activeIndex.value - 1, 0)
    return
  }
  if (event.key === 'Escape') {
    editing.value = false
    query.value = ''
    open.value = false
    return
  }
  if (event.key === 'Enter') {
    event.preventDefault()
    const picked = open.value ? visibleOptions.value[activeIndex.value] : undefined
    if (picked && query.value.trim()) {
      choose(picked)
      return
    }
    commitFromText(query.value)
    editing.value = false
    query.value = ''
    open.value = false
  }
}

function onDocumentPointer(event: Event): void {
  const target = event.target
  if (!(target instanceof Node) || !root.value?.contains(target)) open.value = false
}

watch(open, (isOpen) => {
  if (typeof document === 'undefined') return
  if (isOpen) document.addEventListener('pointerdown', onDocumentPointer)
  else document.removeEventListener('pointerdown', onDocumentPointer)
})

onBeforeUnmount(() => {
  if (typeof document === 'undefined') return
  document.removeEventListener('pointerdown', onDocumentPointer)
})
</script>

<template>
  <span ref="root" class="attendance-tz" data-attendance-timezone-field>
    <input
      :id="id"
      :name="name"
      class="attendance-tz__input"
      type="text"
      role="combobox"
      autocomplete="off"
      spellcheck="false"
      data-attendance-timezone-query
      :data-attendance-timezone-value="modelValue || ''"
      :value="displayValue"
      :placeholder="placeholder"
      :aria-label="queryLabel"
      :aria-expanded="open ? 'true' : 'false'"
      aria-autocomplete="list"
      v-bind="attrs"
      @focus="onFocus"
      @input="onInput"
      @change="onChange"
      @blur="onBlur"
      @keydown="onKeydown"
    />
    <ul v-if="open" class="attendance-tz__menu" role="listbox" data-attendance-timezone-menu>
      <template v-for="group in visibleGroups" :key="group.id">
        <li v-if="group.label" class="attendance-tz__group" data-attendance-timezone-group>{{ group.label }}</li>
        <li v-for="option in group.options" :key="`${group.id}-${option.value}`">
          <button
            type="button"
            class="attendance-tz__option"
            role="option"
            data-attendance-timezone-option
            :data-value="option.value"
            :class="{ 'is-active': option.value === modelValue }"
            :aria-selected="option.value === modelValue ? 'true' : 'false'"
            @mousedown.prevent
            @click="choose(option)"
          >
            {{ option.label }}
          </button>
        </li>
      </template>
      <li v-if="query.trim() && visibleOptions.length === 0" class="attendance-tz__empty" data-attendance-search-empty>
        {{ props.tr ? props.tr('No matches', '搜索不到') : (isZh ? '搜索不到' : 'No matches') }}
      </li>
    </ul>
  </span>
</template>

<style scoped>
.attendance-tz {
  position: relative;
  display: block;
  width: 100%;
  min-width: 0;
}

.attendance-tz__input {
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
  padding: 6px 10px;
  border: 1px solid var(--ms-border, #d0d0d0);
  border-radius: 6px;
  background: #fff;
  color: inherit;
  font: inherit;
}

.attendance-tz__menu {
  position: absolute;
  z-index: 30;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  max-height: 240px;
  margin: 0;
  padding: 4px;
  overflow: auto;
  list-style: none;
  border: 1px solid var(--ms-border, #d0d5dd);
  border-radius: 8px;
  background: #fff;
  box-shadow: 0 8px 24px rgba(16, 24, 40, 0.12);
}

.attendance-tz__group {
  padding: 6px 8px 2px;
  color: #667085;
  font-size: 12px;
}

.attendance-tz__option {
  width: 100%;
  padding: 6px 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}

.attendance-tz__option:hover,
.attendance-tz__option.is-active {
  background: #eff4ff;
}

.attendance-tz__empty {
  padding: 6px 8px;
  color: #667085;
  font-size: 12px;
}
</style>
