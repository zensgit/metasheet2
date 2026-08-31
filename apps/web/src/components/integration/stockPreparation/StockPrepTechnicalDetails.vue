<template>
  <details
    class="sp-tech"
    :open="open"
    :data-testid="testid"
    :data-open="open ? 'true' : 'false'"
  >
    <!-- A REAL disclosure. `<summary>` is focusable and operable by Enter/Space with no JS of our
         own, and it is NOT a `<button>` — which is what lets the install page's two "this panel
         carries no control" assertions (V-02's zero-buttons defaults panel, V-03's exactly-one-button
         preflight panel) stay true while the panel gains this affordance. `aria-expanded` is bound
         explicitly rather than left to the implicit mapping so the state is asserted, not assumed. -->
    <summary
      class="sp-tech__summary"
      :aria-expanded="open ? 'true' : 'false'"
      @click.prevent="open = !open"
    >
      {{ summaryLabel }}
    </summary>
    <div class="sp-tech__body">
      <slot />
    </div>
  </details>
</template>

<script setup lang="ts">
// 技术详情(排障用) — the ONE disclosure the whole stock-prep workbench uses.
//
// The workbench shipped rendering our internal identifiers as its primary content, and the owner's
// verdict on the live deployment was 「这些字都太工程化,就算那些实施人员都看不懂」. The fix is not
// deletion — an implementer still needs the objectId, the env var NAME, the route path, the blocker
// code and the paste-able `fix.run` line, and needs them VERBATIM because they are things a person
// copies in order to act. The fix is ORDER: plain language first, the technical detail one click
// away, on every panel, under the same words everywhere.
//
// Why `<details>` rather than a div + a toggle button:
//   * it is a disclosure in the platform's own vocabulary — focusable, Enter/Space operable, and
//     announced as a disclosure by assistive tech without any ARIA of ours;
//   * its content stays IN THE DOM while collapsed, so nothing is hidden from find-in-page, from a
//     screen reader walking the document, or from copy-paste — which matters when the content is a
//     fix line an operator is about to paste into a terminal;
//   * `<summary>` is not a `<button>`, so a panel that must be able to say "there is no control in
//     here" (§4's fences: 只展示,无开关) can still carry one of these.
//
// The open state is OWNED (`:open` + `@click.prevent`) rather than left to the native toggle so that
// `aria-expanded` and `data-open` can never disagree with what is on screen.
import { computed, ref } from 'vue'
import { useLocale } from '../../../composables/useLocale'
import { STOCK_PREP_TECHNICAL_DETAILS_LABEL } from '../../../services/integration/stockPreparation/plainLanguage'

const props = withDefaults(
  defineProps<{
    /** Overrides the shared summary line. Omit it — one wording everywhere is the point. */
    label?: string
    /** Stable testid for the disclosure element. */
    testid?: string
  }>(),
  { label: undefined, testid: undefined },
)

const { locale } = useLocale()

const summaryLabel = computed(() => props.label ?? (
  locale.value === 'zh-CN'
    ? STOCK_PREP_TECHNICAL_DETAILS_LABEL.zh
    : STOCK_PREP_TECHNICAL_DETAILS_LABEL.en
))

const open = ref(false)

defineExpose({ open })
</script>

<style scoped>
.sp-tech {
  margin-top: var(--ms-space-3);
  border-top: 1px solid var(--ms-border-light);
  padding-top: var(--ms-space-2);
}

.sp-tech__summary {
  cursor: pointer;
  color: var(--ms-text-3);
  font-size: 12px;
  list-style: none;
  user-select: none;
}

/* The default marker is a filled triangle that reads as heavier than this line deserves; a small
   caret keeps the affordance visible without competing with the plain-language copy above it. */
.sp-tech__summary::-webkit-details-marker {
  display: none;
}

.sp-tech__summary::before {
  content: '▸';
  display: inline-block;
  width: 1em;
  transition: transform 0.12s ease;
}

.sp-tech[open] > .sp-tech__summary::before {
  transform: rotate(90deg);
}

.sp-tech__summary:hover {
  color: var(--ms-text-2);
}

/* One focus-ring system across the stock-prep surface (same idiom as the H4 retry/stepper rings). */
.sp-tech__summary:focus-visible {
  outline: 2px solid var(--ms-color-primary);
  outline-offset: 1px;
}

.sp-tech__body {
  margin-top: var(--ms-space-2);
  color: var(--ms-text-3);
  font-size: 12px;
  line-height: 1.7;
}

.sp-tech__body :deep(code) {
  font-size: 12px;
  word-break: break-all;
}

.sp-tech__body :deep(dl) {
  margin: 0;
}

.sp-tech__body :deep(dt) {
  margin-top: var(--ms-space-2);
  color: var(--ms-text-2);
}

.sp-tech__body :deep(dd) {
  margin: 0;
}

.sp-tech__body :deep(ul) {
  margin: 0;
  padding-left: var(--ms-space-4);
}

.sp-tech__body :deep(pre) {
  margin: 4px 0 0;
  padding: var(--ms-space-2);
  overflow-x: auto;
  border-radius: 6px;
  background: var(--el-fill-color-light);
  font-size: 12px;
}
</style>
