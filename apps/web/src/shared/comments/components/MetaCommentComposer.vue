<!--
  S3a (comments shared FE kit extraction): moved verbatim from
  multitable/components/MetaCommentComposer.vue — same template, script, scoped styles, class
  names, and testids (only import PATHS changed, see script block). multitable/components/
  MetaCommentComposer.vue is now a re-export shim at the old path (kept only because 3 frozen
  specs — multitable-comment-composer, meta-comment-composer-i18n, meta-comment-composer-
  migration — import it from there).
-->
<template>
  <div class="meta-comment-composer">
    <div v-if="selectedMentions.length" class="meta-comment-composer__mentions">
      <button
        v-for="mention in selectedMentions"
        :key="mention.id"
        class="meta-comment-composer__mention-chip"
        type="button"
        :disabled="disabled || submitting"
        @click="removeMention(mention.id)"
      >
        <span>@{{ mention.label }}</span>
        <span aria-hidden="true">&times;</span>
      </button>
    </div>
    <div class="meta-comment-composer__input-shell">
      <textarea
        ref="textareaRef"
        :value="modelValue"
        class="meta-comment-composer__textarea"
        :placeholder="placeholder"
        rows="2"
        :disabled="disabled || submitting"
        @input="onInput"
        @keydown.down.prevent="onNavigateSuggestion(1)"
        @keydown.up.prevent="onNavigateSuggestion(-1)"
        @keydown.tab.prevent="onSelectActiveSuggestion"
        @keydown.esc.prevent="dismissSuggestions"
        @keydown.enter.ctrl.prevent="submit"
        @keydown.enter.meta.prevent="submit"
      />
      <div
        v-if="showSuggestions"
        class="meta-comment-composer__suggestions"
        role="listbox"
        :aria-label="l('comment.mentionSuggestionsAria')"
      >
        <!-- #5795: the mention search is server-side and refuses a term-less roster. A bare `@` gets the
             `requiresQuery` marker back: a prompt, not an empty result. -->
        <div
          v-if="showMentionSearchHint"
          class="meta-comment-composer__suggestion-hint"
          data-test="comment-mention-search-required"
          aria-live="polite"
        >{{ l('comment.mentionTypeToSearch') }}</div>
        <button
          v-for="suggestion in filteredSuggestions"
          :key="suggestion.id"
          class="meta-comment-composer__suggestion"
          :class="{ 'meta-comment-composer__suggestion--active': activeSuggestionId === suggestion.id }"
          type="button"
          :aria-selected="activeSuggestionId === suggestion.id"
          @click="selectSuggestion(suggestion)"
        >
          <strong>@{{ suggestion.label }}</strong>
          <small v-if="suggestion.subtitle">{{ suggestion.subtitle }}</small>
        </button>
      </div>
    </div>
    <div class="meta-comment-composer__footer">
      <span class="meta-comment-composer__hint">{{ composerHint }}</span>
      <MtButton variant="primary" class="meta-comment-composer__submit" :disabled="submitting || disabled || !modelValue.trim()" @click="submit">
        {{ submitButtonLabel }}
      </MtButton>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useLocale } from '../../../composables/useLocale'
import type { MetaCommentMentionSearch, MetaCommentMentionSuggestion } from '../types'
import { commentLabel, type MetaCommentLabelKey } from '../utils/meta-comment-labels'
// Disclosed real coupling (S3a): the submit button still comes from multitable/ui's MtButton —
// a presentation-only, token-styled design-system primitive with no comment/multitable business
// logic of its own, but today used ONLY by multitable views (verified: nothing outside
// apps/web/src/multitable imports multitable/ui). Duplicating it into shared/comments would
// create a second source of truth for button styling; inlining a native <button> would change
// the rendered DOM and violate the byte-identical requirement. Retained as-is rather than forced
// into a leaky abstraction — a real cross-directory dependency the original reuse analysis
// missed, not an oversight here.
import { MtButton } from '../../../multitable/ui'

