<template>
  <section ref="panelRoot" class="bom-review" data-testid="plm-bom-review-panel">
    <header class="bom-review__head">
      <strong>BOM Review</strong>
      <small>来自 PLM 的受治理快照；此工作台可写回已授权的 BOM 单元格。</small>
      <button
        type="button"
        class="bom-review__button"
        data-testid="plm-bom-write-bindings-open"
        @click="bindingsOpen = true"
      >
        管理个人 BOM 写入授权
      </button>
    </header>
    <PlmBomWriteBindingsPanel v-if="bindingsOpen" :data-source-id="dataSourceId" />

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
        :disabled="!partId.trim()"
        @click="load"
      >
        {{ loading ? '加载中…' : '加载 BOM Review' }}
      </button>
    </div>

    <p
      v-if="storageMessage"
      class="bom-review__hint bom-review__hint--strong"
      data-testid="plm-bom-write-storage"
    >
      {{ storageMessage }}
    </p>
    <div v-if="pendingRows.length || identityHold" class="bom-review__pending" data-testid="plm-bom-write-pending">
      <p v-if="pendingRows.length" class="bom-review__hint">有未确认的个人 BOM 写入。重试使用冻结的原请求，不会改用当前编辑内容，也不会更换提交键。</p>
      <button
        v-for="row in pendingRows"
        :key="row.clientKey"
        type="button"
        class="bom-review__button"
        data-testid="plm-bom-write-retry"
        :data-operation="row.operationKind"
        :data-bom-line-id="row.bomLineId ?? ''"
        :disabled="writeBusy"
        @click="retryPending(row)"
      >
        {{ row.operationKind === 'line' ? `重试未确认的行写入 ${row.bomLineId}` : '重试未确认的 ECO 修订' }}
      </button>
      <button
        v-for="row in pendingRows.filter((item) => irrecoverableKeys.includes(item.clientKey))"
        :key="`${row.clientKey}:separate`"
        type="button"
        class="bom-review__button"
        data-testid="plm-bom-write-separate"
        :data-operation="row.operationKind"
        :data-client-key="row.clientKey"
        :data-bom-line-id="row.bomLineId ?? ''"
        :disabled="writeBusy"
        @click="startSeparate(row)"
      >
        另起一次提交
      </button>
      <button
        v-if="identityHold"
        type="button"
        class="bom-review__button"
        data-testid="plm-bom-write-separate-identity"
        :disabled="writeBusy"
        @click="startIdentitySeparate"
      >
        按当前身份另起一次提交
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
            :disabled="ecoIntentStatus !== 'idle' || writeBusy"
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
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { onAuthSessionSwitch, readAuthSessionSignature } from '../../composables/authPrincipal'
import {
  getPlmBomMultitableContext,
  requestPlmBomEcoRevisionIntent,
  updatePlmBomMultitableLine,
  type PlmBomEcoRevisionIntentResult,
  type PlmBomMultitableLine,
  type PlmBomMultitableLinePatch,
  type PlmBomMultitableLineUpdateResult,
  type PlmBomMultitableResult,
} from '../../services/integration/workbench'
import {
  listPlmBomWriteBindings,
  PlmBomWriteBindingError,
  type PlmBomWriteBinding,
} from '../../services/plm/plmBomWriteBindings'
import {
  commitFrozenBomWrite,
  findFrozenBomWrite,
  irrecoverableBomWriteKeys,
  listFrozenBomWritesForTarget,
  rememberIrrecoverableBomWrite,
  removeFrozenBomWrite,
  sameBomWriteIdentity,
  type BomWriteIdentity,
  type BomWritePatch,
  type FrozenBomWrite,
} from '../../services/plm/plmBomWritePending'
import PlmBomReviewTable from './PlmBomReviewTable.vue'
import PlmBomWriteBindingsPanel from './PlmBomWriteBindingsPanel.vue'
import { randomUuid } from '../../utils/uuid'

const props = defineProps<{ dataSourceId: string; ecoIntentEnabled?: boolean }>()

