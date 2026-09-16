<template>
  <div class="category-candidate-input">
    <input
      ref="inputEl"
      v-bind="$attrs"
      :value="modelValue"
      :disabled="disabled"
      :placeholder="placeholder"
      :maxlength="maxlength"
      type="text"
      autocomplete="off"
      class="category-candidate-input__field"
      @input="onInput"
      @focus="onFocus"
      @blur="onBlur"
    />
    <ul
      v-if="open && filteredCandidates.length > 0"
      class="category-candidate-input__list"
      data-testid="category-candidate-list"
    >
      <li
        v-for="candidate in filteredCandidates"
        :key="candidate"
        class="category-candidate-input__item"
        @mousedown.prevent="selectCandidate(candidate)"
      >
        {{ candidate }}
      </li>
    </ul>
  </div>
</template>

<script setup lang="ts">
// approval-form-ux-slice1 (20260916 design §3) — wires the two free-text category inputs
// (TemplateAuthoringView.vue create-time, TemplateDetailView.vue edit-time) to the already-shipped
// `GET /api/approval-templates/categories` endpoint (`listTemplateCategories`), which had zero
// callers before this slice (design §3.1). Goal: kill silent typo'd duplicate categories, WITHOUT
// turning this into a closed set — the design explicitly requires "allow-create" (§3.2), so this
// is an assistive candidate list on top of a plain free-text field, never a hard select.
//
// Hand-rolled instead of `<el-select filterable allow-create>` / `<el-autocomplete>` deliberately
// (design §5-D4): three existing specs drive these two testids with RAW `HTMLInputElement`
// semantics — `container.querySelector('[data-testid=...]') as HTMLInputElement`, then
// `.value = x; .dispatchEvent(new Event('input'))` — and Element Plus's composite inputs do not
// reliably land an arbitrary `data-testid` on the exact inner `<input>` those specs cast to (it can
// land on the outer wrapper instead). A plain native `<input>` as this component's actual field
// removes that ambiguity entirely: the testid always resolves to a real `HTMLInputElement`, and the
// existing specs need no changes for the control swap itself (see the design doc's C3 acceptance).
//
// Candidates are fetched once per mount (not per-keystroke — the list is small and slow-changing;
// this is a spell-check aid, not a live search) and filtered client-side as the user types. The
// fetch is fully fail-soft: any rejection leaves the candidate list empty, never blocks typing or
// saving, and is never awaited by a caller — category input remains fully usable with zero
// candidates (e.g. offline, or the endpoint erroring), exactly as the plain `<el-input>` it replaces
// always was.
import { computed, onMounted, ref } from 'vue'
import { listTemplateCategories } from '../api'

// `$attrs` (data-testid, class, maxlength-if-passed-as-attr, @keyup.* etc.) is bound explicitly
// onto the inner <input> below, NOT left to Vue's default single-root auto-inherit — the root here
// is the WRAPPING <div> (needed so the candidate <ul> can position against it), and the whole point
// of this component (see file doc comment) is that a testid resolves to the real <input>, not an
// ancestor. Auto-inherit would put it on the div as well, and `querySelector` would then return the
// div (document order: ancestor before descendant), not the input.
defineOptions({ inheritAttrs: false })

const props = withDefaults(defineProps<{
  modelValue: string
  disabled?: boolean
  placeholder?: string
  maxlength?: number
}>(), {
  disabled: false,
  placeholder: '',
  maxlength: undefined,
})

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
}>()

const inputEl = ref<HTMLInputElement | null>(null)
const candidates = ref<string[]>([])
const open = ref(false)

onMounted(() => {
  void loadCandidates()
})

async function loadCandidates(): Promise<void> {
  try {
    candidates.value = await listTemplateCategories()
  } catch {
    // Fail-soft (see doc comment above): a broken/offline endpoint must never block typing or
    // saving an arbitrary category value.
    candidates.value = []
  }
}

const filteredCandidates = computed<string[]>(() => {
  const query = props.modelValue.trim().toLowerCase()
  if (!query) return candidates.value
  return candidates.value.filter((candidate) => candidate.toLowerCase().includes(query))
})

function onInput(event: Event): void {
  emit('update:modelValue', (event.target as HTMLInputElement).value)
  open.value = true
}

function onFocus(): void {
  open.value = true
}

function onBlur(): void {
  // Deferred so a candidate's `mousedown` (which fires BEFORE this native `blur`) still lands —
  // `@mousedown.prevent` on the <li> already stops the input from losing focus on that click, but
  // the timeout is kept as a second guard for any pointer path that reaches blur first anyway.
  window.setTimeout(() => {
    open.value = false
  }, 150)
}

function selectCandidate(candidate: string): void {
  // Deliberately does NOT call `inputEl.value?.focus()` — `.focus()` on an element that is not
  // already focused fires a REAL native `focus` event, which would re-enter `onFocus` and set
  // `open` back to `true` in the same tick, undoing the line above (caught by mutation testing:
  // reintroducing a re-focus call here reopens the dropdown immediately after every selection).
  emit('update:modelValue', candidate)
  open.value = false
}
</script>

<style scoped>
.category-candidate-input {
  position: relative;
  display: inline-block;
  width: 100%;
}

.category-candidate-input__field {
  width: 100%;
  box-sizing: border-box;
  height: 32px;
  padding: 0 11px;
  font-size: 14px;
  line-height: 32px;
  color: var(--el-text-color-regular, #606266);
  background-color: var(--el-fill-color-blank, #fff);
  border: 1px solid var(--el-border-color, #dcdfe6);
  border-radius: var(--el-border-radius-base, 4px);
  outline: none;
  transition: border-color 0.2s;
}

.category-candidate-input__field:focus {
  border-color: var(--el-color-primary, #409eff);
}

.category-candidate-input__field:disabled {
  color: var(--el-disabled-text-color, #c0c4cc);
  background-color: var(--el-disabled-bg-color, #f5f7fa);
  cursor: not-allowed;
}

.category-candidate-input__list {
  position: absolute;
  z-index: 10;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  margin: 0;
  padding: 4px 0;
  max-height: 200px;
  overflow-y: auto;
  list-style: none;
  background-color: var(--el-fill-color-blank, #fff);
  border: 1px solid var(--el-border-color-light, #e4e7ed);
  border-radius: var(--el-border-radius-base, 4px);
  box-shadow: var(--el-box-shadow-light, 0 2px 12px 0 rgba(0, 0, 0, 0.1));
}

.category-candidate-input__item {
  padding: 0 12px;
  height: 30px;
  line-height: 30px;
  font-size: 14px;
  color: var(--el-text-color-regular, #606266);
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.category-candidate-input__item:hover {
  background-color: var(--el-fill-color-light, #f5f7fa);
}
</style>