const props = withDefaults(defineProps<{
  modelValue: string
  suggestions?: MetaCommentMentionSuggestion[]
  initialMentions?: MetaCommentMentionSuggestion[]
  submitting?: boolean
  disabled?: boolean
  placeholder?: string
  submitLabel?: string
  submitKind?: 'send' | 'save'
  /**
   * #5795: server-side mention search supplied by the host (the multitable workbench). When present,
   * the `@query` being typed is sent to it (debounced) and its answer is merged ahead of the static
   * `suggestions`; a term-less `@` renders the "type to search" hint the server's `requiresQuery`
   * marker asks for. When absent (approval comments) the static list behaves exactly as before.
   */
  mentionSearch?: MetaCommentMentionSearch | null
}>(), {
  suggestions: () => [],
  initialMentions: () => [],
  mentionSearch: null,
  submitting: false,
  disabled: false,
  placeholder: 'Add a comment...',
  submitLabel: 'Send',
  submitKind: 'send',
})

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
  (e: 'submit', payload: { content: string; mentions: string[] }): void
}>()

const textareaRef = ref<HTMLTextAreaElement | null>(null)
const selectedMentions = ref<MetaCommentMentionSuggestion[]>([])
const activeSuggestionIndex = ref(0)
const suggestionsDismissed = ref(false)
const { isZh } = useLocale()
const l = (key: MetaCommentLabelKey) => commentLabel(key, isZh.value)
const mentionMatch = computed(() => props.modelValue.match(/(?:^|\s)@([^\s@]*)$/))
const mentionQuery = computed(() => mentionMatch.value?.[1] ?? '')

// #5795 server-side mention search state. `remoteQuery` is the (trimmed) term `remoteSuggestions`
// answer; while a newer term is in flight the older answer is still shown, narrowed client-side.
const MENTION_SEARCH_DEBOUNCE_MS = 150
const remoteSuggestions = ref<MetaCommentMentionSuggestion[]>([])
const remoteQuery = ref<string | null>(null)
const remoteRequiresQuery = ref(false)
let mentionSearchSeq = 0
let mentionSearchTimer: ReturnType<typeof setTimeout> | null = null

const filteredSuggestions = computed(() => {
  const query = mentionQuery.value.trim().toLowerCase()
  const matchesQuery = (suggestion: MetaCommentMentionSuggestion) => {
    return suggestion.label.toLowerCase().includes(query) || suggestion.id.toLowerCase().includes(query)
  }
  // The server already matched the CURRENT term (name / email / id), so its answer is not re-filtered:
  // an email-only match must not vanish client-side. A stale answer is narrowed like the static list
  // (and dropped entirely under a bare `@`, where it would otherwise show unfiltered).
  const remoteIsCurrent = remoteQuery.value !== null && remoteQuery.value.toLowerCase() === query
  const remote = remoteIsCurrent
    ? remoteSuggestions.value
    : query ? remoteSuggestions.value.filter(matchesQuery) : []
  const local = query ? props.suggestions.filter(matchesQuery) : props.suggestions
  const seen = new Set<string>()
  return [...remote, ...local]
    .filter((suggestion) => {
      if (seen.has(suggestion.id)) return false
      seen.add(suggestion.id)
      return !selectedMentions.value.some((item) => item.id === suggestion.id)
    })
    .slice(0, 6)
})

const showMentionSearchHint = computed(() => (
  Boolean(props.mentionSearch)
  && Boolean(mentionMatch.value)
  && remoteRequiresQuery.value
  && remoteQuery.value === mentionQuery.value.trim()
))

const showSuggestions = computed(() => {
  if (!props.modelValue.trim()) return false
  if (props.disabled || props.submitting) return false
  if (suggestionsDismissed.value) return false
  return Boolean(mentionMatch.value) && (filteredSuggestions.value.length > 0 || showMentionSearchHint.value)
})

function resetMentionSearch() {
  mentionSearchSeq += 1
  remoteSuggestions.value = []
  remoteQuery.value = null
  remoteRequiresQuery.value = false
}

