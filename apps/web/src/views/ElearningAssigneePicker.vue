<template>
  <div class="elearning-assignee-picker" :data-testid="testIdPrefix">
    <label class="elearning-assignee-picker__field">
      <span>{{ label }}</span>
      <input
        v-model="searchText"
        :data-testid="`${testIdPrefix}-search`"
        type="search"
        role="combobox"
        aria-autocomplete="list"
        :aria-expanded="results.length > 0 ? 'true' : 'false'"
        :aria-controls="listId"
        :placeholder="elearningLabel('assigneePicker.searchPlaceholder', isZh)"
        :maxlength="ELEARNING_ASSIGNEE_SEARCH_MAX_QUERY_LENGTH"
        :disabled="disabled"
        autocomplete="off"
        @input="scheduleSearch"
        @keydown.enter.prevent="void runSearch()"
      >
    </label>

    <p
      v-if="selectedLabel"
      class="elearning-assignee-picker__selected"
      :data-testid="`${testIdPrefix}-selected`"
    >
      <span>{{ elearningAssigneeSelected(selectedLabel, isZh) }}</span>
      <button
        type="button"
        :data-testid="`${testIdPrefix}-clear`"
        :disabled="disabled"
        @click="clearSelection"
      >
        {{ elearningLabel('assigneePicker.clear', isZh) }}
      </button>
    </p>

    <p
      v-if="searchState !== 'idle'"
      class="elearning-assignee-picker__status"
      :class="{ 'elearning-assignee-picker__status--error': searchState === 'forbidden' || searchState === 'failed' }"
      :data-testid="`${testIdPrefix}-status`"
      role="status"
      aria-live="polite"
    >
      {{ statusText }}
    </p>

    <ul
      v-if="results.length > 0"
      :id="listId"
      class="elearning-assignee-picker__results"
      role="listbox"
      :data-testid="`${testIdPrefix}-results`"
    >
      <li
        v-for="(candidate, index) in results"
        :key="candidate.id"
        role="option"
        :aria-selected="candidate.id === modelValue.trim() ? 'true' : 'false'"
      >
        <button
          type="button"
          :data-testid="`${testIdPrefix}-option-${index}`"
          :disabled="disabled"
          @click="selectCandidate(candidate)"
        >
          <strong>{{ elearningAssigneeDisplayName(candidate, isZh) }}</strong>
          <small v-if="candidate.name && candidate.email">{{ candidate.email }}</small>
        </button>
      </li>
    </ul>

    <details class="elearning-assignee-picker__paste" :data-testid="`${testIdPrefix}-paste`">
      <summary>{{ elearningLabel('assigneePicker.pasteToggle', isZh) }}</summary>
      <label class="elearning-assignee-picker__field">
        <span>{{ elearningLabel('assigneePicker.pasteLabel', isZh) }}</span>
        <input
          :value="modelValue"
          :data-testid="pasteTestId"
          type="text"
          :disabled="disabled"
          autocomplete="off"
          @input="onPasteInput"
        >
      </label>
    </details>
  </div>
</template>

<script setup lang="ts">
// F13 (no-video rehearsal 2026-10-12): search-as-you-type replacement for the raw user-UUID
// input on the e-learning course forms. Emits ONLY the chosen person's id through v-model, so
// the forms' `targetUserId` payload is unchanged; the display name is kept locally for the
// "selected" line. The paste field stays as a fallback for callers that already hold an id
// (or whose role cannot use the search endpoint).
import { computed, onBeforeUnmount, ref } from 'vue'
import { ElearningApiError } from '../services/elearning'
import {
  ELEARNING_ASSIGNEE_SEARCH_MAX_QUERY_LENGTH,
  searchElearningAssignees,
  type ElearningAssigneeCandidate,
} from '../services/elearningContent'
import {
  elearningAssigneeDisplayName,
  elearningAssigneeSelected,
  elearningLabel,
} from './elearningLabels'

const props = withDefaults(defineProps<{
  modelValue: string
  label: string
  isZh: boolean
  testIdPrefix: string
  pasteTestId: string
  disabled?: boolean
}>(), { disabled: false })