const partId = ref('')
const loading = ref(false)
const result = ref<PlmBomMultitableResult | null>(null)
const submittingLineId = ref<string | null>(null)
const lineMessages = ref<Record<string, string>>({})
const writebackLocked = ref(false)
const ecoIntentStatus = ref<'idle' | 'requesting' | 'done'>('idle')
const ecoIntentMessage = ref('')
const bindingsOpen = ref(false)
const pendingRows = ref<FrozenBomWrite[]>([])
const irrecoverableKeys = ref<string[]>([])
const identityHold = ref<{ operationKind: 'line' | 'eco-intent'; partId: string; bomLineId: string | null } | null>(null)
const storageMessage = ref('')
const writeBusy = ref(false)
const visibleIdentity = ref<BomWriteIdentity | null>(null)
const panelRoot = ref<HTMLElement | null>(null)

let generation = 0
let pendingTicket = 0
let session = readAuthSessionSignature()
let controller: AbortController | null = null

const LINE_UNCONFIRMED = '结果尚未确认。请使用原请求体重试，不要更换提交键。'
const LINE_IDENTITY = '已有冻结写入属于另一身份或范围。原请求已保留，不会改用当前内容重发。'
const LINE_STORAGE = '无法保存可恢复的提交快照，未发送写入。'
const LINE_MULTIPLE = '已有多条未确认的提交。原请求都保留，请分别重试，不要更换提交键。'
const LINE_UNBOUND = '当前数据源没有可用的个人 BOM 写入授权。未发送写入。'
const LINE_AMBIGUOUS = '该数据源有多条个人写入授权，无法确定目标，未发送写入。'
const LINE_KEY = '无法生成提交键，未发送写入。'
const ECO_UNCONFIRMED = '结果尚未确认。请使用原请求重试，不要更换提交键。'

const context = computed(() =>
  result.value && result.value.available ? result.value.context : null,
)

const ADVISORY_LOCKED_STATES = new Set(['Released', 'Suspended', 'Obsolete'])
const advisoryLocked = computed(() => {
  const state = context.value?.part.state
  return typeof state === 'string' && ADVISORY_LOCKED_STATES.has(state)
})
const ecoIntentRelevant = computed(() =>
  props.ecoIntentEnabled === true
  && (advisoryLocked.value || writebackLocked.value || ecoIntentMessage.value !== ''),
)
const reviewState = computed<'idle' | 'loading' | 'unavailable' | 'upgrade' | 'error' | 'empty' | 'table'>(() => {
  if (loading.value) return 'loading'
  const current = result.value
  if (!current) return 'idle'
  if (!current.available) return 'unavailable'
  if (!current.entitled) return 'upgrade'
  if (current.context) return 'table'
  if (current.reason) return 'error'
  return 'empty'
})

function viewStill(source: string, part: string): boolean {
  return props.dataSourceId === source && context.value?.part.part_id === part
}

function stillCurrent(source: string, part: string, ownGeneration: number, ownSession: string): boolean {
  return ownGeneration === generation
    && source === props.dataSourceId
    && part === partId.value.trim()
    && ownSession === readAuthSessionSignature()
}

function publishPending(part: string, identity: BomWriteIdentity | null): void {
  visibleIdentity.value = identity
  if (!identity) {
    pendingRows.value = []
    irrecoverableKeys.value = []
    return
  }
  const stored = listFrozenBomWritesForTarget(props.dataSourceId, part)
  if (stored === null) {
    pendingRows.value = []
    irrecoverableKeys.value = []
    storageMessage.value = '无法读取未确认的提交。未发送新的写入。'
    return
  }
  storageMessage.value = ''
  const rows = stored.filter((row) => sameBomWriteIdentity(row.identity, identity))
  pendingRows.value = rows
  const visibleKeys = new Set(rows.map((row) => row.clientKey))
  irrecoverableKeys.value = irrecoverableBomWriteKeys().filter((key) => visibleKeys.has(key))
  const eco = rows.some((row) => row.operationKind === 'eco-intent')
  if (eco && ecoIntentStatus.value === 'idle' && !ecoIntentMessage.value) {
    ecoIntentMessage.value = ECO_UNCONFIRMED
  }
  const messages = { ...lineMessages.value }
  for (const row of rows) {
    if (row.operationKind === 'line' && row.bomLineId && !messages[row.bomLineId]) {
      messages[row.bomLineId] = LINE_UNCONFIRMED
    }
  }
  lineMessages.value = messages
}

