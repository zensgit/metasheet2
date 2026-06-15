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
      @keydown.meta.enter.prevent="onConfirm"
      @keydown.ctrl.enter.prevent="onConfirm"
      @keydown.escape.prevent="emit('cancel')"
    />
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { sanitizeRichLongTextHtml } from '../../utils/rich-longtext'

const props = defineProps<{
  /** Current rich-`longText` HTML value (server-sanitized). */
  modelValue: unknown
  isZh?: boolean
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

const ariaToolbar = '富文本格式工具栏'
const ariaContent = '富文本内容编辑区'

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
  emitLive()
}

function onFocus(): void {
  focused.value = true
}

/** Blur = commit. Emit BOTH the final live value and the `change` commit event. */
function onBlur(): void {
  focused.value = false
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
