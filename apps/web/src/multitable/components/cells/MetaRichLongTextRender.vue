<template>
  <!--
    SOLE rich-content `v-html` owner in apps/web/src/multitable. Binds ONLY the
    output of `sanitizeRichLongTextHtml` (DOMPurify, §5 allow-list), which re-runs
    on EVERY bind — the `safeHtml` computed recomputes whenever `html` changes, so
    a parser-introduced mXSS breakout is neutralized on every render, not once.
    No other multitable surface may introduce a user-content `v-html`; drawer /
    form / grid must render through THIS component.

    (The two pre-existing `v-html` in MetaCellRenderer / MetaRecordDrawer are
    self-generated QR-code SVG from `qrSvgFromText`, not user content — out of
    scope for this component. See PR notes.)
  -->
  <div class="meta-rich-longtext" v-html="safeHtml" />
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { sanitizeRichLongTextHtml } from '../../utils/rich-longtext'

const props = defineProps<{
  /** Raw (server-sanitized but re-sanitized here) rich-`longText` HTML value. */
  html: unknown
}>()

// Re-sanitize on every bind (mXSS defense-in-depth, §2.2). `computed` recomputes
// whenever `props.html` changes, so each new value passes through DOMPurify before
// it can reach `v-html`.
const safeHtml = computed(() => sanitizeRichLongTextHtml(props.html))
</script>

<style scoped>
.meta-rich-longtext {
  font-size: 13px;
  line-height: 1.55;
  word-break: break-word;
  white-space: normal;
}
.meta-rich-longtext :deep(p) { margin: 0 0 0.5em; }
.meta-rich-longtext :deep(p:last-child) { margin-bottom: 0; }
.meta-rich-longtext :deep(h1) { font-size: 18px; margin: 0.4em 0 0.3em; }
.meta-rich-longtext :deep(h2) { font-size: 16px; margin: 0.4em 0 0.3em; }
.meta-rich-longtext :deep(h3) { font-size: 14px; margin: 0.4em 0 0.3em; }
.meta-rich-longtext :deep(ul),
.meta-rich-longtext :deep(ol) { margin: 0 0 0.5em; padding-left: 1.4em; }
.meta-rich-longtext :deep(li) { margin: 0.1em 0; }
.meta-rich-longtext :deep(blockquote) {
  margin: 0 0 0.5em;
  padding: 0.2em 0.8em;
  border-left: 3px solid #dcdfe6;
  color: #606266;
}
.meta-rich-longtext :deep(code) {
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', monospace;
  font-size: 12px;
  background: #f6f8fa;
  border-radius: 3px;
  padding: 0 4px;
}
.meta-rich-longtext :deep(pre) {
  margin: 0 0 0.5em;
  padding: 0.6em 0.8em;
  background: #f6f8fa;
  border-radius: 4px;
  overflow-x: auto;
}
.meta-rich-longtext :deep(pre) code { background: none; padding: 0; }
.meta-rich-longtext :deep(a) { color: #2563eb; text-decoration: underline; }
.meta-rich-longtext :deep(a:hover) { color: #1d4ed8; }
</style>
