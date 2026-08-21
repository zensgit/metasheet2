<!--
  数据来源 / Provenance — a collapsible section at the foot of the record inspector's 详情 tab, and
  the FIRST multitable consumer of the Data Factory DF-N2-2c by-rowId provenance read.

  What a business user gets: opening a record on an integration-fed sheet (e.g. the 备料 landing
  sheet) and expanding 数据来源 shows which pipeline run wrote this row, when, and what happened —
  read-only, cross-run, newest-last (the route already sorts by run_created_at then event_index).

  WIRE (nothing new): GET /api/integration/provenance?rowId=…, via the EXISTING client
  `listIntegrationProvenanceByRow` (services/integration/workbench.ts) — the same function the
  DF-N2-3 operator surface uses. Route table plugins/plugin-integration-core/lib/http-routes.cjs:142,
  handler :5263, gate `requireAccess(req, 'read')`.

  KNOWN LIMITATION (permission visibility): that gate is integration-tier
  (integration:read | integration:write | admin), which is STRONGER than multitable sheet read — so
  a business user who can open the record but holds no integration permission does not see this
  section at all in v1. Widening the gate (or minting a sheet-scoped provenance read) is a separate
  design decision; this component deliberately hides rather than degrades, and never calls a weaker
  route.

  VALUES-FREE: renders only the run identifier (shortened), the pipeline id, timestamps, and the
  frozen event-type / run-status / run-mode vocabularies, plus a two-key whitelist over the
  already-redacted `attrs` (see utils/record-provenance.ts). Never connection params, hosts,
  credentials, or an arbitrary attrs blob.

  LAZY: the GET fires on FIRST EXPAND only — never on record open, so the record-detail critical
  path gains no request. Collapse/re-expand reuses the loaded timeline; a failed load stays
  retryable on the next user-initiated expand (click-driven, so no retry loop).
-->
<template>
  <section v-if="sectionVisible" class="meta-record-provenance" data-test="record-provenance">
    <button
      type="button"
      class="meta-record-provenance__toggle"
      data-test="record-provenance-toggle"
      :aria-expanded="expanded"
      :aria-controls="bodyId"
      :title="expanded ? l('provenance.collapse') : l('provenance.expand')"
      @click="onToggle"
    >
      <span class="meta-record-provenance__caret" aria-hidden="true">{{ expanded ? '▾' : '▸' }}</span>
      <span class="meta-record-provenance__title">{{ l('provenance.title') }}</span>
    </button>
    <div v-if="expanded" :id="bodyId" class="meta-record-provenance__body" data-test="record-provenance-body">
      <div
        v-if="loading"
        class="meta-record-provenance__hint"
        data-test="record-provenance-loading"
      >{{ l('provenance.loading') }}</div>
      <div
        v-else-if="loadFailed"
        class="meta-record-provenance__hint meta-record-provenance__hint--error"
        data-test="record-provenance-error"
      >{{ l('provenance.error') }}</div>
      <ol
        v-else-if="entries.length > 0"
        class="meta-record-provenance__timeline"
        data-test="record-provenance-timeline"
      >
        <li
          v-for="entry in entries"
          :key="`${entry.runId}-${entry.eventIndex}`"
          class="meta-record-provenance__entry"
          data-test="record-provenance-entry"
        >
          <div class="meta-record-provenance__entry-head">
            <strong class="meta-record-provenance__event">{{ eventTypeLabel(entry.eventType) }}</strong>
            <span
              class="meta-record-provenance__status"
              :class="`meta-record-provenance__status--${entry.runStatus}`"
            >{{ runStatusLabel(entry.runStatus) }}</span>
            <span class="meta-record-provenance__time">{{ formatProvenanceTime(entry.runCreatedAt || entry.at) }}</span>
          </div>
          <div class="meta-record-provenance__entry-meta">
            <span>{{ l('provenance.run') }} {{ shortRunId(entry.runId) }}</span>
            <span v-if="entry.pipelineId">{{ l('provenance.pipeline') }} {{ entry.pipelineId }}</span>
            <span v-if="entry.runMode">{{ l('provenance.mode') }} {{ runModeLabel(entry.runMode) }}</span>
          </div>
          <div
            v-if="visibleAttrs(entry.attrs).length > 0"
            class="meta-record-provenance__entry-attrs"
          >
            <span
              v-for="chip in visibleAttrs(entry.attrs)"
              :key="chip.key"
              class="meta-record-provenance__chip"
            >{{ attrKeyLabel(chip.key) }}: {{ chip.value }}</span>
          </div>
        </li>
      </ol>
      <div
        v-else
        class="meta-record-provenance__hint"
        data-test="record-provenance-empty"
      >{{ l('provenance.empty') }}</div>
      <p class="meta-record-provenance__note">{{ l('provenance.readOnlyNote') }}</p>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue'
import type { MetaField, MetaFieldPermission, MetaRecord } from '../types'
import { useLocale } from '../../composables/useLocale'
import { useAuth } from '../../composables/useAuth'
import {
  getDefaultIntegrationScope,
  listIntegrationProvenanceByRow,
  type IntegrationProvenanceTimelineEntry,
} from '../../services/integration/workbench'
import {
  hasProvenanceRowKeyField,
  isProvenanceAccessDeniedError,
  pickVisibleProvenanceAttrs,
  resolveProvenanceRowId,
  shortRunId,
  type ProvenanceAttrChip,
} from '../utils/record-provenance'
import {
  provenanceAttrKeyLabel,
  provenanceEventTypeLabel,
  provenanceRunModeLabel,
  provenanceRunStatusLabel,
  recordProvenanceLabel,
  type MetaRecordProvenanceLabelKey,
} from '../utils/meta-record-provenance-labels'

