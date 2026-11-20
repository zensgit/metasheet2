<template>
  <div class="meta-flow-lib" data-automation-flow-library="true">
    <div class="meta-flow-lib__tabs">
      <button
        v-for="tab in TABS"
        :key="tab"
        type="button"
        class="meta-flow-lib__tab"
        :class="{ 'meta-flow-lib__tab--active': activeTab === tab }"
        :data-flow-tab="tab"
        :aria-pressed="activeTab === tab"
        @click="activeTab = tab"
      >{{ automationLabel(tab === 'library' ? 'editor.libraryTab' : 'editor.gatesTab', isZh) }}</button>
    </div>

    <div v-if="activeTab === 'library'" class="meta-flow-lib__body" data-flow-library-body="true">
      <p class="meta-flow-lib__hint">{{ automationLabel('editor.libraryHint', isZh) }}</p>
      <section
        v-for="group in groups"
        :key="group.category"
        class="meta-flow-lib__group"
        :data-library-group="group.category"
      >
        <h4 class="meta-flow-lib__group-title">{{ group.label }}</h4>
        <button
          v-for="entry in group.entries"
          :key="entry.type"
          type="button"
          class="meta-flow-lib__item"
          :class="{ 'meta-flow-lib__item--locked': entry.lockedReason !== '' }"
          :data-library-entry="entry.type"
          :data-locked="entry.lockedReason !== '' ? 'true' : 'false'"
          :disabled="entry.lockedReason !== ''"
          :title="entry.lockedReason || entry.description || undefined"
          @click="entry.lockedReason === '' && $emit('pick', entry.type)"
        >
          <span class="meta-flow-lib__dot" :class="`meta-flow-lib__dot--${group.category}`" />
          <span class="meta-flow-lib__item-text">
            <span class="meta-flow-lib__item-label" data-library-label="true">{{ entry.label }}</span>
            <span v-if="entry.description" class="meta-flow-lib__item-desc" data-library-desc="true">{{ entry.description }}</span>
            <span v-if="entry.lockedReason" class="meta-flow-lib__item-reason" data-library-reason="true">
              <span class="meta-flow-lib__lock-badge">{{ automationLabel('editor.libraryLockedBadge', isZh) }}</span>
              <span data-library-reason-text="true">{{ entry.lockedReason }}</span>
            </span>
          </span>
        </button>
      </section>

      <section class="meta-flow-lib__group" data-library-group="coming-soon">
        <h4 class="meta-flow-lib__group-title">{{ automationLabel('editor.libraryComingSoon', isZh) }}</h4>
        <div
          v-for="entry in comingSoon"
          :key="entry.id"
          class="meta-flow-lib__item meta-flow-lib__item--locked meta-flow-lib__item--static"
          :data-library-coming="entry.id"
          :title="entry.reason"
        >
          <span class="meta-flow-lib__dot meta-flow-lib__dot--other" />
          <span class="meta-flow-lib__item-text">
            <span class="meta-flow-lib__item-label" data-library-label="true">{{ entry.label }}</span>
            <span class="meta-flow-lib__item-reason" data-library-reason="true">
              <span class="meta-flow-lib__lock-badge">{{ automationLabel('editor.libraryLockedBadge', isZh) }}</span>
              <span data-library-reason-text="true">{{ entry.reason }}</span>
            </span>
          </span>
        </div>
      </section>
    </div>

    <div v-else class="meta-flow-lib__body" data-flow-gates-body="true">
      <p class="meta-flow-lib__hint">{{ automationLabel('editor.gatesHint', isZh) }}</p>
      <div
        v-for="gate in gates"
        :key="gate.key"
        class="meta-flow-lib__gate"
        :data-gate="gate.key"
        :data-gate-state="gate.state"
      >
        <span class="meta-flow-lib__gate-label">{{ gate.label }}</span>
        <code v-if="gate.feature" class="meta-flow-lib__gate-feature" data-gate-feature="true">{{ gate.feature }}</code>
        <span
          v-if="gate.stateLabel"
          class="meta-flow-lib__gate-state"
          :class="`meta-flow-lib__gate-state--${gate.state}`"
          data-gate-state-label="true"
        >{{ gate.stateLabel }}</span>
        <span v-if="gate.note" class="meta-flow-lib__gate-note" data-gate-note="true">{{ gate.note }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
// Integration assistant stage 1c (register R-99 ③): the rule editor's Flow-mode node library and go-live
// gates. Purely presentational — every entry, lock reason and gate row is computed by the editor from its
// EXISTING Form logic (see automationFlowLibrary.ts). Picking an unlocked entry only EMITS `pick`; the editor
// adds the step through addAction() + the Form select's own type-change path. No inputs, no fetch, no switch.
import { ref } from 'vue'
import { useLocale } from '../../composables/useLocale'
import { automationLabel } from '../utils/meta-automation-labels'
import type { FlowComingSoonEntry, FlowGateRow, FlowLibraryGroup } from '../automationFlowLibrary'
import type { AutomationActionType } from '../types'

defineProps<{
  groups: FlowLibraryGroup[]
  comingSoon: FlowComingSoonEntry[]
  gates: FlowGateRow[]
}>()

defineEmits<{
  (e: 'pick', type: AutomationActionType): void
}>()

const TABS = ['library', 'gates'] as const
const activeTab = ref<(typeof TABS)[number]>('library')

const { isZh } = useLocale()
</script>

<style scoped>
/* 1c: design tokens only (apps/web/src/styles/tokens.css) — no hex / rgb literals (UI foundation style guard). */
.meta-flow-lib {
  margin-top: 10px;
  border: 1px solid var(--ms-border);
  border-radius: var(--ms-radius-lg);
  background: var(--ms-bg-card);
}

.meta-flow-lib__tabs {
  display: flex;
  border-bottom: 1px solid var(--ms-border);
}

.meta-flow-lib__tab {
  font: inherit;
  font-size: 12.5px;
  padding: 7px 14px;
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--ms-text-2);
  cursor: pointer;
}

