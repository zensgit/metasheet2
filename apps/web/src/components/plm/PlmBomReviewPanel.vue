<template>
  <section class="bom-review" data-testid="plm-bom-review-panel">
    <header class="bom-review__head">
      <strong>BOM Review</strong>
      <small>来自 PLM 的受治理快照；此工作台可写回已授权的 BOM 单元格。</small>
    </header>

    <div class="bom-review__query">
      <label>
        <span>Part ID</span>
        <input
          v-model="partId"
          data-testid="plm-bom-review-part-input"
          placeholder="输入要查看 BOM 的 Part ID"
          @keyup.enter="load"
        />
      </label>
      <button
        type="button"
        class="bom-review__button"
        data-testid="plm-bom-review-load"
        :disabled="loading || !partId.trim()"
        @click="load"
      >
        {{ loading ? '加载中…' : '加载 BOM Review' }}
      </button>
    </div>

    <div class="bom-review__body" data-testid="plm-bom-review-state" :data-state="reviewState">
      <p v-if="reviewState === 'idle'" class="bom-review__hint">
        输入一个 Part ID 后加载其 BOM review 表。
      </p>
      <p v-else-if="reviewState === 'loading'" class="bom-review__hint">正在读取 BOM review…</p>
      <p v-else-if="reviewState === 'unavailable'" class="bom-review__hint bom-review__hint--muted">
        当前 PLM 不支持 BOM review，或暂时不可用。
      </p>
      <p v-else-if="reviewState === 'upgrade'" class="bom-review__hint bom-review__hint--strong">
        当前租户尚未开通 BOM review；这里只显示升级入口，真实授权由 PLM license 判定。
      </p>
      <p v-else-if="reviewState === 'error'" class="bom-review__hint bom-review__hint--strong" data-testid="plm-bom-review-error">
        加载 BOM review 失败（PLM 暂时不可用），请稍后重试。
      </p>
      <p v-else-if="reviewState === 'empty'" class="bom-review__hint">
        未找到该 Part 的 BOM 数据。
      </p>

      <template v-else-if="reviewState === 'table' && context">
        <p
          v-if="advisoryLocked"
          class="bom-review__hint bom-review__hint--strong"
          data-testid="plm-bom-review-locked-hint"
        >
          该 Part 处于锁定状态（{{ context.part.state }}），已暂停行内编辑；修改需通过 PLM 的 ECO
          变更流程。
        </p>
        <!-- ECO Phase 3 CTA: the governed door the locked state points at. Shown for BOTH lock
             sites (the advisory pre-gate above AND the reactive write-back lifecycle_locked 409),
             pre-gated on the capabilities advisory (bom_eco_revision + eco_revision_intent). -->
        <div
          v-if="ecoIntentRelevant"
          class="bom-review__eco-intent"
          data-testid="plm-bom-review-eco-intent"
        >
          <button
            v-if="advisoryLocked || writebackLocked"
            type="button"
            class="bom-review__button"
            data-testid="plm-bom-review-eco-intent-cta"
            :disabled="ecoIntentStatus !== 'idle'"
            @click="requestEcoIntent"
          >
            {{ ecoIntentStatus === 'requesting' ? '正在发起 ECO 修订…' : '发起 ECO 修订' }}
          </button>
          <p
            v-if="ecoIntentMessage"
            class="bom-review__hint"
            :class="{ 'bom-review__hint--strong': ecoIntentStatus === 'done' }"
            data-testid="plm-bom-review-eco-intent-message"
          >
            {{ ecoIntentMessage }}
          </p>
        </div>
        <PlmBomReviewTable
          :context="context"
          :editable="!advisoryLocked"
          :submitting-line-id="submittingLineId"
          :line-messages="lineMessages"
          @submit-line="submitLinePatch"
        />
      </template>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  getPlmBomMultitableContext,
  requestPlmBomEcoRevisionIntent,
  updatePlmBomMultitableLine,
  type PlmBomMultitableLine,
  type PlmBomMultitableLinePatch,
  type PlmBomMultitableResult,
} from '../../services/integration/workbench'
import PlmBomReviewTable from './PlmBomReviewTable.vue'

// ecoIntentEnabled: the ECO Phase 3 CTA pre-gate, computed by the WORKBENCH view from the
// capabilities advisory (features.bom_eco_revision supported+entitled+actions includes
// eco_revision_intent) and passed down — the panel itself never fetches capabilities
// (P3-C invariant: mounting the panel triggers no PLM call).
const props = defineProps<{ dataSourceId: string; ecoIntentEnabled?: boolean }>()

const partId = ref('')
const loading = ref(false)
const result = ref<PlmBomMultitableResult | null>(null)
const submittingLineId = ref<string | null>(null)
const lineMessages = ref<Record<string, string>>({})
const retryKeys = ref<Record<string, string>>({})
// ECO Phase 3 CTA state. writebackLocked = the REACTIVE lock site (a write-back came back
// 409 lifecycle_locked even though the advisory pre-gate missed it — custom lock state or race).
const writebackLocked = ref(false)
const ecoIntentStatus = ref<'idle' | 'requesting' | 'done'>('idle')
const ecoIntentMessage = ref('')

