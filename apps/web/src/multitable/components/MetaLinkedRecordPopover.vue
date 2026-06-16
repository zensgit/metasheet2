<template>
  <div v-if="visible" class="meta-linked-record-popover" @click.self="emit('close')">
    <div class="meta-linked-record-popover__panel" role="dialog" :aria-label="l('linkedRecord.title')">
      <div class="meta-linked-record-popover__header">
        <strong>{{ l('linkedRecord.title') }}</strong>
        <button class="meta-linked-record-popover__close" :aria-label="l('linkedRecord.close')" @click="emit('close')">&times;</button>
      </div>
      <div class="meta-linked-record-popover__body">
        <div v-if="loading" class="meta-linked-record-popover__loading">{{ l('linkedRecord.loading') }}</div>
        <div v-else-if="error" class="meta-linked-record-popover__error">{{ error }}</div>
        <template v-else-if="context">
          <div v-if="!visibleForeignFields.length" class="meta-linked-record-popover__empty">{{ l('linkedRecord.empty') }}</div>
          <div
            v-for="field in visibleForeignFields"
            :key="field.id"
            class="meta-linked-record-popover__field"
          >
            <span class="meta-linked-record-popover__label">{{ field.name }}</span>
            <span class="meta-linked-record-popover__value">
              <!-- Nesting cap = 1: deliberately do NOT pass fetchRecord to the
                   inner renderer, so foreign link chips have no click affordance
                   and cannot open another popover. -->
              <MetaCellRenderer
                :field="field"
                :value="context.record.data[field.id]"
                :link-summaries="context.linkSummaries?.[field.id]"
                :attachment-summaries="context.attachmentSummaries?.[field.id]"
              />
            </span>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import type { MetaField, MetaRecordContext } from '../types'
import { useLocale } from '../../composables/useLocale'
import { metaCoreLabel, type MetaCoreLabelKey } from '../utils/meta-core-labels'
import MetaCellRenderer from './cells/MetaCellRenderer.vue'

const props = defineProps<{
  visible: boolean
  recordId: string | null
  // Self-contained data dependency: the host passes the cross-sheet record
  // fetcher (getRecord with NO sheetId — the foreign record resolves by global
  // id under the backend field mask). Kept as a prop so the popover never
  // imports the API client directly and specs can mock it trivially.
  fetchRecord: (recordId: string) => Promise<MetaRecordContext>
}>()

const emit = defineEmits<{ (e: 'close'): void }>()

const { isZh } = useLocale()
const l = (key: MetaCoreLabelKey) => metaCoreLabel(key, isZh.value)

const loading = ref(false)
const error = ref<string | null>(null)
const context = ref<MetaRecordContext | null>(null)
// Per-id cache so re-opening the same chip does not re-fetch.
const cache = new Map<string, MetaRecordContext>()
// Guards a stale fetch from a previously-opened chip overwriting a newer one.
let activeRecordId: string | null = null

// Foreign fields filtered to those the backend marks visible. The backend masks
// denied field values; we additionally hide fields it flags non-visible so the
// peek matches the foreign-sheet field-permission view.
const visibleForeignFields = ref<MetaField[]>([])

function computeVisibleFields(ctx: MetaRecordContext): MetaField[] {
  return ctx.fields.filter((field) => ctx.fieldPermissions?.[field.id]?.visible !== false)
}

async function load(recordId: string): Promise<void> {
  activeRecordId = recordId
  const cached = cache.get(recordId)
  if (cached) {
    context.value = cached
    visibleForeignFields.value = computeVisibleFields(cached)
    loading.value = false
    error.value = null
    return
  }
  loading.value = true
  error.value = null
  context.value = null
  visibleForeignFields.value = []
  try {
    const ctx = await props.fetchRecord(recordId)
    if (activeRecordId !== recordId) return
    cache.set(recordId, ctx)
    context.value = ctx
    visibleForeignFields.value = computeVisibleFields(ctx)
  } catch (e: unknown) {
    if (activeRecordId !== recordId) return
    // Prefer the backend message (user data) when present; fall back to the
    // localized frontend string for the `??` branch.
    const message = e instanceof Error ? e.message : ''
    error.value = message || l('linkedRecord.error')
  } finally {
    if (activeRecordId === recordId) loading.value = false
  }
}

watch(
  () => [props.visible, props.recordId] as const,
  ([visible, recordId]) => {
    if (visible && recordId) {
      void load(recordId)
    }
  },
  { immediate: true },
)
</script>

<style scoped>
.meta-linked-record-popover { position: fixed; inset: 0; z-index: 1000; }
.meta-linked-record-popover__panel { position: absolute; top: 64px; left: 50%; transform: translateX(-50%); width: 360px; max-height: 420px; background: #fff; border: 1px solid #ddd; border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,0.12); display: flex; flex-direction: column; overflow: hidden; }
.meta-linked-record-popover__header { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; border-bottom: 1px solid #f0f0f0; }
.meta-linked-record-popover__header strong { font-size: 14px; color: #333; }
.meta-linked-record-popover__close { border: none; background: none; font-size: 18px; cursor: pointer; color: #999; padding: 0 2px; line-height: 1; }
.meta-linked-record-popover__close:hover { color: #333; }
.meta-linked-record-popover__body { overflow-y: auto; flex: 1; padding: 8px 0; }
.meta-linked-record-popover__loading,
.meta-linked-record-popover__error,
.meta-linked-record-popover__empty { padding: 16px 14px; font-size: 13px; color: #909399; }
.meta-linked-record-popover__error { color: #f56c6c; }
.meta-linked-record-popover__field { display: flex; flex-direction: column; gap: 2px; padding: 6px 14px; }
.meta-linked-record-popover__label { font-size: 11px; color: #909399; }
.meta-linked-record-popover__value { font-size: 13px; color: #303133; min-width: 0; word-break: break-word; }
</style>