async function runMentionSearch(search: MetaCommentMentionSearch, query: string) {
  const seq = ++mentionSearchSeq
  try {
    const result = await search(query)
    if (seq !== mentionSearchSeq) return
    remoteSuggestions.value = Array.isArray(result?.items) ? result.items : []
    remoteRequiresQuery.value = result?.requiresQuery === true
    remoteQuery.value = query
  } catch {
    if (seq !== mentionSearchSeq) return
    remoteSuggestions.value = []
    remoteRequiresQuery.value = false
    remoteQuery.value = query
  }
}

watch(
  () => (props.mentionSearch && mentionMatch.value ? mentionQuery.value.trim() : null),
  (query) => {
    if (mentionSearchTimer !== null) {
      clearTimeout(mentionSearchTimer)
      mentionSearchTimer = null
    }
    const search = props.mentionSearch
    if (query === null || !search) {
      resetMentionSearch()
      return
    }
    mentionSearchTimer = setTimeout(() => {
      mentionSearchTimer = null
      void runMentionSearch(search, query)
    }, MENTION_SEARCH_DEBOUNCE_MS)
  },
  // A draft restored/edited with a trailing `@term` searches on mount too (the static list already
  // shows suggestions for such a draft on mount).
  { immediate: true },
)

onBeforeUnmount(() => {
  if (mentionSearchTimer !== null) clearTimeout(mentionSearchTimer)
  mentionSearchTimer = null
  mentionSearchSeq += 1
})

const submitButtonLabel = computed(() => {
  if (!props.submitting) return props.submitLabel
  return props.submitKind === 'save' ? l('comment.submitSaving') : l('comment.submitSending')
})

const activeSuggestion = computed(() => {
  if (!showSuggestions.value || filteredSuggestions.value.length === 0) return null
  const normalizedIndex = Math.min(activeSuggestionIndex.value, filteredSuggestions.value.length - 1)
  return filteredSuggestions.value[normalizedIndex] ?? null
})

const activeSuggestionId = computed(() => activeSuggestion.value?.id ?? null)

const composerHint = computed(() => (
  showSuggestions.value && filteredSuggestions.value.length > 0 ? l('comment.hintWithMention') : l('comment.hintBase')
))

watch(
  () => props.initialMentions,
  (nextMentions) => {
    const seen = new Set<string>()
    selectedMentions.value = (nextMentions ?? []).filter((mention) => {
      if (!mention?.id || seen.has(mention.id)) return false
      seen.add(mention.id)
      return true
    })
  },
  { immediate: true, deep: true },
)

watch(
  filteredSuggestions,
  (nextSuggestions) => {
    if (nextSuggestions.length === 0) {
      activeSuggestionIndex.value = 0
      return
    }
    if (activeSuggestionIndex.value >= nextSuggestions.length) {
      activeSuggestionIndex.value = 0
    }
  },
  { immediate: true },
)

watch(
  () => props.modelValue,
  () => {
    suggestionsDismissed.value = false
  },
)

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function hasMentionText(content: string, mention: MetaCommentMentionSuggestion): boolean {
  const plainMentionRegex = new RegExp(`(^|\\s)@${escapeRegex(mention.label)}(?=\\s|$)`)
  const tokenMentionRegex = new RegExp(`@\\[${escapeRegex(mention.label)}\\]\\(${escapeRegex(mention.id)}\\)`)
  return plainMentionRegex.test(content) || tokenMentionRegex.test(content)
}

function serializeContent(content: string): string {
  let next = content
  for (const mention of selectedMentions.value) {
    const token = `@[${mention.label}](${mention.id})`
    const tokenRegex = new RegExp(`@\\[${escapeRegex(mention.label)}\\]\\(${escapeRegex(mention.id)}\\)`)
    if (tokenRegex.test(next)) continue
    const plainMentionRegex = new RegExp(`(^|\\s)@${escapeRegex(mention.label)}(?=\\s|$)`, 'g')
    next = next.replace(plainMentionRegex, (_match, prefix: string) => `${prefix}${token}`)
  }
  return next
}

