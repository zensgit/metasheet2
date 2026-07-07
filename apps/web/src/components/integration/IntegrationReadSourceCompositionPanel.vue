<template>
  <div class="integration-read-source-composition" data-testid="read-source-composition-panel">
    <p class="integration-read-source-composition__hint">
      顾问/操作员在这里运行已审批的读取源组合链(materialNumber → FItemID → FBOMNumber 等)：只能选择已审批组合、
      只提供首个业务 key，中间键由平台派生，永远不能提交组合配置 / 计划 / 逐跳 key。本面板不含配置编写或审批能力，
      也不含任何写入操作。
    </p>

    <div class="integration-read-source-composition__columns">
      <div class="integration-read-source-composition__form" data-testid="rscomp-form">
        <label class="integration-read-source-composition__field">
          <span>已审批组合</span>
          <select v-model="selectedId" data-testid="rscomp-select">
            <option value="">请选择已审批组合…</option>
            <option v-for="row in compositions" :key="row.id" :value="row.id">
              {{ row.name || row.id }} (v{{ row.version }})
            </option>
          </select>
        </label>

        <label class="integration-read-source-composition__field">
          <span>首个业务 key(仅首步;中间键由平台派生)</span>
          <input v-model="businessKey" data-testid="rscomp-key" placeholder="MAT-001" />
        </label>

        <div class="integration-read-source-composition__actions">
          <button
            type="button"
            class="integration-workbench__button"
            data-testid="rscomp-refresh"
            :disabled="loading"
            @click="refresh"
          >{{ loading ? '加载中…' : '刷新组合列表' }}</button>
          <button
            type="button"
            class="integration-workbench__button"
            data-testid="rscomp-run"
            :disabled="running || !selectedId || !businessKey.trim()"
            @click="run"
          >{{ running ? '运行中…' : '运行' }}</button>
        </div>

        <p v-if="listError" class="integration-read-source-composition__error" data-testid="rscomp-list-error">{{ listError }}</p>
        <p v-if="runError" class="integration-read-source-composition__error" data-testid="rscomp-error">{{ runError }}</p>
        <div
          v-if="!loading && compositions.length === 0"
          class="integration-read-source-composition__empty integration-read-source-composition__empty--guided"
          data-testid="rscomp-empty"
        >
          <strong data-testid="rscomp-empty-what">{{ bi(
            '这里运行已审批的两跳读取源组合（例如从一个业务键派生到另一个关联记录）。',
            'This runs an APPROVED two-hop read-source composition (e.g. deriving one linked record from a business key).',
          ) }}</strong>
          <p data-testid="rscomp-empty-first-step">{{ bi(
            '第一步：请先在上方"读取源组合配置"面板保存并审批一条组合，审批后会出现在这里的下拉列表中。',
            'First step: save and approve a composition in the "composition config" panel above — once approved, it will appear in the dropdown here.',
          ) }}</p>
        </div>
      </div>

      <div v-if="result" class="integration-read-source-composition__evidence" data-testid="rscomp-result">
        <h4>链证据(values-free)</h4>
        <ul>
          <li data-testid="rscomp-evidence-ok">ok: {{ result.evidence.ok ? 'true' : 'false' }}</li>
          <li v-if="result.evidence.failedStep !== null" data-testid="rscomp-evidence-failed-step">
            failedStep: {{ result.evidence.failedStep }}
          </li>
          <li v-if="result.evidence.errorCode" data-testid="rscomp-evidence-error-label">
            {{ resultErrorLabel }}<template v-if="resultErrorHint"> — {{ resultErrorHint }}</template>
            <small data-testid="rscomp-evidence-error-code">errorCode: {{ result.evidence.errorCode }}</small>
          </li>
          <li
            v-for="step in result.evidence.steps"
            :key="step.step"
            :data-testid="`rscomp-step-${step.step}`"
          >
            step {{ step.step }}: ok={{ step.ok ? 'true' : 'false' }}<template v-if="step.rule">, rule={{ step.rule }}</template><template v-if="step.errorCode">, errorCode={{ step.errorCode }} ({{ stepErrorLabel(step.errorCode) }})</template>
          </li>
          <li v-for="(entry, index) in result.evidence.planErrors ?? []" :key="index" data-testid="rscomp-plan-error">
            {{ entry.code }} · {{ entry.field }} · {{ entry.reason }}
          </li>
        </ul>

        <div v-if="result.data" class="integration-read-source-composition__output" data-testid="rscomp-output">
          <h4>末跳输出(仅最后一跳)</h4>
          <p data-testid="rscomp-output-value">{{ result.data.resolver.target }} = {{ result.data.resolver.value }}</p>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
