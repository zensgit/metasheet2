<!--
  Record inspector v3 (design 2026-09-05, docs/development/multitable-record-inspector-v3-design-20260905.md
  §1.3 "Sections", PR-B1): ONE collapsible section of the details tab's field list — a thin
  disclosure WRAPPER around whatever field rows the parent slots in. It owns exactly three things:
    1. the heading button (`aria-expanded` / `aria-controls`, ids minted by `useId()` so two
       sections in the same panel — or two inspectors on one page — never collide),
    2. the expanded/collapsed state (component-LOCAL `ref`, session-only: nothing is persisted and
       nothing is read from storage, OD-W2-2 discipline; a remount starts from `defaultExpanded`),
    3. the body container the heading controls (rendered even while collapsed, `hidden`, so
       `aria-controls` always resolves to a real element; the slot CONTENT is `v-if`-gated so
       collapsed field controls are not in the DOM — not merely display:none — and therefore never
       Tab stops, never `querySelector` hits, never focus targets).
  It deliberately does NOT own the per-field row markup: MetaRecordFieldsPanel.vue keeps its field
  row template + `<style>` byte-for-byte (including the per-field comment-anchor rule the
  comment-affordance lock's `CONSUMER_FILES` guard scans in THAT file), and slots rows in here. A
  headerless section (`heading` absent) renders the slot inside a plain wrapper with no button and no
  collapse state at all — the "§1 headerless when §2 is empty" case and the legacy flat-`fields` path.
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
        @click="expanded = !expanded"
      >
        <span class="meta-record-field-section__chevron" aria-hidden="true">{{ expanded ? '▾' : '▸' }}</span>
        <span class="meta-record-field-section__title">{{ heading }}</span>
      </button>
    </h4>
    <div
      :id="hasHeading ? bodyId : undefined"
      class="meta-record-field-section__body"
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
  /** Initial expanded state for a headed section (component-local, session-only). */
  defaultExpanded?: boolean
}>(), {
  heading: null,
  defaultExpanded: true,
})

const hasHeading = computed(() => typeof props.heading === 'string' && props.heading.length > 0)
// Component-local, session-only (OD-W2-2): no storage read/write anywhere in this file.
const expanded = ref(props.defaultExpanded)
const uid = useId()
const toggleId = `${uid}-toggle`
const bodyId = `${uid}-body`
</script>

<style scoped>
.meta-record-field-section { margin: 0; padding: 0; }
.meta-record-field-section--headed { margin-top: 8px; padding-top: 8px; border-top: 1px solid #eef2f7; }
.meta-record-field-section__heading { margin: 0 0 8px; font-size: 12px; font-weight: 600; }
.meta-record-field-section__toggle {
  display: inline-flex; align-items: center; gap: 6px; max-width: 100%;
  padding: 2px 4px; border: none; border-radius: 4px; background: none;
  color: #606266; font: inherit; cursor: pointer; text-align: left;
}
.meta-record-field-section__toggle:hover { background: #f5f7fa; color: #303133; }
.meta-record-field-section__toggle:focus-visible { outline: 2px solid var(--ms-color-primary, #409eff); outline-offset: 1px; }
.meta-record-field-section__chevron { display: inline-block; width: 1em; text-align: center; font-size: 11px; }
.meta-record-field-section__title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