async function refreshPending(part: string, knownIdentity?: BomWriteIdentity | null): Promise<void> {
  const ticket = ++pendingTicket
  const ownSource = props.dataSourceId
  const ownGeneration = generation
  const ownSession = session
  const current = () => ticket === pendingTicket && stillCurrent(ownSource, part, ownGeneration, ownSession)
  if (knownIdentity !== undefined) {
    if (!current()) return
    publishPending(part, knownIdentity)
    return
  }
  const stored = listFrozenBomWritesForTarget(ownSource, part)
  if (!current()) return
  if (stored === null) {
    pendingRows.value = []
    irrecoverableKeys.value = []
    visibleIdentity.value = null
    storageMessage.value = '无法读取未确认的提交。未发送新的写入。'
    return
  }
  if (stored.length === 0) {
    pendingRows.value = []
    irrecoverableKeys.value = []
    visibleIdentity.value = null
    storageMessage.value = ''
    return
  }
  if (!controller || controller.signal.aborted) controller = new AbortController()
  try {
    const listed = await listPlmBomWriteBindings(controller.signal)
    if (!current()) return
    const selected = selectBound(listed, ownSource)
    publishPending(part, selected === 'missing' || selected === 'ambiguous' ? null : identityOf(selected))
  } catch {
    if (!current()) return
    pendingRows.value = []
    irrecoverableKeys.value = []
    visibleIdentity.value = null
  }
}

function resetForSession(): void {
  const next = readAuthSessionSignature()
  if (next === session) return
  session = next
  generation += 1
  pendingTicket += 1
  controller?.abort()
  controller = null
  pendingRows.value = []
  irrecoverableKeys.value = []
  visibleIdentity.value = null
  identityHold.value = null
  lineMessages.value = {}
  writeBusy.value = false
  submittingLineId.value = null
  if (ecoIntentStatus.value === 'requesting') ecoIntentStatus.value = 'idle'
  const part = partId.value.trim()
  if (part && context.value?.part.part_id === part) void refreshPending(part)
}
const unsubscribe = onAuthSessionSwitch(resetForSession)

function identityOf(row: PlmBomWriteBinding): BomWriteIdentity {
  return {
    ownerId: row.ownerId,
    metaTenantId: row.metaTenantId,
    dataSourceId: row.dataSourceId,
    connectionId: row.connectionId,
    subjectId: row.subjectId,
    targetOrigin: row.targetOrigin,
    yuantusTenantId: row.yuantusTenantId,
    yuantusOrgId: row.yuantusOrgId,
    workspaceId: row.workspaceId,
    scopeKind: row.scopeKind,
  }
}

function selectBound(rows: PlmBomWriteBinding[], dataSourceId: string): PlmBomWriteBinding | 'missing' | 'ambiguous' {
  const matches = rows.filter((row) => row.dataSourceId === dataSourceId && row.bound)
  if (matches.length > 1) return 'ambiguous'
  return matches[0] ?? 'missing'
}

function whitelistPatch(patch: PlmBomMultitableLinePatch): BomWritePatch {
  const next: BomWritePatch = {}
  if ('quantity' in patch) next.quantity = patch.quantity ?? null
  if ('uom' in patch) next.uom = patch.uom ?? null
  if ('find_num' in patch) next.find_num = patch.find_num ?? null
  if ('refdes' in patch) next.refdes = patch.refdes ?? null
  return next
}