// Read-source composition run panel (C-R4-3b, #1709) — advisor/operator-tier UI over the C-R4-1 run
// route + C-R4-3a client service layer. Selects an APPROVED composition, sends ONLY the first business
// key, and renders the values-free chain evidence + last-hop-only output. No authoring/approval, no
// write path; the server + client normalizer already enforce values-free — this panel renders exactly
// what they return, nothing more.
import { computed, ref, watch } from 'vue'
import { useLocale } from '../../composables/useLocale'
import { integrationErrorCodeDisplayLabel, integrationErrorCodeHint } from '../../services/integration/errorCodeLabels'
import type { IntegrationScope } from '../../services/integration/workbench'
import {
  listReadSourceCompositions,
  runReadSourceComposition,
  type CompositionRunResult,
  type ReadSourceCompositionRow,
} from '../../services/integration/readSourceCompositions'

const props = defineProps<{
  scope: IntegrationScope
}>()

const { locale } = useLocale()

const compositions = ref<ReadSourceCompositionRow[]>([])
const selectedId = ref('')
const businessKey = ref('')
const loading = ref(false)
const running = ref(false)
const listError = ref('')
const runError = ref('')
const result = ref<CompositionRunResult | null>(null)

// IU-1: humanized chain-evidence errorCode label (+ optional hint). The raw code stays visible in a
// demoted spot (data-testid="rscomp-evidence-error-code") — no errorMessage field exists on this
// evidence shape, so there is nothing unsafe to hide here; the code is a registered, values-free
// vocabulary.
const resultErrorLabel = computed(() => integrationErrorCodeDisplayLabel(result.value?.evidence.errorCode, locale.value))
const resultErrorHint = computed(() => integrationErrorCodeHint(result.value?.evidence.errorCode, locale.value))
function stepErrorLabel(errorCode: string | undefined): string | null {
  if (!errorCode) return null
  return integrationErrorCodeDisplayLabel(errorCode, locale.value)
}

// IU-6a: bilingual guidance copy helper — same locale pattern as the IU-1 error labels above (reads
// `locale.value` synchronously; safe to call directly from the template without a dedicated computed).
function bi(zh: string, en: string): string {
  return locale.value === 'zh-CN' ? zh : en
}

watch(selectedId, () => {
  result.value = null
  runError.value = ''
})

function coarseErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return '组合运行请求失败'
}

async function refresh(): Promise<void> {
  loading.value = true
  listError.value = ''
  try {
    compositions.value = await listReadSourceCompositions(props.scope, { status: 'approved' })
  } catch (error) {
    listError.value = coarseErrorMessage(error)
  } finally {
    loading.value = false
  }
}

async function run(): Promise<void> {
  runError.value = ''
  result.value = null
  running.value = true
  try {
    result.value = await runReadSourceComposition(selectedId.value, businessKey.value.trim(), props.scope)
  } catch (error) {
    runError.value = coarseErrorMessage(error)
  } finally {
    running.value = false
  }
}

void refresh()
</script>

<style scoped>
.integration-read-source-composition__hint {
  color: #666;
  font-size: 13px;
  margin: 0 0 12px;
}
.integration-read-source-composition__columns {
  display: grid;
  grid-template-columns: minmax(320px, 1fr) minmax(360px, 1.2fr);
  gap: 20px;
}
.integration-read-source-composition__field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 10px;
  font-size: 13px;
}
.integration-read-source-composition__field input,
.integration-read-source-composition__field select {
  padding: 6px 8px;
  border: 1px solid #d0d0d0;
  border-radius: 4px;
}
.integration-read-source-composition__actions {
  display: flex;
  gap: 8px;
  margin: 10px 0;
}
.integration-read-source-composition__error {
  color: #b91c1c;
  font-size: 13px;
}
.integration-read-source-composition__empty {
  color: #888;
  font-size: 13px;
}
/* IU-6a guided empty state: "what this is" + "first step" — new styling only, tokens per UF-1. */
.integration-read-source-composition__empty--guided {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-1);
}
.integration-read-source-composition__empty--guided strong {
  color: var(--ms-text-1);
}
.integration-read-source-composition__empty--guided p {
  margin: 0;
}
.integration-read-source-composition__evidence {
  border: 1px solid #e0e0e0;
  border-radius: 6px;
  padding: 10px 12px;
  font-size: 13px;
}
.integration-read-source-composition__evidence ul {
  margin: 6px 0 0;
  padding-left: 18px;
}
.integration-read-source-composition__output {
  margin-top: 10px;
  color: #15803d;
}
@media (max-width: 960px) {
  .integration-read-source-composition__columns {
    grid-template-columns: 1fr;
  }
}
</style>
