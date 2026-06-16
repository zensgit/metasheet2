<template>
  <div class="meta-rich-editor">
    <div class="meta-rich-editor__toolbar" role="toolbar" :aria-label="ariaToolbar">
      <button
        v-for="cmd in inlineCommands"
        :key="cmd.command"
        type="button"
        class="meta-rich-editor__btn"
        :title="cmd.label"
        :aria-label="cmd.label"
        :data-command="cmd.command"
        @mousedown.prevent="exec(cmd.command)"
      >{{ cmd.icon }}</button>
      <span class="meta-rich-editor__sep" aria-hidden="true" />
      <button
        v-for="block in blockCommands"
        :key="block.value"
        type="button"
        class="meta-rich-editor__btn"
        :title="block.label"
        :aria-label="block.label"
        :data-block="block.value"
        @mousedown.prevent="formatBlock(block.value)"
      >{{ block.icon }}</button>
      <span class="meta-rich-editor__sep" aria-hidden="true" />
      <button
        type="button"
        class="meta-rich-editor__btn"
        :title="listLabels.ul"
        :aria-label="listLabels.ul"
        data-command="insertUnorderedList"
        @mousedown.prevent="exec('insertUnorderedList')"
      >•≡</button>
      <button
        type="button"
        class="meta-rich-editor__btn"
        :title="listLabels.ol"
        :aria-label="listLabels.ol"
        data-command="insertOrderedList"
        @mousedown.prevent="exec('insertOrderedList')"
      >1≡</button>
      <span class="meta-rich-editor__sep" aria-hidden="true" />
      <button
        type="button"
        class="meta-rich-editor__btn"
        :title="linkLabels.add"
        :aria-label="linkLabels.add"
        data-command="createLink"
        @mousedown.prevent="addLink"
      >🔗</button>
      <button
        type="button"
        class="meta-rich-editor__btn"
        :title="linkLabels.remove"
        :aria-label="linkLabels.remove"
        data-command="unlink"
        @mousedown.prevent="exec('unlink')"
      >⛓</button>
    </div>
    <div class="meta-rich-editor__body">
      <div
        ref="editableRef"
        class="meta-rich-editor__content"
        contenteditable="true"
        role="textbox"
        aria-multiline="true"
        :aria-label="ariaContent"
        data-test="rich-longtext-editor"
        @focus="onFocus"
        @input="onInput"
        @blur="onBlur"
        @paste="onPaste"
        @drop="onDrop"
        @keydown.down="onMentionNavigate(1, $event)"
        @keydown.up="onMentionNavigate(-1, $event)"
        @keydown.enter="onMentionEnter($event)"
        @keydown.tab="onMentionTab($event)"
        @keydown.meta.enter.prevent="onConfirm"
        @keydown.ctrl.enter.prevent="onConfirm"
        @keydown.escape="onEscape($event)"
      />
      <!-- B5 people-mention popover. Renders ONLY when the host fed candidates
           (authenticated hosts: cell editor + drawer). MetaFormView passes no
           candidates → mentionEnabled is false → the popover never shows, gating
           the member directory out of the anonymous public form. -->
      <div
        v-if="showMentionSuggestions"
        class="meta-rich-editor__suggestions"
        role="listbox"
        :aria-label="l('mention.suggestionsAria')"
        data-test="rich-longtext-mention-popover"
      >
        <button
          v-for="suggestion in mentionSuggestionsFiltered"
          :key="suggestion.id"
          type="button"
          class="meta-rich-editor__suggestion"
          :class="{ 'meta-rich-editor__suggestion--active': activeMentionId === suggestion.id }"
          :aria-selected="activeMentionId === suggestion.id"
          data-test="rich-longtext-mention-option"
          @mousedown.prevent="selectMention(suggestion)"
        >
          <strong>@{{ suggestion.label }}</strong>
          <small v-if="suggestion.subtitle">{{ suggestion.subtitle }}</small>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { sanitizeRichLongTextHtml } from '../../utils/rich-longtext'