.meta-flow-lib__tab--active {
  color: var(--ms-color-primary);
  border-bottom-color: var(--ms-color-primary);
  font-weight: 600;
}

.meta-flow-lib__body { padding: 8px 12px 12px; }

.meta-flow-lib__hint {
  margin: 0 0 8px;
  font-size: 12px;
  color: var(--ms-text-3);
}

.meta-flow-lib__group-title {
  margin: 10px 2px 4px;
  font-size: 12px;
  font-weight: 600;
  color: var(--ms-text-3);
}

.meta-flow-lib__item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  width: 100%;
  box-sizing: border-box;
  text-align: left;
  font: inherit;
  color: inherit;
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--ms-radius-md);
  padding: 6px 8px;
  cursor: pointer;
}

.meta-flow-lib__item:hover:not(:disabled):not(.meta-flow-lib__item--static) {
  background: var(--ms-bg-page);
  border-color: var(--ms-border);
}

.meta-flow-lib__item--locked { cursor: not-allowed; }
.meta-flow-lib__item--locked .meta-flow-lib__item-label { color: var(--ms-text-3); }

.meta-flow-lib__dot {
  width: 10px;
  height: 10px;
  margin-top: 4px;
  border-radius: var(--ms-radius-sm);
  flex: none;
  background: var(--ms-text-3);
}

.meta-flow-lib__dot--record { background: var(--ms-color-primary); }
.meta-flow-lib__dot--message { background: var(--ms-color-success); }
.meta-flow-lib__dot--control { background: var(--ms-text-3); }
.meta-flow-lib__dot--integration { background: var(--ms-color-info); }
.meta-flow-lib__dot--approval { background: var(--ms-color-warning); }
.meta-flow-lib__dot--other { background: var(--ms-border); }

.meta-flow-lib__item-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.meta-flow-lib__item-label { font-size: 13px; font-weight: 500; }

.meta-flow-lib__item-desc,
.meta-flow-lib__item-reason {
  font-size: 11.5px;
  color: var(--ms-text-3);
  word-break: break-word;
}

.meta-flow-lib__item-reason { color: var(--ms-text-2); }

.meta-flow-lib__lock-badge {
  display: inline-block;
  font-size: 10.5px;
  border: 1px solid var(--ms-border);
  border-radius: var(--ms-radius-sm);
  padding: 0 4px;
  margin-right: 4px;
  background: var(--ms-bg-page);
  color: var(--ms-text-2);
}

.meta-flow-lib__gate {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 8px;
  padding: 7px 0;
  border-bottom: 1px dashed var(--ms-border);
  font-size: 12.5px;
}

.meta-flow-lib__gate:last-child { border-bottom: 0; }
.meta-flow-lib__gate-label { font-weight: 600; }

.meta-flow-lib__gate-feature {
  font-size: 11px;
  color: var(--ms-text-2);
  background: var(--ms-bg-page);
  border-radius: var(--ms-radius-sm);
  padding: 0 4px;
}

.meta-flow-lib__gate-state {
  margin-left: auto;
  font-size: 11.5px;
  font-weight: 600;
  border: 1px solid currentColor;
  border-radius: 999px;
  padding: 0 8px;
  color: var(--ms-text-2);
}

.meta-flow-lib__gate-state--on,
.meta-flow-lib__gate-state--enabled { color: var(--ms-color-success); }
.meta-flow-lib__gate-state--off,
.meta-flow-lib__gate-state--disabled { color: var(--ms-color-danger); }

.meta-flow-lib__gate-note {
  flex-basis: 100%;
  font-size: 12px;
  color: var(--ms-text-3);
}
</style>
