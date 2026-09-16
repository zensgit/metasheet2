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
        <span>@{{ mentionChipLabel(mention) }}</span>
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
import type { MetaCommentMentionSearch, MetaCommentMentionSelection, MetaCommentMentionSuggestion } from '../types'
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
  /**
   * #5813: opt-in, for a host that unmounts this composer while its draft lives on (the record
   * inspector's comments tab). When the prop is passed (`null` included) the composer reports its picked
   * mentions through `update:mentionSelection`, and a remount restores them from here — see
   * MetaCommentMentionSelection for when a restore is refused. Hosts that leave it out (approval
   * comments, the comments drawer) keep the old behaviour and receive no such event.
   */
  mentionSelection?: MetaCommentMentionSelection | null
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
  (e: 'update:mentionSelection', value: MetaCommentMentionSelection): void
}>()

const textareaRef = ref<HTMLTextAreaElement | null>(null)
const selectedMentions = ref<MetaCommentMentionSuggestion[]>([])
/**
 * #5808: ids of the chips that are TIED TO THE DRAFT TEXT — picked from the suggestions (the pick wrote
 * `@label ` into the draft), or already named in the draft when the host handed the chip over (an
 * edit's starting text). Only these chips follow the text: whenever the draft changes (the user typing,
 * or the host clearing / replacing it after a send or a record switch) a tied chip whose text is gone
 * is dropped. Any other chip — a mention stored only in `mentions`, or an unresolved one — is removed
 * only by clicking it, so text that merely spells its name can neither tie nor drop it.
 */
const textBoundMentionIds = new Set<string>()
/**
 * #5808: what may follow a mention's `@label` in the text — whitespace, the end of the text, or
 * punctuation ("@Alice Fake, please"; "@张三，请看"). Without the punctuation the name was never found,
 * so its `@[label](id)` token was lost on save and deleting its text did not drop the chip.
 * A full stop ends a name only when the text ends or whitespace follows it ("thanks @wang."): inside a
 * word it is part of a longer name or an address ("@wang.li@corp.invalid" is not wang's text).
 * (Declared up here, with the mask below: the immediate `initialMentions` watcher already matches text.)
 */
const MENTION_TEXT_END = '(?=$|\\s|[,;:!?)，。、；：！？）]|\\.(?=$|\\s))'
// #5808: what a matched `@label` is blanked out with while shorter labels are looked for (see
// mentionIdsWithText). A NUL is neither `@` nor whitespace, so blanked text never becomes another mention.
const MENTION_TEXT_MASK = String.fromCharCode(0)
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

// #5813: hand the current selection to a host that keeps it across a remount (see `mentionSelection`).
function publishMentionSelection() {
  if (props.mentionSelection === undefined) return
  const selectedIds = new Set(selectedMentions.value.map((mention) => mention.id))
  emit('update:mentionSelection', {
    initialMentions: props.initialMentions,
    mentions: [...selectedMentions.value],
    textBoundIds: [...textBoundMentionIds].filter((id) => selectedIds.has(id)),
  })
}

watch(
  () => props.initialMentions,
  (nextMentions, previousMentions) => {
    // #5813: on mount only, pick up where an unmounted composer left off — if the host still passes the
    // `initialMentions` that selection was built from. A different array means a new or ended edit (or a
    // record switch) happened meanwhile, which resets the selection exactly as it would have here.
    const kept = previousMentions === undefined ? props.mentionSelection : null
    if (kept && kept.initialMentions === nextMentions) {
      selectedMentions.value = [...kept.mentions]
      textBoundMentionIds.clear()
      for (const id of kept.textBoundIds) textBoundMentionIds.add(id)
      // The draft may have been cleared (a send, a record switch) while this composer was unmounted.
      dropTextBoundMentionsMissingFrom(props.modelValue)
    } else {
      const seen = new Set<string>()
      selectedMentions.value = (nextMentions ?? []).filter((mention) => {
        if (!mention?.id || seen.has(mention.id)) return false
        seen.add(mention.id)
        return true
      })
      textBoundMentionIds.clear()
      for (const id of mentionIdsWithText(props.modelValue, selectedMentions.value)) textBoundMentionIds.add(id)
    }
    publishMentionSelection()
  },
  { immediate: true, deep: true },
)

// #5813: every later change (a pick, a removed chip, a chip dropped with its text) is published too.
// `selectedMentions` is only ever reassigned, never mutated in place.
watch(selectedMentions, publishMentionSelection)

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
  (nextValue) => {
    suggestionsDismissed.value = false
    // #5808: runs for every draft change, the host's own included — a host that clears the draft after
    // a send (or replaces it on a record switch) must not leave the sent comment's picks behind.
    dropTextBoundMentionsMissingFrom(nextValue)
  },
)

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function plainMentionPattern(mention: MetaCommentMentionSuggestion, flags?: string): RegExp {
  return new RegExp(`(^|\\s)@${escapeRegex(mention.label)}${MENTION_TEXT_END}`, flags)
}