import {
  detectMentionQuery,
  filterMentionSuggestions,
  insertMentionChipAtRange,
} from '../../utils/rich-longtext-mention'
import type { MetaCommentMentionSuggestion } from '../../types'
import { metaCoreLabel, type MetaCoreLabelKey } from '../../utils/meta-core-labels'

const props = defineProps<{
  /** Current rich-`longText` HTML value (server-sanitized). */
  modelValue: unknown
  isZh?: boolean
  /**
   * People-mention candidates (B5). Fed ONLY by authenticated hosts (cell editor +
   * record drawer) from the workbench's already-loaded `commentMentionSuggestions`
   * — the editor never fetches them itself. MetaFormView (anonymous public) passes
   * nothing, so the member directory is never exposed to anonymous submitters and
   * the @-popover stays inert there. The same candidate shape comments use, so the
   * persisted chip token reconstructs the EXACT comment token `@[label](id)`.
   */
  mentionSuggestions?: MetaCommentMentionSuggestion[]
}>()

const emit = defineEmits<{
  /** Live value on every input — for hosts that buffer locally (form / cell editor). */
  (e: 'update:modelValue', value: string): void
  /**
   * Commit-time value, emitted on blur. The drawer listens to THIS (not the live
   * `update:modelValue`) so it patches the server ONCE per edit session, mirroring
   * the plain `<textarea>`'s `@change` semantics — never a PATCH per keystroke.
   */
  (e: 'change', value: string): void
  (e: 'confirm'): void
  (e: 'cancel'): void
}>()

const editableRef = ref<HTMLDivElement | null>(null)
// True while the user is actively editing this surface — used to suppress
// model→DOM re-sync so a sanitized value flowing back never rewrites innerHTML
// mid-type and jumps the caret.
const focused = ref(false)

const zh = () => props.isZh !== false
// Reuse the cell-editor family's typed label module (B5 mention.* keys). The
// existing toolbar ternaries stay as-is (out of B5 scope, per the map).
const l = (key: MetaCoreLabelKey) => metaCoreLabel(key, zh())

const ariaToolbar = '富文本格式工具栏'
const ariaContent = '富文本内容编辑区'

// --- B5 people-mention popover state ---
// True only when a host actually fed candidates → the popover is structurally
// gated to authenticated hosts (the form view passes none). This is the host
// gate: no FE permission mirror, just "render the affordance when candidates exist".
const mentionEnabled = computed(() => (props.mentionSuggestions?.length ?? 0) > 0)
/** The active "@query" the caret is typing (null when not in a mention). */
const mentionQuery = ref<string | null>(null)
/** Length of the typed `@query` run (chars to replace on select), e.g. `@ja` → 3. */
const mentionQueryLength = ref(0)
const activeMentionIndex = ref(0)

const mentionSuggestionsFiltered = computed<MetaCommentMentionSuggestion[]>(() => {
  if (!mentionEnabled.value || mentionQuery.value === null) return []
  return filterMentionSuggestions(props.mentionSuggestions ?? [], mentionQuery.value)
})

const showMentionSuggestions = computed(
  () => mentionEnabled.value && mentionQuery.value !== null && mentionSuggestionsFiltered.value.length > 0,
)

const activeMention = computed<MetaCommentMentionSuggestion | null>(() => {
  const list = mentionSuggestionsFiltered.value
  if (list.length === 0) return null
  const idx = Math.min(activeMentionIndex.value, list.length - 1)
  return list[idx] ?? null
})
const activeMentionId = computed(() => activeMention.value?.id ?? null)