function writebackMessage(outcome: Extract<PlmBomMultitableLineUpdateResult, { ok: false }>): string {
  if (outcome.reason === 'lifecycle_locked') {
    return '该 Part 处于生命周期锁定状态，写回被拒；修改需通过 PLM 的 ECO 变更流程。'
  }
  if (outcome.reason === 'idempotency_conflict') {
    return '提交键已绑定冻结的原请求。请使用原请求体重试，不要更换提交键。'
  }
  if (outcome.reason === 'frozen-context') return '本次请求与已冻结的请求不一致，没有发出新的写入。'
  if (outcome.status === 412) return '原条件未满足。请使用原提交键、原请求体和原 If-Match 重试，不要更换提交键。'
  if (outcome.status === 403 && outcome.operationMayHaveApplied === true) {
    return '本次尝试被拒绝，但更早的一次写入可能已经生效。请使用同一次提交重试，不要更换提交键。'
  }
  if (outcome.status === 403) return '写回被拒绝。原提交仍保留，请在修正授权后使用原提交重试。'
  if (outcome.status === 404) return '该 BOM 行不存在或不属于当前 Part。原提交仍保留，修正后请用原提交重试。'
  if (outcome.status === 422 || outcome.status === 400) return '写回内容无效。原提交仍保留，修正后请用原提交重试。'
  return LINE_UNCONFIRMED
}

function ecoFailureMessage(outcome: Extract<PlmBomEcoRevisionIntentResult, { ok: false }>): string {
  if (outcome.reason === 'not_locked') {
    return '该 Part 当前未处于锁定状态，可直接编辑写回，无需 ECO 修订。原提交仍保留，请使用原提交键重试。'
  }
  if (outcome.reason === 'eco_intent_rejected') {
    return '发起 ECO 修订被拒（可能存在并发变更或该 Part 不可修订）。原提交仍保留，请使用原提交键重试。'
  }
  if (outcome.reason === 'frozen-context') return '本次请求与已冻结的请求不一致，没有发出新的修订。'
  if (outcome.status === 403 && outcome.operationMayHaveApplied === true) {
    return '本次尝试被拒绝，但更早的一次修订可能已经生效。请使用同一次提交重试，不要更换提交键。'
  }
  if (outcome.status === 403) return '修订被拒绝。原提交仍保留，请在修正授权后使用原提交重试。'
  return ECO_UNCONFIRMED
}

function setLineMessage(source: string, part: string, lineId: string, message: string): void {
  if (!viewStill(source, part)) return
  lineMessages.value = { ...lineMessages.value, [lineId]: message }
}