const context = computed(() =>
  result.value && result.value.available ? result.value.context : null,
)

// ECO Phase 0 advisory pre-gate (ratified C2): the provider's lock set is DATA-DRIVEN
// (version_lock on lifecycle states), so the consumer cannot enumerate it authoritatively.
// This is the provider's default-seed locked set, used ONLY to pause inline editing up front
// for the common case; the discriminated 409 (reason 'lifecycle_locked') stays the
// authoritative gate for the residual race or a tenant-customized lock set. The gate keys on
// the ROOT part's state -- the provider evaluates the lock on the PARENT part, and per-line
// `state` is the CHILD part's state (display-only, wrong semantics for the write gate).
const ADVISORY_LOCKED_STATES = new Set(['Released', 'Suspended', 'Obsolete'])

const advisoryLocked = computed(() => {
  const state = context.value?.part.state
  return typeof state === 'string' && ADVISORY_LOCKED_STATES.has(state)
})

// The CTA renders only when the capability advertises the intent action AND the part is locked
// by EITHER site (advisory pre-gate or the reactive write-back 409). Part-scoped: the intent
// targets the ROOT part, not a line. A lingering message keeps the block visible even after a
// not_locked reset clears the lock flags (else the explanation would vanish with the button).
const ecoIntentRelevant = computed(() =>
  props.ecoIntentEnabled === true
  && (advisoryLocked.value || writebackLocked.value || ecoIntentMessage.value !== ''),
)

async function requestEcoIntent(): Promise<void> {
  const part = context.value?.part.part_id
  if (!part || ecoIntentStatus.value !== 'idle') return
  ecoIntentStatus.value = 'requesting'
  ecoIntentMessage.value = ''
  try {
    const outcome = await requestPlmBomEcoRevisionIntent(props.dataSourceId, part)
    if (outcome.ok) {
      ecoIntentStatus.value = 'done'
      ecoIntentMessage.value = outcome.attached
        ? `已挂接到该 Part 现有的开放 ECO（${outcome.eco_id}）；请在 PLM 中继续该 ECO 的修订与审批。`
        : `已发起 ECO 修订（${outcome.eco_id}）；修订分支已创建，请在 PLM 中完成变更与审批。`
      return
    }
    ecoIntentStatus.value = 'idle'
    if (outcome.reason === 'not_locked') {
      // The provider says the part is editable — the reactive lock was stale. Reset it so the
      // CTA hides (advisory permitting) and the user goes back to the direct edit path.
      writebackLocked.value = false
      ecoIntentMessage.value = '该 Part 当前未处于锁定状态，可直接编辑写回，无需 ECO 修订。'
      return
    }
    if (outcome.reason === 'eco_intent_rejected') {
      ecoIntentMessage.value = '发起 ECO 修订被拒（可能存在并发变更或该 Part 不可修订），请稍后重试。'
      return
    }
    if (outcome.status === 403) {
      ecoIntentMessage.value = '当前租户未开通 ECO 修订通道，或权限不足。'
      return
    }
    ecoIntentMessage.value = '发起 ECO 修订失败，请稍后重试。'
  } catch {
    ecoIntentStatus.value = 'idle'
    ecoIntentMessage.value = '发起 ECO 修订失败，请稍后重试。'
  }
}

// idle (nothing loaded) -> loading -> one of: unavailable (no support / degraded), upgrade
// (supported but not entitled), error (entitled but the provider fetch failed transiently),
// empty (entitled, no context, no reason = part not found), table (entitled + context).
const reviewState = computed<'idle' | 'loading' | 'unavailable' | 'upgrade' | 'error' | 'empty' | 'table'>(() => {
  if (loading.value) return 'loading'
  const current = result.value
  if (!current) return 'idle'
  if (!current.available) return 'unavailable'
  if (!current.entitled) return 'upgrade'
  if (current.context) return 'table'
  // entitled but no context: a relayed reason means a TRANSIENT provider failure (retry),
  // NOT "this part has no BOM" -- only a reason-less null context is the empty/not-found case.
  if (current.reason) return 'error'
  return 'empty'
})

// Fetch ONLY on explicit user action (never on mount) so mounting the panel never triggers a
// PLM call. The backend relay does the advisory gate; this is a single, read-only call.
async function load(): Promise<void> {
  const pid = partId.value.trim()
  if (!pid || loading.value) return
  loading.value = true
  lineMessages.value = {}
  retryKeys.value = {}
  // A fresh load is a fresh part/context: reset the ECO-intent CTA state machine.
  writebackLocked.value = false
  ecoIntentStatus.value = 'idle'
  ecoIntentMessage.value = ''
  try {
    result.value = await getPlmBomMultitableContext(props.dataSourceId, pid)
  } catch {
    result.value = { data_source_id: props.dataSourceId, available: false, reason: 'unavailable' }
  } finally {
    loading.value = false
  }
}