const inlineCommands = [
  { command: 'bold', icon: 'B', label: zh() ? '加粗' : 'Bold' },
  { command: 'italic', icon: 'I', label: zh() ? '斜体' : 'Italic' },
  { command: 'underline', icon: 'U', label: zh() ? '下划线' : 'Underline' },
  { command: 'strikeThrough', icon: 'S', label: zh() ? '删除线' : 'Strikethrough' },
]
const blockCommands = [
  { value: 'h1', icon: 'H1', label: zh() ? '标题 1' : 'Heading 1' },
  { value: 'h2', icon: 'H2', label: zh() ? '标题 2' : 'Heading 2' },
  { value: 'h3', icon: 'H3', label: zh() ? '标题 3' : 'Heading 3' },
  { value: 'p', icon: '¶', label: zh() ? '正文' : 'Paragraph' },
]
const listLabels = { ul: zh() ? '无序列表' : 'Bullet list', ol: zh() ? '有序列表' : 'Numbered list' }
const linkLabels = { add: zh() ? '插入链接' : 'Insert link', remove: zh() ? '移除链接' : 'Remove link' }

/**
 * Current sanitized HTML of the editable surface. The value is run through the
 * SHARED client sanitizer so the editor never EMITS markup outside the §5
 * allow-list. This is NOT the trust boundary (the server re-sanitizes on write
 * regardless) — it just keeps the model clean and consistent with the render.
 */
function currentValue(): string {
  return sanitizeRichLongTextHtml(editableRef.value?.innerHTML ?? '')
}

/** Live update (every keystroke / command) — buffered hosts only. */
function emitLive(): void {
  emit('update:modelValue', currentValue())
}

function onInput(): void {
  refreshMentionQuery()
  emitLive()
}

function onFocus(): void {
  focused.value = true
}

// --- B5 mention detection + insertion ---

/**
 * Read the plain text from the start of the editable up to the collapsed caret, so
 * `detectMentionQuery` can decide whether the caret is inside an "@query". Returns
 * '' (→ no query) when there is no caret or it is non-collapsed. We walk the caret's
 * own Text node back to its start; that is sufficient for the trigger rule
 * (start-of-text or after whitespace) without flattening the whole DOM.
 */
function textBeforeCaret(): { text: string; range: Range } | null {
  if (!mentionEnabled.value) return null
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return null
  const range = sel.getRangeAt(0)
  // Only detect when the caret sits inside the editable surface.
  const root = editableRef.value
  if (!root || !root.contains(range.startContainer)) return null
  const node = range.startContainer
  // For a Text node, the text up to the caret is the slice [0, startOffset).
  if (node.nodeType === Node.TEXT_NODE) {
    return { text: (node.textContent ?? '').slice(0, range.startOffset), range }
  }
  return null
}

function refreshMentionQuery(): void {
  if (!mentionEnabled.value) {
    mentionQuery.value = null
    return
  }
  const ctx = textBeforeCaret()
  if (!ctx) {
    mentionQuery.value = null
    return
  }
  const detected = detectMentionQuery(ctx.text)
  if (!detected) {
    mentionQuery.value = null
    return
  }
  mentionQuery.value = detected.query
  mentionQueryLength.value = detected.query.length + 1 // include the `@`
  activeMentionIndex.value = 0
}

function dismissMention(): void {
  mentionQuery.value = null
}

/**
 * Replace the typed "@query" at the caret with a mention chip. Uses the live
 * Selection's Range (the REAL caret) and the Range-based insert seam — NOT
 * execCommand — so the selection→insert path is exercised for real. After insert we
 * re-apply the modified Range to the live selection, emit the new (sanitized) value,
 * and dismiss the popover.
 */
function selectMention(suggestion: MetaCommentMentionSuggestion): void {
  const ctx = textBeforeCaret()
  if (!ctx) {
    dismissMention()
    return
  }
  const doc = editableRef.value?.ownerDocument ?? document
  insertMentionChipAtRange(doc, ctx.range, suggestion, mentionQueryLength.value)
  // Re-apply the (now caret-after-chip) range to the live selection.
  const sel = window.getSelection()
  if (sel) {
    sel.removeAllRanges()
    sel.addRange(ctx.range)
  }
  dismissMention()
  emitLive()
}

function onMentionNavigate(direction: 1 | -1, event: KeyboardEvent): void {
  if (!showMentionSuggestions.value) return
  event.preventDefault()
  const len = mentionSuggestionsFiltered.value.length
  activeMentionIndex.value = (activeMentionIndex.value + direction + len) % len
}

