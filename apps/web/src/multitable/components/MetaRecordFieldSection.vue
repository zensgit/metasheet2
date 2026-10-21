<!--
  Record inspector v3 (design 2026-09-05, docs/development/multitable-record-inspector-v3-design-20260905.md
  §1.3 "Sections", PR-B1): ONE collapsible section of the details tab's field list — a thin
  disclosure WRAPPER around whatever field rows the parent slots in. It owns exactly three things:
    1. the heading button (`aria-expanded` / `aria-controls`, ids minted by `useId()` so two
       sections in the same panel — or two inspectors on one page — never collide),
    2. the expanded/collapsed state — either CONTROLLED by the parent (`expanded` prop +
       `update:expanded` emit; MetaRecordFieldsPanel holds it keyed by section key so §2's disclosure
       survives the section being unmounted while hide-empty leaves it empty — PR-B1 round 3) or, when
       the parent binds nothing, a component-LOCAL `ref` seeded from `defaultExpanded`. Either way
       session-only: nothing is persisted and nothing is read from storage (OD-W2-2 discipline),
    3. the body container the heading controls (rendered even while collapsed, `hidden`, so
       `aria-controls` always resolves to a real element; the slot CONTENT is `v-if`-gated so
       collapsed field controls are not in the DOM — not merely display:none — and therefore never
       Tab stops, never `querySelector` hits, never focus targets). A HEADED body is a landmark:
       `role="region"` + `aria-labelledby` → the heading button (round 2, refuter NIT: round 1 put
       `aria-labelledby` on a role-less `<div>`, which is inert for AT — the region role is what makes
       the label reach a screen reader's landmark list); a headerless body carries neither.
  It deliberately does NOT own the per-field row markup: MetaRecordFieldsPanel.vue keeps its field
  row template + `<style>` byte-for-byte (including the per-field comment-anchor rule the
  comment-affordance lock's `CONSUMER_FILES` guard scans in THAT file), and slots rows in here. A
  headerless section (`heading` absent) renders the slot inside a plain wrapper with no button and no
  collapse state at all — §1 `ordered` (ALWAYS headerless, design §1.3 round 2) and the legacy
  flat-`fields` path; only §2 "hidden in this view" is headed.
  Styling is token-only (UI-foundation lock UF-6, design §4 item 9): every colour reads an existing
  `--ms-*` token from src/styles/tokens.css, no hex/rgb literal and no `var(--x, #fallback)` escape
  hatch — this file is enrolled in tests/ui-foundation-style-guard.spec.ts `TARGET_FILES` with a zero
  allowlist from its introducing slice.
-->
<template>
  <section
    class="meta-record-field-section"
    :class="{ 'meta-record-field-section--headed': hasHeading, 'meta-record-field-section--collapsed': hasHeading && !expanded }"
    :data-section="sectionKey"
  >
    <h4 v-if="hasHeading" class="meta-record-field-section__heading">
      <button
        type="button"
        class="meta-record-field-section__toggle"
        :id="toggleId"
        :aria-expanded="expanded"
        :aria-controls="bodyId"
        :data-testid="`record-field-section-toggle-${sectionKey}`"
        @click="toggleExpanded"
      >
        <span class="meta-record-field-section__chevron" aria-hidden="true">{{ expanded ? '▾' : '▸' }}</span>
        <span class="meta-record-field-section__title">{{ heading }}</span>
      </button>
    </h4>
    <div
      :id="hasHeading ? bodyId : undefined"
      class="meta-record-field-section__body"
      :role="hasHeading ? 'region' : undefined"
      :aria-labelledby="hasHeading ? toggleId : undefined"
      :hidden="hasHeading && !expanded"
    >
      <slot v-if="!hasHeading || expanded" />
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, useId } from 'vue'

const props = withDefaults(defineProps<{
  /** Stable key for this section (e.g. `ordered` / `hidden-in-view` / `flat`) — test/anchor id only. */
  sectionKey: string
  /** Heading text. Absent/null → headerless: no button, no collapse state, slot always rendered. */
  heading?: string | null
  /** Initial expanded state for a headed section when the parent does NOT control `expanded`. */
  defaultExpanded?: boolean
  /**
   * Controlled expanded state (PR-B1 round 3). Bound → the parent owns the state and this component
   * only reports toggles through `update:expanded`; absent/null → component-local state.
   */
  expanded?: boolean | null
}>(), {
  heading: null,
  defaultExpanded: true,
  expanded: null,
})
const emit = defineEmits<{ (e: 'update:expanded', value: boolean): void }>()

const hasHeading = computed(() => typeof props.heading === 'string' && props.heading.length > 0)
// Session-only (OD-W2-2): no storage read/write anywhere in this file. The local ref is the fallback
// for an uncontrolled section; a controlled one reads the prop.
const localExpanded = ref(props.defaultExpanded)
const expanded = computed(() => props.expanded ?? localExpanded.value)
function toggleExpanded() {
  const next = !expanded.value
  localExpanded.value = next
  emit('update:expanded', next)
}
const uid = useId()
const toggleId = `${uid}-toggle`
const bodyId = `${uid}-body`
</script>

<style scoped>
/* Token-only (UF-6): colours are `--ms-*` tokens from src/styles/tokens.css — border-light for the
   section rule, text-2/text-1 for the toggle's rest/hover ink, bg-page for the hover wash, primary
   for the focus ring. No literal fallbacks (the style guard counts those too). */
.meta-record-field-section { margin: 0; padding: 0; }
.meta-record-field-section--headed { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--ms-border-light); }
.meta-record-field-section__heading { margin: 0 0 8px; font-size: 12px; font-weight: 600; }
.meta-record-field-section__toggle {
  display: inline-flex; align-items: center; gap: 6px; max-width: 100%;
  padding: 2px 4px; border: none; border-radius: 4px; background: none;
  color: var(--ms-text-2); font: inherit; cursor: pointer; text-align: left;
}
.meta-record-field-section__toggle:hover { background: var(--ms-bg-page); color: var(--ms-text-1); }
.meta-record-field-section__toggle:focus-visible { outline: 2px solid var(--ms-color-primary); outline-offset: 1px; }
.meta-record-field-section__chevron { display: inline-block; width: 1em; text-align: center; font-size: 11px; }
.meta-record-field-section__title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