const emit = defineEmits<{ (event: 'update:modelValue', value: string): void }>()

type ElearningAssigneeSearchState = 'idle' | 'loading' | 'empty' | 'forbidden' | 'failed'

const SEARCH_DEBOUNCE_MS = 250

const listId = `${props.testIdPrefix}-listbox`
const searchText = ref('')
const results = ref<ElearningAssigneeCandidate[]>([])
const searchState = ref<ElearningAssigneeSearchState>('idle')
const picked = ref<ElearningAssigneeCandidate | null>(null)
let searchSeq = 0
let debounceTimer: ReturnType<typeof setTimeout> | null = null

const selectedLabel = computed(() => {
  const current = picked.value
  if (!current || current.id !== props.modelValue.trim()) return ''
  return elearningAssigneeDisplayName(current, props.isZh)
})

const statusText = computed(() => {
  switch (searchState.value) {
    case 'loading': return elearningLabel('assigneePicker.searching', props.isZh)
    case 'empty': return elearningLabel('assigneePicker.noMatch', props.isZh)
    case 'forbidden': return elearningLabel('assigneePicker.forbidden', props.isZh)
    case 'failed': return elearningLabel('assigneePicker.failed', props.isZh)
    default: return ''
  }
})

function cancelPendingSearch(): void {
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
}

function scheduleSearch(): void {
  cancelPendingSearch()
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    void runSearch()
  }, SEARCH_DEBOUNCE_MS)
}

async function runSearch(): Promise<void> {
  cancelPendingSearch()
  const seq = ++searchSeq
  const term = searchText.value.trim()
  if (term === '') {
    results.value = []
    searchState.value = 'idle'
    return
  }
  searchState.value = 'loading'
  try {
    const found = await searchElearningAssignees(term)
    if (seq !== searchSeq) return
    results.value = found
    searchState.value = found.length === 0 ? 'empty' : 'idle'
  } catch (error) {
    if (seq !== searchSeq) return
    results.value = []
    searchState.value = error instanceof ElearningApiError && (error.status === 401 || error.status === 403)
      ? 'forbidden'
      : 'failed'
  }
}

function selectCandidate(candidate: ElearningAssigneeCandidate): void {
  if (props.disabled) return
  cancelPendingSearch()
  searchSeq += 1
  picked.value = candidate
  results.value = []
  searchState.value = 'idle'
  searchText.value = ''
  emit('update:modelValue', candidate.id)
}

function clearSelection(): void {
  if (props.disabled) return
  picked.value = null
  emit('update:modelValue', '')
}

function onPasteInput(event: Event): void {
  emit('update:modelValue', (event.target as HTMLInputElement).value)
}

onBeforeUnmount(() => {
  cancelPendingSearch()
  searchSeq += 1
})
</script>

<style scoped>
.elearning-assignee-picker {
  display: grid;
  gap: 8px;
}

.elearning-assignee-picker__field {
  display: grid;
  gap: 6px;
}

.elearning-assignee-picker__field span {
  color: #5f7088;
  font-size: 0.9rem;
}

.elearning-assignee-picker__field input {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  padding: 8px 10px;
  font: inherit;
}

.elearning-assignee-picker__selected {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 0;
  color: #123154;
}

.elearning-assignee-picker__status {
  margin: 0;
  color: #5f7088;
  font-size: 0.9rem;
}

.elearning-assignee-picker__status--error {
  color: #9b1c1c;
}

.elearning-assignee-picker__results {
  display: grid;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
  max-height: 240px;
  overflow-y: auto;
}

.elearning-assignee-picker__results button {
  display: grid;
  width: 100%;
  gap: 2px;
  text-align: left;
  border: 1px solid #dfe7f4;
  border-radius: 8px;
  padding: 6px 10px;
  background: #fff;
  color: #123154;
  cursor: pointer;
}

.elearning-assignee-picker__results small {
  color: #5f7088;
}

.elearning-assignee-picker__paste summary {
  cursor: pointer;
  color: #2563eb;
  font-size: 0.9rem;
}

.elearning-assignee-picker button:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
</style>