function onMentionEnter(event: KeyboardEvent): void {
  // Plain Enter while the popover is open selects the active suggestion; otherwise
  // Enter falls through to its normal newline behaviour. (Cmd/Ctrl+Enter commit is
  // handled by its own dedicated listener and never reaches here.)
  if (event.metaKey || event.ctrlKey) return
  if (!showMentionSuggestions.value || !activeMention.value) return
  event.preventDefault()
  selectMention(activeMention.value)
}

function onMentionTab(event: KeyboardEvent): void {
  if (!showMentionSuggestions.value || !activeMention.value) return
  event.preventDefault()
  selectMention(activeMention.value)
}

function onEscape(event: KeyboardEvent): void {
  // Esc dismisses the popover first (one Esc closes the suggester); a second Esc (or
  // Esc with no popover) cancels the edit, matching the textarea's Esc contract.
  if (showMentionSuggestions.value) {
    event.preventDefault()
    dismissMention()
    return
  }
  event.preventDefault()
  emit('cancel')
}

/** Blur = commit. Emit BOTH the final live value and the `change` commit event. */
function onBlur(): void {
  focused.value = false
  // Dismiss the mention popover on blur. The suggestion buttons use
  // `@mousedown.prevent` so clicking one does NOT blur the editable first — the
  // chip is inserted before any blur fires.
  dismissMention()
  const value = currentValue()
  emit('update:modelValue', value)
  emit('change', value)
}

/**
 * Cmd/Ctrl+Enter = confirm, mirroring the plain textarea's commit keybinding. Push
 * the current value on all three channels (live model, `change` commit, `confirm`)
 * so every host commits correctly: the grid cell editor commits on `confirm`, the
 * drawer on `change`, buffered hosts on `update:modelValue`. (Plain Enter inserts a
 * newline as usual — only the modifier chord commits.)
 */
function onConfirm(): void {
  const value = currentValue()
  emit('update:modelValue', value)
  emit('change', value)
  emit('confirm')
}

/** Paste as PLAIN text only — never trust pasted HTML in the editor surface. */
function onPaste(event: ClipboardEvent): void {
  event.preventDefault()
  const text = event.clipboardData?.getData('text/plain') ?? ''
  // execCommand insertText keeps the caret behavior natural; sanitize on the
  // subsequent input emit covers the result regardless.
  document.execCommand('insertText', false, text)
  emitLive()
}

/**
 * Drop as PLAIN text only — mirror of `onPaste`. A drag-drop of HTML (e.g.
 * `<img src=x onerror=...>`) would otherwise be inserted as live markup into the
 * contenteditable and could fire an inline handler in THIS user's surface before
 * the sanitize-on-emit runs (self-XSS). preventDefault + plain-text insert closes
 * that surface; the emitted value is still sanitized regardless.
 */
function onDrop(event: DragEvent): void {
  event.preventDefault()
  const text = event.dataTransfer?.getData('text/plain') ?? ''
  document.execCommand('insertText', false, text)
  emitLive()
}

function exec(command: string): void {
  editableRef.value?.focus()
  document.execCommand(command, false)
  emitLive()
}

function formatBlock(tag: string): void {
  editableRef.value?.focus()
  // Browsers expect the tag wrapped in <> for formatBlock.
  document.execCommand('formatBlock', false, `<${tag}>`)
  emitLive()
}

function addLink(): void {
  editableRef.value?.focus()
  const url = window.prompt(zh() ? '链接地址 (http/https/mailto)' : 'Link URL (http/https/mailto)')
  if (!url) return
  // The server + render sanitizer reject non-allow-list protocols; we still guard
  // here so an obviously bad scheme never gets inserted.
  if (!/^(?:https?:|mailto:)/i.test(url.trim())) {
    window.alert(zh() ? '仅支持 http/https/mailto 链接' : 'Only http/https/mailto links are allowed')
    return
  }
  document.execCommand('createLink', false, url.trim())
  emitLive()
}