function onInput(event: Event) {
  const value = (event.target as HTMLTextAreaElement).value
  selectedMentions.value = selectedMentions.value.filter((mention) => hasMentionText(value, mention))
  activeSuggestionIndex.value = 0
  suggestionsDismissed.value = false
  emit('update:modelValue', value)
}

function removeMention(id: string) {
  selectedMentions.value = selectedMentions.value.filter((item) => item.id !== id)
}

function selectSuggestion(suggestion: MetaCommentMentionSuggestion) {
  const nextValue = props.modelValue.replace(/(?:^|\s)@([^\s@]*)$/, (match) => {
    const prefix = match.startsWith(' ') ? ' ' : ''
    return `${prefix}@${suggestion.label} `
  })
  selectedMentions.value = [...selectedMentions.value, suggestion]
  activeSuggestionIndex.value = 0
  suggestionsDismissed.value = false
  emit('update:modelValue', nextValue)
  void nextTick(() => {
    textareaRef.value?.focus()
    const caret = nextValue.length
    textareaRef.value?.setSelectionRange(caret, caret)
  })
}

function onNavigateSuggestion(direction: 1 | -1) {
  if (!showSuggestions.value || filteredSuggestions.value.length === 0) return
  activeSuggestionIndex.value = (activeSuggestionIndex.value + direction + filteredSuggestions.value.length) % filteredSuggestions.value.length
}

function onSelectActiveSuggestion() {
  if (!showSuggestions.value || !activeSuggestion.value) return
  selectSuggestion(activeSuggestion.value)
}

function dismissSuggestions() {
  if (!showSuggestions.value) return
  suggestionsDismissed.value = true
}

function submit() {
  const content = props.modelValue.trim()
  if (!content || props.disabled || props.submitting) return
  emit('submit', {
    content: serializeContent(content),
    mentions: selectedMentions.value.map((item) => item.id),
  })
}
</script>

<style scoped>
.meta-comment-composer { display: flex; flex-direction: column; gap: 8px; }
.meta-comment-composer__mentions { display: flex; flex-wrap: wrap; gap: 6px; }
.meta-comment-composer__mention-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid #bfdbfe;
  background: #eff6ff;
  color: #1d4ed8;
  border-radius: 999px;
  padding: 4px 10px;
  font-size: 12px;
  cursor: pointer;
}
.meta-comment-composer__input-shell { position: relative; }
.meta-comment-composer__textarea {
  width: 100%;
  min-height: 58px;
  padding: 8px 10px;
  border: 1px solid #d1d5db;
  border-radius: 8px;
  font-size: 13px;
  resize: vertical;
}
.meta-comment-composer__suggestions {
  position: absolute;
  left: 0;
  right: 0;
  bottom: calc(100% + 6px);
  display: flex;
  flex-direction: column;
  gap: 2px;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  background: #fff;
  box-shadow: 0 10px 30px rgba(15, 23, 42, 0.12);
  padding: 6px;
  z-index: 10;
}
.meta-comment-composer__suggestion {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  border: none;
  background: transparent;
  border-radius: 6px;
  padding: 8px 10px;
  cursor: pointer;
}
.meta-comment-composer__suggestion:hover { background: #f8fafc; }
.meta-comment-composer__suggestion--active { background: #eff6ff; }
.meta-comment-composer__suggestion small { color: #64748b; }
.meta-comment-composer__suggestion-hint { padding: 8px 10px; color: #64748b; font-size: 12px; }
.meta-comment-composer__footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.meta-comment-composer__hint { color: #6b7280; font-size: 12px; }
/* .meta-comment-composer__submit: the submit control is now <MtButton variant="primary"> (token-styled
   via --ms-color-primary); its bespoke hardcoded-hex CSS was removed (P2-1c). Class kept for selector
   stability. mention-chip stays bespoke (a domain chip, not a generic action button). */
.meta-comment-composer__mention-chip:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