function makeIdempotencyKey(): string {
  const cryptoApi = globalThis.crypto as { randomUUID?: () => string } | undefined
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID()
  return `bom-write-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function writebackMessage(status: number, reason?: string): string {
  // ECO Phase 0: the provider's two write-back 409s are discriminated by the relayed reason
  // (detail.code). An unknown/absent reason degrades to the legacy status-keyed copy.
  if (reason === 'lifecycle_locked')
    return '该 Part 处于生命周期锁定状态，写回被拒；修改需通过 PLM 的 ECO 变更流程。'
  if (reason === 'idempotency_conflict')
    return '提交键已用于另一次不同的写入；已为该行更换新的提交键，请确认单元格后重试。'
  if (status === 412) return '此行已被他人修改，已重新载入最新值，请确认后重试。'
  if (status === 403) return '无写回授权或权限不足。'
  if (status === 404) return '该 BOM 行不存在或不属于当前 Part。'
  if (status === 409) return '该 BOM 行当前不可写，或提交键已用于不同写入。'
  if (status === 422 || status === 400) return '写回内容无效，请检查单元格。'
  return '写回暂时失败，请稍后重试。'
}

function applyLinePatch(line: PlmBomMultitableLine, patch: PlmBomMultitableLinePatch): void {
  if ('quantity' in patch) {
    line.quantity = typeof patch.quantity === 'number' || patch.quantity === null ? patch.quantity : Number(patch.quantity)
  }
  if ('uom' in patch) line.uom = patch.uom ?? null
  if ('find_num' in patch) line.find_num = patch.find_num ?? null
  if ('refdes' in patch) line.refdes = patch.refdes ?? null
}

async function submitLinePatch(payload: { line: PlmBomMultitableLine; patch: PlmBomMultitableLinePatch }): Promise<void> {
  const lineId = payload.line.bom_line_id
  if (!context.value || submittingLineId.value) return
  const key = retryKeys.value[lineId] || makeIdempotencyKey()
  retryKeys.value = { ...retryKeys.value, [lineId]: key }
  submittingLineId.value = lineId
  lineMessages.value = { ...lineMessages.value, [lineId]: '正在写回…' }
  try {
    const outcome = await updatePlmBomMultitableLine(
      props.dataSourceId,
      context.value.part.part_id,
      lineId,
      payload.patch,
      key,
      payload.line.write_etag,
    )
    if (outcome.ok) {
      applyLinePatch(payload.line, payload.patch)
      const { [lineId]: _doneKey, ...rest } = retryKeys.value
      retryKeys.value = rest
      lineMessages.value = { ...lineMessages.value, [lineId]: '写回成功。' }
      return
    }
    if (outcome.status === 412) {
      // Optimistic-concurrency conflict: a concurrent edit landed first. Reload the fresh context
      // (new write_etags; load() also drops every retry key, so the re-submit mints a fresh
      // Idempotency-Key rather than replaying the cached original), then surface the conflict so the
      // user reviews the current value and re-decides. Never report the dropped edit as success.
      await load()
      lineMessages.value = { ...lineMessages.value, [lineId]: writebackMessage(412) }
      return
    }
    if (outcome.status === 409 && outcome.reason === 'idempotency_conflict') {
      // ECO Phase 0: the key is burned for a DIFFERENT write intent -- replaying it can never
      // succeed. Drop this line's retry key so the next submit mints a fresh Idempotency-Key
      // (the 412 flow's key rotation, minus the reload: the server state did not change).
      const { [lineId]: _burnedKey, ...rest } = retryKeys.value
      retryKeys.value = rest
      lineMessages.value = {
        ...lineMessages.value,
        [lineId]: writebackMessage(outcome.status, outcome.reason),
      }
      return
    }
    if (outcome.status === 409 && outcome.reason === 'lifecycle_locked') {
      // ECO Phase 3: the REACTIVE lock site — the advisory pre-gate missed this lock (custom
      // lock state or a race), the provider's discriminated 409 is authoritative. Flip the
      // part-level flag so the ECO-revision CTA surfaces (capability permitting).
      writebackLocked.value = true
      lineMessages.value = {
        ...lineMessages.value,
        [lineId]: writebackMessage(outcome.status, outcome.reason),
      }
      return
    }
    lineMessages.value = {
      ...lineMessages.value,
      [lineId]: writebackMessage(outcome.status, outcome.reason),
    }
  } catch {
    lineMessages.value = { ...lineMessages.value, [lineId]: '写回暂时失败，请稍后重试。' }
  } finally {
    submittingLineId.value = null
  }
}
</script>

<style scoped>
.bom-review { display: flex; flex-direction: column; gap: 8px; }
.bom-review__head { display: flex; flex-direction: column; }
.bom-review__query { display: flex; align-items: flex-end; gap: 8px; }
.bom-review__query label { display: flex; flex-direction: column; gap: 2px; }
.bom-review__button { white-space: nowrap; }
.bom-review__hint--muted { opacity: 0.6; }
.bom-review__hint--strong { font-weight: 600; }
.bom-review__eco-intent { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
</style>