/**
 * Sync the editable DOM from the model. We only write innerHTML when it actually
 * differs from the current (sanitized) DOM so we never stomp the user's caret
 * mid-typing. Incoming value is sanitized before it touches the DOM.
 */
function syncFromModel(): void {
  const el = editableRef.value
  if (!el) return
  // NEVER rewrite innerHTML while the user is editing: a sanitized value flowing
  // back from our own emit (or a normalization round-trip) would stomp the live
  // DOM and jump the caret. Re-sync only applies external changes received while
  // the surface is blurred.
  if (focused.value) return
  const next = sanitizeRichLongTextHtml(props.modelValue)
  if (el.innerHTML !== next) el.innerHTML = next
}

onMounted(() => {
  syncFromModel()
  editableRef.value?.focus()
})

watch(
  () => props.modelValue,
  () => {
    // Only re-sync external changes; the focus guard in syncFromModel prevents a
    // mid-type caret jump from our own emitted value flowing back.
    syncFromModel()
  },
)
</script>

<style scoped>
.meta-rich-editor {
  border: 1px solid #409eff;
  border-radius: 4px;
  overflow: hidden;
  background: #fff;
}
.meta-rich-editor__toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 2px;
  padding: 4px 6px;
  border-bottom: 1px solid #e4e7ed;
  background: #f8fafc;
}
.meta-rich-editor__btn {
  min-width: 26px;
  height: 24px;
  padding: 0 6px;
  border: 1px solid transparent;
  border-radius: 3px;
  background: transparent;
  font-size: 12px;
  color: #475569;
  cursor: pointer;
  line-height: 1;
}
.meta-rich-editor__btn:hover {
  background: #eef2f7;
  border-color: #dbe4f0;
}
.meta-rich-editor__sep {
  width: 1px;
  height: 16px;
  margin: 0 4px;
  background: #e4e7ed;
}
.meta-rich-editor__body {
  position: relative;
}
.meta-rich-editor__content {
  min-height: 96px;
  max-height: 320px;
  overflow-y: auto;
  padding: 8px 10px;
  font-size: 13px;
  line-height: 1.55;
  outline: none;
  word-break: break-word;
}
.meta-rich-editor__suggestions {
  position: absolute;
  left: 8px;
  right: 8px;
  top: 100%;
  margin-top: 2px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 220px;
  overflow-y: auto;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  background: #fff;
  box-shadow: 0 10px 30px rgba(15, 23, 42, 0.12);
  padding: 6px;
  z-index: 20;
}
.meta-rich-editor__suggestion {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  border: none;
  background: transparent;
  border-radius: 6px;
  padding: 8px 10px;
  cursor: pointer;
  text-align: left;
}
.meta-rich-editor__suggestion:hover { background: #f8fafc; }
.meta-rich-editor__suggestion--active { background: #eff6ff; }
.meta-rich-editor__suggestion small { color: #64748b; }
.meta-rich-editor__content :deep(.meta-rich-editor__mention),
.meta-rich-editor__content :deep(span[data-mention-id]) {
  display: inline;
  padding: 0 4px;
  border-radius: 4px;
  background: #eff6ff;
  color: #1d4ed8;
  font-weight: 500;
  white-space: nowrap;
}
.meta-rich-editor__content:empty::before {
  content: attr(data-placeholder);
  color: #c0c4cc;
}
.meta-rich-editor__content :deep(h1) { font-size: 18px; margin: 0.3em 0; }
.meta-rich-editor__content :deep(h2) { font-size: 16px; margin: 0.3em 0; }
.meta-rich-editor__content :deep(h3) { font-size: 14px; margin: 0.3em 0; }
.meta-rich-editor__content :deep(ul),
.meta-rich-editor__content :deep(ol) { padding-left: 1.4em; margin: 0.3em 0; }
.meta-rich-editor__content :deep(a) { color: #2563eb; text-decoration: underline; }
.meta-rich-editor__content :deep(blockquote) {
  margin: 0.3em 0;
  padding: 0.2em 0.8em;
  border-left: 3px solid #dcdfe6;
  color: #606266;
}
</style>
