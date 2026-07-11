<template>
  <div class="json-assist" :data-testid="`${testId}-json-assist`">
    <button
      type="button"
      class="json-assist__format-button"
      :data-testid="`${testId}-json-format`"
      :disabled="analysis.status !== 'valid'"
      @click="handleFormat"
    >
      {{ bi('格式化', 'Format') }}
    </button>
    <p
      class="json-assist__status"
      :class="`json-assist__status--${analysis.status}`"
      :data-testid="`${testId}-json-status`"
      :data-status="analysis.status"
    >
      {{ statusMessage }}
    </p>
  </div>
</template>

<script setup lang="ts">
// IU-5a (docs/development/integration-ux-workbench-redesign-design-lock-20260706.md §2 IU-5,
// per-site disposition "JSON-assist" for sites 1-4 of the design-lock's §1 audit's 5 raw JSON
// textareas — site 5, the optionSets structured editor, is a separate later slice and is not
// touched here): a shared, site-agnostic "assist" strip mounted *beside* an existing raw
// `<textarea>` (never wrapping/replacing it — the textarea and its `data-testid` stay exactly as
// they were, per the design-lock's §3 zero-behavior-change + "专家能力不降级" locks). Exactly two
// pieces of UI per the disposition's "通则": one format button + one validation status line.
//
// Contract:
// - `modelValue` / `update:modelValue`: the same JSON text the sibling textarea's own `v-model`
//   binds to (nested-prop-mutation pattern, same object the parent's `v-model="x.y"` mutates in
//   place — this component never owns the text, it only offers to rewrite it).
// - `testId`: the sibling textarea's own `data-testid` (e.g. `connection-draft-config`), reused
//   as a prefix so this component's own testids are `${testId}-json-assist` / `-json-format` /
//   `-json-status` — stable, unique per site, and traceable back to the field they assist.
// - Format button: parses the current text and re-serializes it with 2-space indentation
//   (`JSON.parse` -> `JSON.stringify(_, null, 2)`), emitting the formatted text back up. Disabled
//   whenever the text isn't currently valid JSON (nothing sensible to format).
// - Status line: exactly one paragraph, three mutually exclusive states —
//     empty:   shows the per-site `placeholderExample` (values-free — a placeholder shape, never
//              a real business value) so the user has something to start typing from.
//     valid:   a plain confirmation, no content echoed.
//     invalid: a coarse, values-free line/column locator (`analyzeJsonText` from
//              `../../utils/jsonAssist`) — see that module's header comment for why it NEVER
//              touches `JSON.parse`'s own `error.message` (which embeds a snippet of the
//              offending text and would leak secret-shaped input straight into the DOM).
import { computed } from 'vue'
import { useLocale } from '../../composables/useLocale'
import { analyzeJsonText, formatJsonText } from '../../utils/jsonAssist'

const props = defineProps<{
  modelValue: string
  /** Values-free placeholder example (a JSON-shaped string) shown while the field is empty. */
  placeholderExample: string
  /** Prefix for this component's own data-testids — pass the sibling textarea's data-testid. */
  testId: string
}>()

const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const { locale } = useLocale()

function bi(zh: string, en: string): string {
  return locale.value === 'zh-CN' ? zh : en
}

const analysis = computed(() => analyzeJsonText(props.modelValue))

const statusMessage = computed(() => {
  const result = analysis.value
  if (result.status === 'empty') {
    return bi(`示例(占位,非真实值):${props.placeholderExample}`, `Example (placeholder, not a real value): ${props.placeholderExample}`)
  }
  if (result.status === 'valid') {
    return bi('JSON 格式正确', 'Valid JSON')
  }
  if (result.line !== null && result.column !== null) {
    return bi(
      `第 ${result.line} 行第 ${result.column} 列附近的 JSON 格式有误,请检查`,
      `Invalid JSON near line ${result.line}, column ${result.column} — please check`,
    )
  }
  return bi('JSON 格式有误,请检查', 'Invalid JSON — please check')
})

function handleFormat(): void {
  const formatted = formatJsonText(props.modelValue)
  if (formatted === null) return
  emit('update:modelValue', formatted)
}
</script>

<style scoped>
.json-assist {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: var(--ms-space-2);
  margin-top: var(--ms-space-1);
}

.json-assist__format-button {
  flex-shrink: 0;
  border: 1px solid var(--ms-border);
  border-radius: var(--ms-radius-sm);
  background: var(--ms-bg-card);
  color: var(--ms-text-1);
  cursor: pointer;
  font-size: 12px;
  font-weight: 700;
  padding: 4px 10px;
}

.json-assist__format-button:hover:not(:disabled) {
  border-color: var(--ms-color-primary);
}

.json-assist__format-button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.json-assist__status {
  margin: 0;
  flex: 1 1 auto;
  min-width: 0;
  font-size: 12px;
  line-height: 1.5;
  word-break: break-word;
}

.json-assist__status--empty {
  color: var(--ms-text-3);
}

.json-assist__status--valid {
  color: var(--ms-color-success);
}

.json-assist__status--invalid {
  color: var(--ms-color-danger);
  font-weight: 700;
}
</style>
