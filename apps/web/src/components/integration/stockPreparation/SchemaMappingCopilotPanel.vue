<template>
  <section class="copilot-panel">
    <header class="copilot-head">
      <div>
        <h3 class="copilot-title">{{ bi('列映射副驾', 'Schema-mapping copilot') }}</h3>
        <p class="copilot-sub">
          {{ bi(
            'AI 先看懂来源里那些没有语义的列(数字槽位 + 字典表),提出每一列的含义和理由;由人确认后写成确定的 preset。接入不再对着 ExAttr 猜。',
            'The AI proposes what each opaque source column means (numbered slots + dictionary tables) with its reasoning; a human confirms, and the confirmed result becomes a deterministic preset.',
          ) }}
        </p>
      </div>
      <button class="copilot-btn" data-testid="copilot-propose" :disabled="!canPropose || loading" @click="onPropose">
        {{ loading ? bi('生成中…', 'Working…') : bi('获取列映射建议', 'Get mapping suggestions') }}
      </button>
    </header>

    <p v-if="!hasSignals" class="copilot-empty">
      {{ bi('尚无来源结构信号 — 先做一次来源发现(列 + 字典表),再让副驾提出建议。',
             'No source schema signals yet — run a source discovery (columns + dictionary tables) first, then ask the copilot.') }}
    </p>

    <p v-if="requestError" class="copilot-error" role="alert" data-testid="copilot-error">
      {{ bi('请求失败', 'Request failed') }}: <code>{{ requestError }}</code>
    </p>

    <div v-if="result" class="copilot-result">
      <!-- Detected vendor family + AI availability -->
      <div class="copilot-meta">
        <span class="copilot-chip copilot-chip--family">
          {{ bi('识别家族', 'Family') }}:
          <strong>{{ result.familyDetection.presetId || bi('未识别', 'none') }}</strong>
        </span>
        <span v-if="result.aiAvailable" class="copilot-chip copilot-chip--ai" data-testid="copilot-ai-chip">
          {{ bi('AI 建议·待确认', 'AI suggestion · pending confirmation') }}
        </span>
        <span v-else class="copilot-chip copilot-chip--manual" role="status" data-testid="copilot-manual-chip">
          {{ bi('AI 建议不可用,已回退人工映射', 'AI unavailable — fell back to manual mapping') }}
          <template v-if="result.reason"> (<code>{{ result.reason }}</code>)</template>
        </span>
        <span v-if="result.scrubbedCount > 0" class="copilot-chip copilot-chip--scrub">
          {{ bi('已剔除疑似敏感值', 'scrubbed sensitive-shaped values') }}: {{ result.scrubbedCount }}
        </span>
      </div>

      <!-- Per-column proposals: the AI half is clearly separated from the deterministic half. -->
      <table class="copilot-table">
        <thead>
          <tr>
            <th>{{ bi('来源列', 'Source column') }}</th>
            <th>{{ bi('AI 建议·待确认', 'AI suggestion · pending') }}</th>
            <th>{{ bi('确定性依据', 'Deterministic evidence') }}</th>
            <th>{{ bi('一致?', 'Agrees?') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="p in result.proposals" :key="p.id" class="copilot-row" data-testid="copilot-proposal-row">
            <td class="copilot-col">{{ p.column || p.id }}</td>
            <td class="copilot-ai">
              <template v-if="p.aiMeaning">
                <span class="copilot-badge">{{ bi('AI 建议', 'AI') }}</span>
                <strong>{{ p.aiMeaning }}</strong>
                <em v-if="p.aiConfidence" class="copilot-conf">· {{ confidenceLabel(p.aiConfidence) }}</em>
                <p v-if="p.aiReasoning" class="copilot-reason">{{ p.aiReasoning }}</p>
              </template>
              <span v-else class="copilot-muted">{{ bi('无 AI 建议', 'no AI suggestion') }}</span>
            </td>
            <td class="copilot-det">
              <span v-if="p.deterministic.dictLabel">{{ bi('字典标签', 'dict label') }}: {{ p.deterministic.dictLabel }}</span>
              <span v-if="p.deterministic.labelHint" class="copilot-hint">· {{ p.deterministic.labelHint }}</span>
              <span v-if="p.deterministic.family" class="copilot-fam">· {{ bi('槽位家族', 'slot family') }} {{ p.deterministic.family }}</span>
              <span v-if="!p.groundedByDiscovery" class="copilot-muted">{{ bi('无确定性依据', 'none') }}</span>
            </td>
            <td>
              <span v-if="p.agreesWithDiscovery === true" class="copilot-ok">✓</span>
              <span v-else-if="p.agreesWithDiscovery === false" class="copilot-warn" :title="bi('AI 与确定性依据不一致,请人工核对', 'AI disagrees with the deterministic evidence — review')">⚠</span>
              <span v-else class="copilot-muted">—</span>
            </td>
          </tr>
        </tbody>
      </table>

      <!-- Human confirm → deterministic preset. THIS is the authoritative step. -->
      <div v-if="confirmRows.length > 0" class="copilot-confirm">
        <h4 class="copilot-confirm-title">
          {{ bi('确认列含义 → 生成确定的 preset', 'Confirm column meanings → write a deterministic preset') }}
        </h4>
        <p class="copilot-confirm-note">
          {{ bi('确认的 preset 才是权威产物,AI 文本不会被自动采用。', 'The confirmed preset is the authoritative artifact — the AI text is never applied automatically.') }}
        </p>
        <ul class="copilot-confirm-list">
          <li v-for="(row, index) in confirmRows" :key="row.expectation.semantic" class="copilot-confirm-row">
            <label class="copilot-confirm-check">
              <input type="checkbox" v-model="row.include" />
              <strong>{{ row.expectation.semantic }}</strong>
            </label>
            <span class="copilot-confirm-locus">{{ locusLabel(row.expectation.locus) }}</span>
            <label class="copilot-confirm-source">
              {{ bi('来源', 'source') }}:
              <select v-model="row.source" @change="markHumanEdited(index)">
                <option value="ai-suggested">{{ bi('AI 建议', 'AI-suggested') }}</option>
                <option value="human-set">{{ bi('人工设定', 'human-set') }}</option>
              </select>
            </label>
          </li>
        </ul>
        <button class="copilot-btn copilot-btn--confirm" data-testid="copilot-confirm" :disabled="!canConfirm || confirming" @click="onConfirm">
          {{ confirming ? bi('写入中…', 'Writing…') : bi('确认并生成 preset', 'Confirm & write preset') }}
        </button>
      </div>

      <!-- Confirm result: provenance + authoritative-artifact statement. -->
      <div v-if="confirmResult" class="copilot-done" role="status" data-testid="copilot-done">
        <p class="copilot-done-title">{{ bi('已生成确定的 preset(权威产物)', 'Deterministic preset written (the authoritative artifact)') }}</p>
        <ul class="copilot-done-list">
          <li>{{ bi('确认人', 'Confirmed by') }}: <code>{{ confirmResult.provenance.confirmedBy }}</code></li>
          <li>{{ bi('AI 建议字段', 'AI-suggested fields') }}: {{ confirmResult.provenance.aiSuggested }}</li>
          <li>{{ bi('人工设定字段', 'Human-set fields') }}: {{ confirmResult.provenance.humanSet }}</li>
          <li>presetId: <code>{{ presetIdOf(confirmResult.preset) }}</code></li>
        </ul>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useLocale } from '../../../composables/useLocale'
import type { IntegrationScope } from '../../../services/integration/workbench'
import {
  proposeSchemaMapping,
  confirmSchemaMapping,
  SchemaMappingCopilotRequestError,
  type SchemaMappingSignalsInput,
  type SchemaMappingProposalResult,
  type SchemaMappingBaseExpectation,
  type SchemaMappingConfirmResult,
  type SchemaMappingSemanticSource,
} from '../../../services/integration/stockPreparation/schemaMappingCopilot'

const props = withDefaults(
  defineProps<{ scope: IntegrationScope; signals?: SchemaMappingSignalsInput | null }>(),
  { signals: null },
)

const { locale } = useLocale()
function bi(zh: string, en: string): string {
  return locale.value === 'zh-CN' ? zh : en
}

const loading = ref(false)
const confirming = ref(false)
const requestError = ref<string | null>(null)
const result = ref<SchemaMappingProposalResult | null>(null)
const confirmResult = ref<SchemaMappingConfirmResult | null>(null)

interface ConfirmRow {
  include: boolean
  expectation: SchemaMappingBaseExpectation
  source: SchemaMappingSemanticSource
}
const confirmRows = ref<ConfirmRow[]>([])

const hasSignals = computed(() => {
  const s = props.signals
  return Boolean(s && Array.isArray(s.columns) && s.columns.length > 0)
})
const canPropose = computed(() => hasSignals.value)
const canConfirm = computed(() => Boolean(result.value?.presetId) && confirmRows.value.some((r) => r.include))

function confidenceLabel(c: 'low' | 'medium' | 'high'): string {
  if (c === 'high') return bi('高置信', 'high')
  if (c === 'medium') return bi('中置信', 'medium')
  return bi('低置信', 'low')
}
function locusLabel(locus: string): string {
  return locus === 'dictionary-assigned-column'
    ? bi('字典分配槽位', 'dictionary-assigned')
    : bi('原生列', 'native column')
}
function presetIdOf(preset: Record<string, unknown>): string {
  return typeof preset.presetId === 'string' ? preset.presetId : ''
}

function seedConfirmRows(r: SchemaMappingProposalResult): void {
  // Default source: 'ai-suggested' when the AI proposed a matching semantic, else 'human-set'.
  const aiSemantics = new Set(r.proposals.map((p) => p.aiSemantic).filter((s): s is string => Boolean(s)))
  confirmRows.value = r.baseSemanticExpectations.map((expectation) => ({
    include: true,
    expectation,
    source: aiSemantics.has(expectation.semantic) ? 'ai-suggested' : 'human-set',
  }))
}

/** A human edit of the source toggle to human-set is a deliberate override; nothing else to do. */
function markHumanEdited(_index: number): void {
  /* no-op: v-model already updated the row */
}

function clampErrorCode(err: unknown): string {
  if (err instanceof SchemaMappingCopilotRequestError) return err.code
  return 'COPILOT_REQUEST_FAILED'
}

async function onPropose(): Promise<void> {
  if (!hasSignals.value || !props.signals) return
  loading.value = true
  requestError.value = null
  confirmResult.value = null
  try {
    const r = await proposeSchemaMapping(props.scope, props.signals)
    result.value = r
    seedConfirmRows(r)
  } catch (err) {
    requestError.value = clampErrorCode(err)
    result.value = null
    confirmRows.value = []
  } finally {
    loading.value = false
  }
}

async function onConfirm(): Promise<void> {
  const presetId = result.value?.presetId
  if (!presetId) return
  const confirmedSemantics = confirmRows.value
    .filter((r) => r.include)
    .map((r) => ({ ...r.expectation, source: r.source }))
  if (confirmedSemantics.length === 0) return
  confirming.value = true
  requestError.value = null
  try {
    confirmResult.value = await confirmSchemaMapping(props.scope, { presetId, confirmedSemantics })
  } catch (err) {
    requestError.value = clampErrorCode(err)
    confirmResult.value = null
  } finally {
    confirming.value = false
  }
}
</script>

<style scoped>
.copilot-panel { border: 1px solid var(--border-color, #e2e8f0); border-radius: 8px; padding: 16px; margin: 12px 0; }
.copilot-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
.copilot-title { margin: 0 0 4px; font-size: 16px; }
.copilot-sub { margin: 0; font-size: 13px; color: var(--text-muted, #64748b); max-width: 60ch; }
.copilot-btn { flex-shrink: 0; padding: 6px 12px; border-radius: 6px; border: 1px solid var(--primary, #2563eb); background: var(--primary, #2563eb); color: #fff; cursor: pointer; }
.copilot-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.copilot-btn--confirm { margin-top: 10px; }
.copilot-empty, .copilot-error { font-size: 13px; margin: 10px 0 0; }
.copilot-error { color: var(--danger, #dc2626); }
.copilot-meta { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0; }
.copilot-chip { font-size: 12px; padding: 2px 8px; border-radius: 999px; background: #f1f5f9; }
.copilot-chip--ai { background: #fef3c7; }
.copilot-chip--manual { background: #e2e8f0; }
.copilot-chip--scrub { background: #fee2e2; }
.copilot-table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 8px; }
.copilot-table th, .copilot-table td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--border-color, #e2e8f0); vertical-align: top; }
.copilot-col { font-family: monospace; }
.copilot-badge { display: inline-block; font-size: 11px; padding: 1px 6px; border-radius: 4px; background: #fde68a; margin-right: 6px; }
.copilot-conf { color: #64748b; font-style: normal; }
.copilot-reason { margin: 4px 0 0; color: #475569; }
.copilot-hint, .copilot-fam { color: #64748b; }
.copilot-muted { color: #94a3b8; }
.copilot-ok { color: #16a34a; font-weight: bold; }
.copilot-warn { color: #d97706; font-weight: bold; }
.copilot-confirm { margin-top: 16px; padding-top: 12px; border-top: 1px dashed var(--border-color, #e2e8f0); }
.copilot-confirm-title { margin: 0 0 4px; font-size: 14px; }
.copilot-confirm-note { margin: 0 0 8px; font-size: 12px; color: #64748b; }
.copilot-confirm-list { list-style: none; padding: 0; margin: 0; }
.copilot-confirm-row { display: flex; align-items: center; gap: 12px; padding: 4px 0; font-size: 13px; }
.copilot-confirm-locus { color: #64748b; font-size: 12px; }
.copilot-done { margin-top: 14px; padding: 10px; border-radius: 6px; background: #ecfdf5; }
.copilot-done-title { margin: 0 0 6px; font-weight: 600; color: #065f46; }
.copilot-done-list { margin: 0; padding-left: 18px; font-size: 13px; }
</style>