const props = defineProps<{
  record?: MetaRecord | null
  fields: MetaField[]
  /** Layer-3 RBAC field mask, forwarded as-is by the inspector — honoured for the key column. */
  fieldPermissions?: Record<string, MetaFieldPermission> | null
}>()

const { isZh } = useLocale()
const l = (key: MetaRecordProvenanceLabelKey) => recordProvenanceLabel(key, isZh.value)
const eventTypeLabel = (value: string) => provenanceEventTypeLabel(value, isZh.value)
const runStatusLabel = (value: string) => provenanceRunStatusLabel(value, isZh.value)
const runModeLabel = (value: string) => provenanceRunModeLabel(value, isZh.value)
const attrKeyLabel = (value: string) => provenanceAttrKeyLabel(value, isZh.value)
const visibleAttrs = (attrs: Record<string, unknown> | undefined): ProvenanceAttrChip[] =>
  pickVisibleProvenanceAttrs(attrs)

const { hasPermission } = useAuth()

const bodyId = `meta-record-provenance-${useId()}`
const expanded = ref(false)
const loading = ref(false)
const loaded = ref(false)
const loadFailed = ref(false)
const accessDenied = ref(false)
const entries = ref<IntegrationProvenanceTimelineEntry[]>([])

// The route's own gate, mirrored declaratively so the section is absent (not broken) for actors who
// would be refused — see the KNOWN LIMITATION note in the file header. `accessDenied` is the
// belt-and-braces half: a stale local permission snapshot that still gets a 401/403 from the route
// retracts the section instead of showing an error.
const canReadIntegration = computed(() => hasPermission('integration:read'))
// A sheet without a readable provenance key column is simply not integration-fed.
const sheetIsIntegrationFed = computed(() => hasProvenanceRowKeyField(props.fields, props.fieldPermissions))
const sectionVisible = computed(() => Boolean(
  props.record && canReadIntegration.value && sheetIsIntegrationFed.value && !accessDenied.value,
))

const rowId = computed(() => resolveProvenanceRowId(props.record, props.fields, props.fieldPermissions))

// Record navigation inside the drawer must not show the previous row's lineage.
watch(() => props.record?.id, () => {
  expanded.value = false
  loading.value = false
  loaded.value = false
  loadFailed.value = false
  entries.value = []
})

async function loadTimeline(): Promise<void> {
  if (loaded.value || loading.value) return
  const key = rowId.value
  // A hand-created row on an integration-fed sheet has no key: that is the empty state, not a query.
  if (!key) {
    entries.value = []
    loaded.value = true
    return
  }
  loading.value = true
  loadFailed.value = false
  try {
    entries.value = await listIntegrationProvenanceByRow({ ...getDefaultIntegrationScope(), rowId: key })
    loaded.value = true
  } catch (error) {
    if (isProvenanceAccessDeniedError(error)) {
      accessDenied.value = true
      expanded.value = false
    } else {
      loadFailed.value = true
    }
  } finally {
    loading.value = false
  }
}

function onToggle(): void {
  expanded.value = !expanded.value
  if (expanded.value) void loadTimeline()
}

function formatProvenanceTime(value: string): string {
  if (!value) return ''
  const timestamp = Date.parse(value)
  if (Number.isNaN(timestamp)) return value
  return new Date(timestamp).toLocaleString()
}
</script>

<style scoped>
.meta-record-provenance { margin-top: 16px; border-top: 1px solid #e2e8f0; padding-top: 10px; }
.meta-record-provenance__toggle { display: flex; align-items: center; gap: 6px; background: none; border: none; padding: 0; cursor: pointer; color: #475569; font-size: 12px; font-weight: 600; }
.meta-record-provenance__caret { font-size: 10px; color: #94a3b8; }
.meta-record-provenance__title { letter-spacing: 0.02em; }
.meta-record-provenance__body { margin-top: 8px; display: flex; flex-direction: column; gap: 8px; }
.meta-record-provenance__hint { font-size: 12px; color: #94a3b8; }
.meta-record-provenance__hint--error { color: #b45309; }
.meta-record-provenance__timeline { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.meta-record-provenance__entry { display: flex; flex-direction: column; gap: 3px; border-left: 2px solid #e2e8f0; padding-left: 8px; }
.meta-record-provenance__entry-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.meta-record-provenance__event { font-size: 12px; color: #1e293b; }
.meta-record-provenance__status { font-size: 11px; color: #475569; background: #f1f5f9; border-radius: 8px; padding: 0 6px; }
.meta-record-provenance__status--failed { color: #b91c1c; background: #fef2f2; }
.meta-record-provenance__status--partial { color: #b45309; background: #fffbeb; }
.meta-record-provenance__status--succeeded { color: #15803d; background: #f0fdf4; }
.meta-record-provenance__time { font-size: 11px; color: #64748b; }
.meta-record-provenance__entry-meta { display: flex; flex-wrap: wrap; gap: 8px; font-size: 11px; color: #64748b; }
.meta-record-provenance__entry-attrs { display: flex; flex-wrap: wrap; gap: 6px; }
.meta-record-provenance__chip { font-size: 11px; color: #475569; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 4px; padding: 0 5px; }
.meta-record-provenance__note { margin: 0; font-size: 11px; color: #94a3b8; }
</style>