// A dropped id may stay in textBoundMentionIds: a chip only comes back through a pick (which ties it
// again) or an `initialMentions` reset (which rebuilds the set), so a stale id is never consulted.
function dropTextBoundMentionsMissingFrom(content: string) {
  const withText = mentionIdsWithText(content, selectedMentions.value)
  selectedMentions.value = selectedMentions.value.filter(
    (mention) => !textBoundMentionIds.has(mention.id) || withText.has(mention.id),
  )
}

/**
 * #5808: a mention the host could not name (flagged `unresolved`, or handed over with a blank label).
 * It is shown under a neutral placeholder — never its raw id — is never looked for in the text, and is
 * never written into the body as an `@[label](id)` token (the placeholder is not the person's name).
 * Its id still travels in `mentions`.
 */
function isUnresolvedMention(mention: MetaCommentMentionSuggestion): boolean {
  return mention.unresolved === true || !mention.label?.trim()
}

function mentionChipLabel(mention: MetaCommentMentionSuggestion): string {
  return isUnresolvedMention(mention) ? l('comment.mentionUnknownUser') : mention.label
}

function hasMentionText(content: string, mention: MetaCommentMentionSuggestion): boolean {
  if (isUnresolvedMention(mention)) return false
  const plainMentionRegex = plainMentionPattern(mention)
  const tokenMentionRegex = new RegExp(`@\\[${escapeRegex(mention.label)}\\]\\(${escapeRegex(mention.id)}\\)`)
  return plainMentionRegex.test(content) || tokenMentionRegex.test(content)
}

/**
 * #5808: `mentions` with the longest label first (otherwise in their given order). One label can be the
 * start of another ("Alice" / "Alice Fake", "wang" / "wang.li@corp.invalid"); the longer one has to
 * claim its text first, or the shorter one turns "@Alice Fake" into Alice's token plus " Fake".
 */
function longestLabelFirst(mentions: MetaCommentMentionSuggestion[]): MetaCommentMentionSuggestion[] {
  return [...mentions].sort((a, b) => (b.label?.length ?? 0) - (a.label?.length ?? 0))
}

/**
 * #5808: ids of the `mentions` whose text (`@label`, or its `@[label](id)` token) is in `content`.
 * Labels are tried longest first, and a label's plain text is blanked out before any shorter label is
 * tried, so text that serializes as "Alice Fake" never also counts as Alice's. Mentions that share one
 * label are all tried against the same text (either may be the person meant).
 */
function mentionIdsWithText(content: string, mentions: MetaCommentMentionSuggestion[]): Set<string> {
  const byLabel = new Map<string, MetaCommentMentionSuggestion[]>()
  for (const mention of longestLabelFirst(mentions)) {
    if (isUnresolvedMention(mention)) continue
    const sameLabel = byLabel.get(mention.label)
    if (sameLabel) sameLabel.push(mention)
    else byLabel.set(mention.label, [mention])
  }
  const found = new Set<string>()
  let rest = content
  for (const sameLabel of byLabel.values()) {
    for (const mention of sameLabel) {
      if (hasMentionText(rest, mention)) found.add(mention.id)
    }
    rest = rest.replace(plainMentionPattern(sameLabel[0], 'g'), (_match, prefix: string) => prefix + MENTION_TEXT_MASK)
  }
  return found
}

function serializeContent(content: string): string {
  let next = content
  // Longest label first — see longestLabelFirst.
  for (const mention of longestLabelFirst(selectedMentions.value)) {
    if (isUnresolvedMention(mention)) continue
    const token = `@[${mention.label}](${mention.id})`
    const tokenRegex = new RegExp(`@\\[${escapeRegex(mention.label)}\\]\\(${escapeRegex(mention.id)}\\)`)
    if (tokenRegex.test(next)) continue
    const plainMentionRegex = plainMentionPattern(mention, 'g')
    next = next.replace(plainMentionRegex, (_match, prefix: string) => `${prefix}${token}`)
  }
  return next
}

function onInput(event: Event) {
  const value = (event.target as HTMLTextAreaElement).value
  // #5808: chips are no longer filtered here against the typed text. Filtering every chip on "present
  // in the new text" dropped, on the first keystroke, each mention whose text was never in the draft
  // (an edited comment created with an explicit `mentions` array, or an unresolved one). Chips tied to
  // the text are dropped by the `modelValue` watcher instead (see textBoundMentionIds).
  activeSuggestionIndex.value = 0
  suggestionsDismissed.value = false
  emit('update:modelValue', value)
}

function removeMention(id: string) {
  selectedMentions.value = selectedMentions.value.filter((item) => item.id !== id)
}

function selectSuggestion(suggestion: MetaCommentMentionSuggestion) {
  const nextValue = props.modelValue.replace(/(?:^|\s)@([^\s@]*)$/, (match) => {
    // Keep whichever whitespace preceded the `@` (a newline too): the picked chip is tied to its
    // `@label` text, and "line@label" would not count as that text.
    const prefix = /^\s/.test(match) ? match[0] : ''
    return `${prefix}@${suggestion.label} `
  })
  // #5808: a pick writes `@label ` into the draft, so the chip follows that text from now on.
  textBoundMentionIds.add(suggestion.id)
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
