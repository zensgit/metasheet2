<template>
  <div
    class="category-candidate-input"
    :class="[attrs.class, { 'category-candidate-input--small': size === 'small' }]"
  >
    <input
      ref="inputEl"
      v-bind="inputAttrs"
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
// `GET /api/approval-templates/categories` endpoint (`listTemplateCategories`). Before this slice
// the two WRITER surfaces (these two views) had zero callers of it — `TemplateCenterView.vue` was
// already a reader (imports and calls it at :277/:353) — so this component adds the first WRITE-side
// wiring, not the endpoint's first caller overall. Goal: kill silent typo'd duplicate categories,
// WITHOUT turning this into a closed set — the design explicitly requires "allow-create" (§3.2), so
// this is an assistive candidate list on top of a plain free-text field, never a hard select.
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
// Candidates are fetched LAZILY — on the field's first focus or first keystroke (whichever opens
// the dropdown first), NEVER on mount — and cached for the lifetime of this component instance (at
// most one request per mounted field, ever; a second focus/open does not re-fetch). This is a
// remedy-round-3 fix (gate 2, P1-1): fetching on mount fired an unstubbed request from every
// production mount, including the two required Playwright harnesses that assert "no failed API
// requests" against a Vite-only (no backend) preview — see `playwright.approval-verification.config.ts`
// / `approval-canvas-sole-surface.spec.ts:211` and its siblings. Filtering is still client-side as
// the user types. The fetch is fully fail-soft: any rejection leaves the candidate list empty, never
// blocks typing or saving, and is never awaited by a caller — category input remains fully usable
// with zero candidates (e.g. offline, the endpoint erroring, or simply never focused), exactly as
// the plain `<el-input>` it replaces always was.
import { computed, ref, useAttrs } from 'vue'
import { listTemplateCategories } from '../api'

// `$attrs` is bound explicitly onto the inner <input> below (via `inputAttrs`, everything except
// `class`), NOT left to Vue's default single-root auto-inherit — the root here is the WRAPPING
// <div> (needed so the candidate <ul> can position against it), and the whole point of this
// component (see file doc comment) is that a testid resolves to the real <input>, not an ancestor.
// Auto-inherit would put attrs on the div as well, and `querySelector` would then return the div
// (document order: ancestor before descendant), not the input.
//
// `class` is the one exception, split out and applied to the ROOT instead (remedy round 3, P3-6):
// the root is what the two call sites' layout (a flex row in `TemplateDetailView.vue`, an
// `el-form-item` in `TemplateAuthoringView.vue`) actually sizes, so a consumer width class
// (`ms-w-240` etc.) must land there — exactly where `el-input`'s own wrapper received it before
// this component replaced `<el-input>`. See the CSS block below for why the default-fill rule is
// deliberately NOT `<style scoped>`.
defineOptions({ inheritAttrs: false })

const props = withDefaults(defineProps<{
  modelValue: string
  disabled?: boolean
  placeholder?: string
  maxlength?: number
  size?: 'default' | 'small'
}>(), {
  disabled: false,
  placeholder: '',
  maxlength: undefined,
  size: 'default',
})

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
}>()

const attrs = useAttrs()
const inputAttrs = computed(() => {
  const { class: _rootClass, ...rest } = attrs
  return rest
})

const inputEl = ref<HTMLInputElement | null>(null)
const candidates = ref<string[]>([])
const open = ref(false)
// Guards the "at most once, ever" cache (design §3 fetch-lazily remedy): set the instant a fetch is
// KICKED OFF (not when it resolves), so two rapid opens before the first request settles still
// collapse into one in-flight call rather than firing a duplicate.
let candidatesRequested = false

function ensureCandidatesLoaded(): void {
  if (candidatesRequested) return
  candidatesRequested = true
  void loadCandidates()
}

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
  ensureCandidatesLoaded()
}

function onFocus(): void {
  open.value = true
  ensureCandidatesLoaded()
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

<style>
/*
  Deliberately UNSCOPED (no `scoped` attribute on this <style> tag), not the repo's usual
  per-component default (remedy round 3, P3-6). The `category-candidate-input*` class names are
  unique to this one file (`git grep -l category-candidate-input apps/web/src` returns only this
  component), so there is no collision risk in dropping the `[data-v-xxxx]` scoping attribute Vue
  would otherwise append to every selector below.

  The reason it MUST be unscoped: `.category-candidate-input`'s default-fill `width: 100%` has to be
  overridable by a plain consumer utility class on the same root element (`ms-w-240` at
  `TemplateDetailView.vue`, `form-layout-utilities.css`). A `scoped` rule compiles to
  `.category-candidate-input[data-v-xxxx]` — one class selector PLUS one attribute selector, i.e.
  specificity (0,2,0) — which always outranks a plain single-class utility rule at (0,1,0); that
  mismatch (`ms-w-240` landing on the scoped inner `<input>`, where the scoped `__field` width rule
  out-specifies it) was gate-2's P2-1/P3-6 finding.

  Below, the default-fill selector is additionally wrapped in `:where(...)`, which contributes ZERO
  specificity — not merely "unscoped" (0,1,0). This is deliberate, not decorative: both call sites
  (`TemplateAuthoringView.vue`, `TemplateDetailView.vue`) are behind route-level `() => import(...)`
  (`router/appRoutes.ts:397,403,409`), so this component's own CSS chunk can load EITHER before or
  after the eagerly-imported `form-layout-utilities.css` (`main.ts:20`) depending on bundler/route
  ordering — an unscoped-but-un-`:where()`'d rule at the SAME (0,1,0) tier as `.ms-w-240` would tie,
  and the tie-break (source order) is NOT guaranteed to favor the utility class the way it does for
  Element Plus's `.el-input { width: 100% }` (loaded eagerly, always first). `:where()` sidesteps the
  ordering question entirely: at (0,0,0) it always loses to a plain class selector, so `ms-w-240`
  wins whenever it is present, and the default 100% fill still applies at the authoring call site
  (no width class passed there) regardless of load order.
*/
:where(.category-candidate-input) {
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

/* `size="small"` (remedy round 3, P3-6): TemplateDetailView.vue's inline category-edit row sizes
   its 编辑/保存/取消 buttons `size="small"` (24px-class Element Plus buttons); this modifier
   restores the matching 24px field height that the plain `<el-input size="small">` it replaced had,
   so the row's controls are visually level again. */
.category-candidate-input--small .category-candidate-input__field {
  height: 24px;
  padding: 0 7px;
  font-size: 12px;
  line-height: 24px;
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