function nullableDraft(value: string): string | null {
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function liveLinePatch(line: PlmBomMultitableLine): PlmBomMultitableLinePatch {
  if (!/^[\w.:-]+$/.test(line.bom_line_id)) return {}
  const row = panelRoot.value?.querySelector(`[data-testid="plm-bom-review-row"][data-bom-line-id="${line.bom_line_id}"]`)
  if (!row) return {}
  const read = (testId: string) => {
    const input = row.querySelector(`[data-testid="${testId}"]`)
    return input instanceof HTMLInputElement ? input.value : ''
  }
  const patch: PlmBomMultitableLinePatch = {}
  const quantityText = read('plm-bom-review-quantity-input').trim()
  const quantity = quantityText ? Number(quantityText) : null
  if (quantity !== line.quantity) patch.quantity = quantity
  const uom = nullableDraft(read('plm-bom-review-uom-input'))
  if (uom !== (line.uom ?? null)) patch.uom = uom
  const findNum = nullableDraft(read('plm-bom-review-find-num-input'))
  if (findNum !== (line.find_num ?? null)) patch.find_num = findNum
  const refdes = nullableDraft(read('plm-bom-review-refdes-input'))
  if (refdes !== (line.refdes ?? null)) patch.refdes = refdes
  return patch
}

function lineEtag(line: PlmBomMultitableLine): string | null {
  return typeof line.write_etag === 'string' && line.write_etag ? line.write_etag : null
}

function holdIdentity(operationKind: 'line' | 'eco-intent', partId: string, bomLineId: string | null): void {
  identityHold.value = { operationKind, partId, bomLineId }
}

function noteIrrecoverable(operationKey: string, status: number): void {
  if (status === 412 || status === 422) rememberIrrecoverableBomWrite(operationKey, status)
}

async function dispatchLine(input: {
  partId: string
  bomLineId: string
  patch: PlmBomMultitableLinePatch
  ifMatch: string | null
  clientKey?: string
  separate?: boolean
}): Promise<void> {
  if (writeBusy.value) return
  const capturedSource = props.dataSourceId
  const capturedPart = input.partId
  const capturedLineId = input.bomLineId
  const ownGeneration = generation
  const ownSession = session
  const stillIntent = () => stillCurrent(capturedSource, capturedPart, ownGeneration, ownSession)
  writeBusy.value = true
  submittingLineId.value = capturedLineId
  setLineMessage(capturedSource, capturedPart, capturedLineId, '正在写回…')
  const own = new AbortController()
  controller = own
  try {
    const rows = await listPlmBomWriteBindings(own.signal)
    if (!stillIntent()) return
    const selected = selectBound(rows, capturedSource)
    if (selected === 'missing' || selected === 'ambiguous') {
      setLineMessage(capturedSource, capturedPart, capturedLineId, selected === 'ambiguous' ? LINE_AMBIGUOUS : LINE_UNBOUND)
      return
    }
    const identity = identityOf(selected)
    const found = input.separate ? { status: 'none' as const } : findFrozenBomWrite({
      operationKind: 'line',
      dataSourceId: capturedSource,
      partId: capturedPart,
      bomLineId: capturedLineId,
      identity,
      ...(input.clientKey ? { pinClientKey: input.clientKey } : {}),
    })
    if (!stillIntent()) return
    if (found.status === 'identity-changed') {
      holdIdentity('line', capturedPart, capturedLineId)
      setLineMessage(capturedSource, capturedPart, capturedLineId, LINE_IDENTITY)
      void refreshPending(capturedPart, identity)
      return
    }
    if (found.status === 'multiple') {
      setLineMessage(capturedSource, capturedPart, capturedLineId, LINE_MULTIPLE)
      void refreshPending(capturedPart, identity)
      return
    }
    if (found.status === 'storage') {
      setLineMessage(capturedSource, capturedPart, capturedLineId, LINE_STORAGE)
      storageMessage.value = LINE_STORAGE
      return
    }
    let frozen: FrozenBomWrite
    if (found.status === 'existing') {
      frozen = found.frozen
    } else {
      const patch = whitelistPatch(input.patch)
      if (Object.keys(patch).length === 0) {
        setLineMessage(capturedSource, capturedPart, capturedLineId, '没有可写的单元格。未发送写入。')
        return
      }
      let clientKey: string
      try {
        clientKey = randomUuid()
      } catch {
        setLineMessage(capturedSource, capturedPart, capturedLineId, LINE_KEY)
        return
      }
      const committed = commitFrozenBomWrite({
        clientKey,
        operationKind: 'line',
        dataSourceId: identity.dataSourceId,
        partId: capturedPart,
        bomLineId: capturedLineId,
        patch,
        ifMatch: input.ifMatch,
        identity,
      }, undefined, input.separate ? { separate: true } : undefined)
      if (!committed.ok || !committed.frozen.bomLineId || !committed.frozen.patch) {
        setLineMessage(
          capturedSource,
          capturedPart,
          capturedLineId,
          committed.ok ? LINE_STORAGE : committed.reason === 'identity-changed' ? LINE_IDENTITY : committed.reason === 'multiple' ? LINE_MULTIPLE : LINE_STORAGE,
        )
        if (!committed.ok && committed.reason === 'multiple') void refreshPending(capturedPart, identity)
        return
      }
      frozen = committed.frozen
    }
    if (!stillIntent() || !frozen.bomLineId || !frozen.patch) return
    const outcome = await updatePlmBomMultitableLine(
      frozen.dataSourceId,
      frozen.partId,
      frozen.bomLineId,
      frozen.patch,
      frozen.clientKey,
      frozen.ifMatch,
    )
    if (ownSession !== readAuthSessionSignature()) return
    if (!viewStill(capturedSource, capturedPart)) {
      if (outcome.ok) removeFrozenBomWrite(frozen)
      return
    }
    if (ownGeneration !== generation) return
    if (outcome.ok) {
      removeFrozenBomWrite(frozen)
      const live = context.value?.lines.find((line) => line.bom_line_id === capturedLineId)
      if (live) applyLinePatch(live, frozen.patch)
      setLineMessage(capturedSource, capturedPart, capturedLineId, '写回成功。')
      await refreshAcceptedLineEtag(
        capturedSource,
        capturedPart,
        capturedLineId,
        ownGeneration,
        ownSession,
        own.signal,
      )
      void refreshPending(capturedPart, identity)
      return
    }
    if (outcome.status === 409 && outcome.reason === 'lifecycle_locked') writebackLocked.value = true
    noteIrrecoverable(frozen.clientKey, outcome.status)
    setLineMessage(capturedSource, capturedPart, capturedLineId, writebackMessage(outcome))
    void refreshPending(capturedPart, identity)
  } catch (error) {
    if (!stillIntent()) return
    const message = error instanceof PlmBomWriteBindingError ? error.message : LINE_UNCONFIRMED
    setLineMessage(capturedSource, capturedPart, capturedLineId, message)
    void refreshPending(capturedPart)
  } finally {
    if (ownGeneration === generation) {
      writeBusy.value = false
      submittingLineId.value = null
    }
  }
}

async function dispatchEco(part: string, pinnedClientKey?: string, separate = false): Promise<void> {
  if (writeBusy.value || ecoIntentStatus.value === 'done') return
  const capturedSource = props.dataSourceId
  const ownGeneration = generation
  const ownSession = session
  const stillIntent = () => stillCurrent(capturedSource, part, ownGeneration, ownSession)
  writeBusy.value = true
  ecoIntentStatus.value = 'requesting'
  if (viewStill(capturedSource, part)) ecoIntentMessage.value = ''
  const own = new AbortController()
  controller = own
  try {
    const rows = await listPlmBomWriteBindings(own.signal)
    if (!stillIntent()) return
    const selected = selectBound(rows, capturedSource)
    if (selected === 'missing' || selected === 'ambiguous') {
      if (viewStill(capturedSource, part)) {
        ecoIntentStatus.value = 'idle'
        ecoIntentMessage.value = selected === 'ambiguous' ? LINE_AMBIGUOUS : LINE_UNBOUND
      }
      return
    }
    const identity = identityOf(selected)
    const found = separate ? { status: 'none' as const } : findFrozenBomWrite({
      operationKind: 'eco-intent',
      dataSourceId: capturedSource,
      partId: part,
      bomLineId: null,
      identity,
      ...(pinnedClientKey ? { pinClientKey: pinnedClientKey } : {}),
    })
    if (!stillIntent()) return
    if (found.status === 'identity-changed') holdIdentity('eco-intent', part, null)
    if (found.status === 'identity-changed' || found.status === 'storage' || found.status === 'multiple') {
      if (viewStill(capturedSource, part)) {
        ecoIntentStatus.value = 'idle'
        ecoIntentMessage.value = found.status === 'identity-changed'
          ? LINE_IDENTITY
          : found.status === 'multiple' ? LINE_MULTIPLE : LINE_STORAGE
        if (found.status === 'storage') storageMessage.value = LINE_STORAGE
      }
      return
    }
    let frozen: FrozenBomWrite
    if (found.status === 'existing') frozen = found.frozen
    else {
      let clientKey: string
      try {
        clientKey = randomUuid()
      } catch {
        if (viewStill(capturedSource, part)) {
          ecoIntentStatus.value = 'idle'
          ecoIntentMessage.value = LINE_KEY
        }
        return
      }
      const committed = commitFrozenBomWrite({
        clientKey,
        operationKind: 'eco-intent',
        dataSourceId: identity.dataSourceId,
        partId: part,
        bomLineId: null,
        patch: null,
        ifMatch: null,
        identity,
      }, undefined, separate ? { separate: true } : undefined)
      if (!committed.ok) {
        if (viewStill(capturedSource, part)) {
          ecoIntentStatus.value = 'idle'
          ecoIntentMessage.value = committed.reason === 'identity-changed'
            ? LINE_IDENTITY
            : committed.reason === 'multiple' ? LINE_MULTIPLE : LINE_STORAGE
        }
        if (committed.reason === 'multiple') void refreshPending(part, identity)
        return
      }
      frozen = committed.frozen
    }
    if (!stillIntent()) return
    const outcome = await requestPlmBomEcoRevisionIntent(frozen.dataSourceId, frozen.partId, frozen.clientKey)
    if (ownSession !== readAuthSessionSignature()) return
    if (!viewStill(capturedSource, part)) {
      if (outcome.ok) removeFrozenBomWrite(frozen)
      return
    }
    if (ownGeneration !== generation) return
    if (outcome.ok) {
      removeFrozenBomWrite(frozen)
      ecoIntentStatus.value = 'done'
      ecoIntentMessage.value = outcome.attached
        ? `已挂接到该 Part 现有的开放 ECO（${outcome.eco_id}）；请在 PLM 中继续该 ECO 的修订与审批。`
        : `已发起 ECO 修订（${outcome.eco_id}）；修订分支已创建，请在 PLM 中完成变更与审批。`
      void refreshPending(part, identity)
      return
    }
    ecoIntentStatus.value = 'idle'
    if (outcome.reason === 'not_locked') writebackLocked.value = false
    noteIrrecoverable(frozen.clientKey, outcome.status)
    ecoIntentMessage.value = ecoFailureMessage(outcome)
    void refreshPending(part, identity)
  } catch (error) {
    if (!stillIntent()) return
    if (!viewStill(capturedSource, part)) return
    ecoIntentStatus.value = 'idle'
    ecoIntentMessage.value = error instanceof PlmBomWriteBindingError ? error.message : ECO_UNCONFIRMED
    void refreshPending(part)
  } finally {
    if (ownGeneration === generation) {
      if (ecoIntentStatus.value === 'requesting') ecoIntentStatus.value = 'idle'
      writeBusy.value = false
      submittingLineId.value = null
    }
  }
}

async function load(): Promise<void> {
  const pid = partId.value.trim()
  if (!pid) return
  const ownSource = props.dataSourceId
  const ownPart = pid
  const ownSession = session
  generation += 1
  const ownGeneration = generation
  controller?.abort()
  controller = new AbortController()
  const signal = controller.signal
  const current = () => stillCurrent(ownSource, ownPart, ownGeneration, ownSession)
  loading.value = true
  writeBusy.value = false
  submittingLineId.value = null
  identityHold.value = null
  lineMessages.value = {}
  writebackLocked.value = false
  ecoIntentStatus.value = 'idle'
  ecoIntentMessage.value = ''
  pendingRows.value = []
  irrecoverableKeys.value = []
  visibleIdentity.value = null
  try {
    const next = await getPlmBomMultitableContext(ownSource, ownPart, signal)
    if (!current()) return
    result.value = next
  } catch {
    if (!current()) return
    result.value = { data_source_id: ownSource, available: false, reason: 'unavailable' }
  } finally {
    if (current()) {
      loading.value = false
      void refreshPending(ownPart)
    }
  }
}

function submitLinePatch(payload: { line: PlmBomMultitableLine; patch: PlmBomMultitableLinePatch }): void {
  const part = context.value?.part.part_id
  if (!part) return
  const etag = typeof payload.line.write_etag === 'string' && payload.line.write_etag
    ? payload.line.write_etag
    : null
  void dispatchLine({
    partId: part,
    bomLineId: payload.line.bom_line_id,
    patch: payload.patch,
    ifMatch: etag,
  })
}

function requestEcoIntent(): void {
  const part = context.value?.part.part_id
  if (!part || ecoIntentStatus.value !== 'idle') return
  void dispatchEco(part)
}

function startSeparate(row: FrozenBomWrite): void {
  if (!visibleIdentity.value || !sameBomWriteIdentity(row.identity, visibleIdentity.value)) return
  if (row.operationKind === 'eco-intent') {
    if (ecoIntentStatus.value === 'done') ecoIntentStatus.value = 'idle'
    void dispatchEco(row.partId, undefined, true)
    return
  }
  if (!row.bomLineId) return
  const line = context.value?.lines.find((item) => item.bom_line_id === row.bomLineId)
  if (!line) return
  void dispatchLine({
    partId: row.partId,
    bomLineId: row.bomLineId,
    patch: liveLinePatch(line),
    ifMatch: lineEtag(line),
    separate: true,
  })
}

function startIdentitySeparate(): void {
  const hold = identityHold.value
  if (!hold) return
  if (hold.operationKind === 'eco-intent') {
    if (ecoIntentStatus.value === 'done') ecoIntentStatus.value = 'idle'
    void dispatchEco(hold.partId, undefined, true)
    return
  }
  if (!hold.bomLineId) return
  const line = context.value?.lines.find((item) => item.bom_line_id === hold.bomLineId)
  if (!line) return
  void dispatchLine({
    partId: hold.partId,
    bomLineId: hold.bomLineId,
    patch: liveLinePatch(line),
    ifMatch: lineEtag(line),
    separate: true,
  })
}

function retryPending(row: FrozenBomWrite): void {
  if (!visibleIdentity.value || !sameBomWriteIdentity(row.identity, visibleIdentity.value)) return
  if (row.operationKind === 'eco-intent') {
    if (ecoIntentStatus.value === 'done') ecoIntentStatus.value = 'idle'
    void dispatchEco(row.partId, row.clientKey)
    return
  }
  if (!row.bomLineId || !row.patch) return
  void dispatchLine({
    partId: row.partId,
    bomLineId: row.bomLineId,
    patch: row.patch,
    ifMatch: row.ifMatch,
    clientKey: row.clientKey,
  })
}

function applyLinePatch(line: PlmBomMultitableLine, patch: BomWritePatch): void {
  if ('quantity' in patch) {
    line.quantity = typeof patch.quantity === 'number' || patch.quantity === null ? patch.quantity : Number(patch.quantity)
  }
  if ('uom' in patch) line.uom = patch.uom ?? null
  if ('find_num' in patch) line.find_num = patch.find_num ?? null
  if ('refdes' in patch) line.refdes = patch.refdes ?? null
}

// The accepted receipt is only { ok, bom_line_id }. The next If-Match has to come from a
// projection of this same target. A failed or stale read leaves the previous etag and does
// not reopen the accepted snapshot or remove any other pending record.
async function refreshAcceptedLineEtag(
  source: string,
  part: string,
  lineId: string,
  ownGeneration: number,
  ownSession: string,
  signal: AbortSignal,
): Promise<void> {
  try {
    const next = await getPlmBomMultitableContext(source, part, signal)
    if (!stillCurrent(source, part, ownGeneration, ownSession) || !viewStill(source, part)) return
    if (!next.available || !next.context || next.context.part.part_id !== part) return
    const projected = next.context.lines.find((line) => line.bom_line_id === lineId)
    const live = context.value?.lines.find((line) => line.bom_line_id === lineId)
    if (!projected || !live || projected.write_etag === undefined) return
    live.write_etag = typeof projected.write_etag === 'string' && projected.write_etag
      ? projected.write_etag
      : null
  } catch {
    // The receipt is already accepted. Keep that success and the previous etag.
  }
}

watch(() => props.dataSourceId, () => {
  generation += 1
  pendingTicket += 1
  controller?.abort()
  controller = null
  result.value = null
  lineMessages.value = {}
  identityHold.value = null
  pendingRows.value = []
  irrecoverableKeys.value = []
  visibleIdentity.value = null
  writebackLocked.value = false
  ecoIntentStatus.value = 'idle'
  ecoIntentMessage.value = ''
  loading.value = false
  writeBusy.value = false
  submittingLineId.value = null
  storageMessage.value = ''
})

onMounted(() => window.addEventListener('storage', resetForSession))
onBeforeUnmount(() => {
  generation += 1
  controller?.abort()
  unsubscribe()
  window.removeEventListener('storage', resetForSession)
})
</script>

<style scoped>
.bom-review { display: flex; flex-direction: column; gap: 8px; }
.bom-review__head { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; }
.bom-review__query { display: flex; align-items: flex-end; gap: 8px; }
.bom-review__query label { display: flex; flex-direction: column; gap: 2px; }
.bom-review__button { white-space: nowrap; }
.bom-review__hint--muted { opacity: 0.6; }
.bom-review__hint--strong { font-weight: 600; }
.bom-review__eco-intent, .bom-review__pending { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
</style>
