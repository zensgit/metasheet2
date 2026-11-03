<template>
  <section
    class="sp-refresh"
    data-testid="stock-prep-refresh-queue"
    :data-refresh-rendering="rendering"
  >
    <!-- 备料分批拉取第一期 step 4 PR-7 (design §13; plan §8 / §9.5 U03-U04) — 「拉取待确认」: the puller's holds of a
         governed project, one by one, with the comparison and the demand evidence, and the three decisions (确认沿用 /
         暂不处理 / 结束沿用关系). Every control below carries its manifest control id (workbenchAccess.ts); each is
         PRESENT whenever a hold that OFFERS it is shown (this tab exists only for the PULL tier) and DISABLED — never
         absent — while a precondition is missing, so presence = grant (RQ-ALIGN). PR-7b (review N1): only a
         `relationship_reconfirm` hold offers 「结束沿用关系」 — the store refuses to end a relationship that is not
         `needs_reconfirmation`, so a `relationship_content_change` hold (an ACTIVE relationship) shows no end control.
         PR-7b (review N2 / N8): every server token on this page is shown in words (plainLanguage.ts
         STOCK_PREP_REFRESH_*_PLAIN); an unrecognised token reads 「未识别」 with the token apart from the sentence. -->
    <p v-if="rendering === 'no_project'" class="sp-refresh__state" data-testid="stock-prep-refresh-state">
      {{ bi(plainFor('no_project').zh, plainFor('no_project').en) }}
      <span class="sp-refresh__hint">{{ bi(plainFor('no_project').zhNext ?? '', plainFor('no_project').enNext ?? '') }}</span>
    </p>
    <template v-else>
      <div class="sp-refresh__head">
        <span class="sp-refresh__project" data-testid="stock-prep-refresh-project">{{ openedProjectNo }}</span>
        <button
          type="button"
          class="sp-refresh__button"
          data-testid="stock-prep-refresh-holds"
          :disabled="busy"
          @click="reload()"
        >{{ busy ? bi('正在读取…', 'Reading…') : bi('重新读取', 'Read again') }}</button>
      </div>

      <p v-if="notice" class="sp-refresh__notice" data-testid="stock-prep-refresh-notice" role="status">
        {{ bi(notice.zh, notice.en) }}
      </p>

      <p v-if="errorCode" class="sp-refresh__error" data-testid="stock-prep-refresh-error" role="alert">
        {{ bi(errorText.zh, errorText.en) }}
        <code class="sp-refresh__token">{{ errorCode }}</code>
        <span v-if="errorText.zhNext" class="sp-refresh__hint">{{ bi(errorText.zhNext, errorText.enNext ?? '') }}</span>
        <button type="button" class="sp-refresh__link" data-testid="stock-prep-refresh-error-copy" @click="copyError">
          {{ bi('复制这条报错', 'Copy this error') }}
        </button>
      </p>

      <!-- THE THREE RENDERINGS (plan §8) — never one for another. -->
      <p
        v-if="rendering === 'not_governed' || rendering === 'unreadable' || rendering === 'none_pending'"
        class="sp-refresh__state"
        data-testid="stock-prep-refresh-state"
      >
        {{ bi(plainFor(rendering).zh, plainFor(rendering).en) }}
        <span class="sp-refresh__hint">{{ bi(plainFor(rendering).zhNext ?? '', plainFor(rendering).enNext ?? '') }}</span>
      </p>

      <!-- O-11 (design §23.3): a governed project that left the pilot. -->
      <p v-if="governed === 'protected' && rendering === 'holds'" class="sp-refresh__note" data-testid="stock-prep-refresh-asymmetry">
        {{ bi(asymmetry.zh, asymmetry.en) }}
      </p>

      <template v-if="rendering === 'holds'">
        <p class="sp-refresh__note" data-testid="stock-prep-refresh-receipt-note">{{ bi(receiptNote.zh, receiptNote.en) }}</p>
        <ol class="sp-refresh__holds">
          <li
            v-for="hold in holds"
            :key="hold.id"
            class="sp-refresh__hold"
            data-testid="stock-prep-refresh-hold"
            :data-hold-kind="hold.kind"
            :data-confirmable="hold.confirmable ? 'true' : 'false'"
          >
            <h4 class="sp-refresh__hold-title" data-testid="stock-prep-refresh-hold-title">
              {{ wordsOr(holdKindWords(hold.kind), bi('其他待确认项', 'Other hold')) }}
              <code v-if="!holdKindWords(hold.kind)" class="sp-refresh__token" data-testid="stock-prep-refresh-unknown-token">{{ hold.kind }}</code>
            </h4>
            <p v-if="hold.shapeToken" class="sp-refresh__hint" data-testid="stock-prep-refresh-shape" :data-shape-token="hold.shapeToken">
              {{ bi('BOM 形态', 'BOM shape') }}:{{ wordsOr(shapeWords(hold.shapeToken), bi('未识别的形态', 'an unrecognised shape')) }}
              <code v-if="!shapeWords(hold.shapeToken)" class="sp-refresh__token" data-testid="stock-prep-refresh-unknown-token">{{ hold.shapeToken }}</code>
            </p>
            <!-- PR-7b (review N2, plan W7): EVERY hold that cannot be confirmed says why, in words. -->
            <p v-if="!hold.confirmable" class="sp-refresh__hint" data-testid="stock-prep-refresh-not-confirmable" :data-not-confirmable-reason="hold.notConfirmableReason ?? ''">
              {{ notConfirmableText(hold) }}
              <code v-if="hold.notConfirmableReason && !reasonWords(hold.notConfirmableReason)" class="sp-refresh__token" data-testid="stock-prep-refresh-unknown-token">{{ hold.notConfirmableReason }}</code>
            </p>
            <p v-if="hold.runbookOnly" class="sp-refresh__hint" data-testid="stock-prep-refresh-runbook-only">
              {{ bi('这条沿用关系已升级为专项修复,等运行手册关闭。', 'This relationship is under specialist repair until the runbook closes it.') }}
            </p>

            <!-- Pages read (the receipt): the confirm needs every pair page served. -->
            <p class="sp-refresh__pages" data-testid="stock-prep-refresh-pages">
              {{ pagesText(hold) }}
              <button
                v-if="hold.pairPage && hold.pairPage.next !== null"
                type="button"
                class="sp-refresh__link"
                data-testid="stock-prep-refresh-next-pair-page"
                :disabled="busy"
                @click="readPairPage(hold)"
              >{{ bi('下一页对照', 'Next comparison page') }}</button>
            </p>

            <!-- The comparison (values, PULL tier only). -->
            <table v-if="comparisonRows(hold).length > 0" class="sp-refresh__table" data-testid="stock-prep-refresh-comparison">
              <thead>
                <tr>
                  <th>{{ bi('位置', 'Position') }}</th>
                  <th>{{ bi('字段', 'Field') }}</th>
                  <th>{{ bi('原来', 'Before') }}</th>
                  <th>{{ bi('现在', 'Now') }}</th>
                  <th>{{ bi('对照', 'Check') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(row, index) in comparisonRows(hold)" :key="index">
                  <td>{{ row.path }}</td>
                  <td>{{ row.field }}</td>
                  <td>{{ row.before }}</td>
                  <td>{{ row.after }}</td>
                  <td :data-comparison-status="row.status">{{ row.statusText }}</td>
                </tr>
              </tbody>
            </table>
            <table v-if="contentRows(hold).length > 0" class="sp-refresh__table" data-testid="stock-prep-refresh-content-change">
              <thead>
                <tr>
                  <th>{{ bi('字段', 'Field') }}</th>
                  <th>{{ bi('变化', 'Change') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(row, index) in contentRows(hold)" :key="index">
                  <td>{{ row.field }}</td>
                  <td>{{ row.change }}</td>
                </tr>
              </tbody>
            </table>

            <!-- Evidence and the relationship detail: read on demand (each read is audited server-side). -->
            <div class="sp-refresh__actions">
              <button
                type="button"
                class="sp-refresh__button"
                data-testid="stock-prep-refresh-evidence"
                :disabled="busy"
                @click="readEvidence(hold)"
              >{{ bi('查看需求依据', 'Show the demand evidence') }}</button>
              <button
                v-if="hold.continuationId"
                type="button"
                class="sp-refresh__button"
                data-testid="stock-prep-refresh-continuation"
                :disabled="busy"
                @click="readDetail(hold)"
              >{{ bi('查看沿用关系', 'Show the relationship') }}</button>
            </div>
            <p v-if="evidenceById[hold.id]" class="sp-refresh__evidence" data-testid="stock-prep-refresh-evidence-result">
              {{ evidenceText(hold.id) }}
            </p>
            <p v-if="hold.continuationId && detailById[hold.continuationId]" class="sp-refresh__evidence" data-testid="stock-prep-refresh-continuation-result">
              {{ detailText(hold.continuationId) }}
            </p>

            <!-- A demand whose history cannot be verified needs an explicit acknowledgement (the server 400s without). -->
            <label v-if="hold.history === 'history_unknown' && stockPrepRefreshHoldConfirmMode(hold)" class="sp-refresh__ack" data-testid="stock-prep-refresh-history-ack">
              <input v-model="historyAck[hold.id]" type="checkbox" />
              {{ bi('我知道这份需求的历史无法查证', 'I understand this demand’s history cannot be verified') }}
            </label>

            <!-- Typed project number: confirm, re-confirm and every end need it (R-62 ⑧); 「暂不处理」 does not. PR-7b
                 (review N3): the TYPED value (trimmed) is what is sent as `confirmProjectNo`, as the archive and
                 pilot-enable flows do, so the server's own typed check is a real second check. -->
            <label v-if="stockPrepRefreshHoldConfirmMode(hold) || endOffered(hold)" class="sp-refresh__typed">
              {{ bi('输入项目号以确认操作', 'Type the project number to confirm') }}
              <input
                v-model="typedNo[hold.id]"
                type="text"
                data-testid="stock-prep-refresh-typed-project-no"
                autocomplete="off"
              />
            </label>

            <div class="sp-refresh__actions">
              <button
                type="button"
                class="sp-refresh__button"
                data-testid="stock-prep-refresh-keep"
                :disabled="busy"
                @click="keep(hold)"
              >{{ bi('暂不处理', 'Keep for now') }}</button>
              <button
                v-if="stockPrepRefreshHoldConfirmMode(hold)"
                type="button"
                class="sp-refresh__button sp-refresh__button--primary"
                data-testid="stock-prep-refresh-confirm"
                :disabled="busy || !confirmBodyFor(hold)"
                @click="confirm(hold)"
              >{{ stockPrepRefreshHoldConfirmMode(hold) === 'reconfirm' ? bi('重新确认', 'Re-confirm') : bi('确认沿用', 'Confirm the relationship') }}</button>
            </div>
            <p v-if="stockPrepRefreshHoldConfirmMode(hold) && !confirmBodyFor(hold)" class="sp-refresh__hint" data-testid="stock-prep-refresh-confirm-why">
              {{ confirmWhy(hold) }}
            </p>

            <!-- END (relationship holds only): release only when the page shows the facts for it; escalate with a
                 typed number and the S25 warning. `superseded_by_new_confirmation` is confirm-only, never offered. -->
            <fieldset v-if="endOffered(hold)" class="sp-refresh__end" data-testid="stock-prep-refresh-end-fieldset">
              <legend>{{ bi('结束沿用关系', 'End the relationship') }}</legend>
              <label v-if="releaseAdmissibleOnPage(hold)" data-testid="stock-prep-refresh-end-release">
                <input v-model="endOutcome[hold.id]" type="radio" value="release_to_normal_refresh" />
                {{ bi('放回普通刷新(这次计算显示新位置已不存在)', 'Release to the normal refresh (this computation shows no new position)') }}
              </label>
              <p v-else class="sp-refresh__hint" data-testid="stock-prep-refresh-end-no-release">
                {{ bi('本次计算没有记录新位置数(或新位置仍在)——请重新试算后再结束。', 'This computation recorded no new-position count (or the new position is still there) — preview again before ending it.') }}
              </p>
              <label data-testid="stock-prep-refresh-end-escalate">
                <input v-model="endOutcome[hold.id]" type="radio" value="escalate_special_repair" />
                {{ bi('升级为专项修复', 'Escalate to specialist repair') }}
              </label>
              <p v-if="endOutcome[hold.id] === 'escalate_special_repair'" class="sp-refresh__warning" data-testid="stock-prep-refresh-escalate-warning">
                {{ bi('升级为专项修复后,本项目所有确认/重新确认/放回普通刷新都要等运行手册关闭。', 'After an escalation, every confirm / re-confirm / release on this project waits until the runbook closes it.') }}
              </p>
              <button
                type="button"
                class="sp-refresh__button"
                data-testid="stock-prep-refresh-end"
                :disabled="busy || !endBodyFor(hold)"
                @click="end(hold)"
              >{{ bi('结束沿用关系', 'End the relationship') }}</button>
              <p v-if="!endBodyFor(hold)" class="sp-refresh__hint" data-testid="stock-prep-refresh-end-why">{{ endWhy(hold) }}</p>
            </fieldset>
          </li>
        </ol>
        <button
          v-if="nextCursor"
          type="button"
          class="sp-refresh__link"
          data-testid="stock-prep-refresh-more"
          :disabled="busy"
          @click="readMore"
        >{{ bi('更多待确认项', 'More holds') }}</button>
      </template>

      <!-- E-4: a confirm / end is recorded, and only a NEW preview makes the plan take effect. -->
      <div v-if="previewAgain" class="sp-refresh__preview-again" data-testid="stock-prep-refresh-preview-again" role="status">
        <p>{{ bi(previewAgainText.zh, previewAgainText.en) }}</p>
        <p v-if="previewAgain === 'confirmed'" class="sp-refresh__hint" data-testid="stock-prep-refresh-rekey-note">{{ bi(rekeyNote.zh, rekeyNote.en) }}</p>
        <button
          type="button"
          class="sp-refresh__button sp-refresh__button--primary"
          data-testid="stock-prep-refresh-go-preview"
          @click="goPreview"
        >{{ bi('去重新试算', 'Preview again') }}</button>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
// 「拉取待确认」 (备料分批拉取第一期 step 4 PR-7). VALUES: hold payloads, evidence and relationship details live in this
// component's refs ONLY — cleared when the project changes and on unmount; never written to localStorage /
// sessionStorage, never put in an emit payload, the error banner or a clipboard string (only codes are copyable).
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { useLocale } from '../../../composables/useLocale'
import type { IntegrationScope } from '../../../services/integration/workbench'
import { StockPreparationConfirmApiError } from '../../../services/integration/stockPreparation/confirmApi'
import {
  STOCK_PREP_REFRESH_ITEM_UPDATED,
  STOCK_PREP_REFRESH_LEDGER_REKEY_NOTE,
  STOCK_PREP_REFRESH_NON_PILOT_ASYMMETRY,
  STOCK_PREP_REFRESH_PREVIEW_AGAIN,
  STOCK_PREP_REFRESH_RECEIPT_NOTE,
  STOCK_PREP_REFRESH_RENDERING_PLAIN,
  STOCK_PREP_REFRESH_COMPARISON_STATUS_PLAIN,
  STOCK_PREP_REFRESH_CONTINUATION_STATUS_PLAIN,
  STOCK_PREP_REFRESH_HISTORY_PLAIN,
  STOCK_PREP_REFRESH_HOLD_KIND_PLAIN,
  STOCK_PREP_REFRESH_NOT_CONFIRMABLE_PLAIN,
  STOCK_PREP_REFRESH_SHAPE_PLAIN,
  STOCK_PREP_REFRESH_TOKEN_UNKNOWN,
  stockPrepErrorCopyText,
  stockPrepErrorPlain,
  stockPrepRefreshTokenPlain,
  type StockPrepPlainEntry,
  type StockPrepPlainText,
} from '../../../services/integration/stockPreparation/plainLanguage'
import {
  buildCandidateConfirmBody,
  buildEndBody,
  buildReconfirmBody,
  createStockPrepRefreshQueueApi,
  holdFingerprintsPresent,
  receiptCompleteFor,
  receiptProgressFor,
  releaseAdmissibleOnPage,
  stockPrepRefreshCellText,
  stockPrepRefreshHoldConfirmMode,
  stockPrepRefreshNeedsReread,
  type StockPrepRefreshConfirmBody,
  type StockPrepRefreshContinuationDetail,
  type StockPrepRefreshEndBody,
  type StockPrepRefreshEndOutcome,
  type StockPrepRefreshHold,
  type StockPrepRefreshHoldPage,
  type StockPrepRefreshQueueApi,
  type StockPrepRefreshReceipt,
} from '../../../services/integration/stockPreparation/refreshQueue'
import { parseStockPrepRefreshStanza, type StockPrepRefreshStanza } from '../../../services/integration/stockPreparation/refreshState'
import { stockPrepProjectNumbersMatch } from '../../../services/integration/stockPreparation/projectTarget'
import { copyTextToClipboard } from '../../../views/plm/plmClipboard'

const props = withDefaults(
  defineProps<{
    scope?: IntegrationScope
    /** The shell's opened project (`?projectNo=`). Empty: 未选项目. */
    projectNo?: string
    /** Test seam ONLY — an injected client double. Production builds its own from `scope`. */
    api?: StockPrepRefreshQueueApi | null
  }>(),
  { scope: () => ({}), projectNo: '', api: null },
)

const emit = defineEmits<{
  /** The shell's one tab-nav surface; 「去重新试算」 opens 项目备料 on this project. */
  (e: 'navigate-stage', viewKey: string, projectNo?: string): void
  /** Values-free: the page's own refresh summary (tokens and counts), for the rail count. */
  (e: 'refresh-changed', stanza: StockPrepRefreshStanza | null): void
}>()

const { locale } = useLocale()
function bi(zh: string, en: string): string {
  return locale.value === 'zh-CN' ? zh : en
}

type Rendering = 'no_project' | 'loading' | 'not_governed' | 'unreadable' | 'none_pending' | 'holds' | 'refused' | 'not_registered' | 'failed'

const openedProjectNo = computed<string>(() => (props.projectNo ?? '').trim())
const busy = ref(false)
const loaded = ref(false)
const summary = ref<StockPrepRefreshHoldPage['refresh'] | null>(null)
const holds = ref<StockPrepRefreshHold[]>([])
const nextCursor = ref<string | null>(null)
const receipt = ref<StockPrepRefreshReceipt | null>(null)
const errorCode = ref<string | null>(null)
const errorReason = ref<string | null>(null)
const errorStatus = ref<number>(0)
const notice = ref<StockPrepPlainText | null>(null)
const previewAgain = ref<'confirmed' | 'ended' | null>(null)
const evidenceById = reactive<Record<string, unknown>>({})
const detailById = reactive<Record<string, StockPrepRefreshContinuationDetail>>({})
const historyAck = reactive<Record<string, boolean>>({})
const typedNo = reactive<Record<string, string>>({})
const endOutcome = reactive<Record<string, StockPrepRefreshEndOutcome | ''>>({})
let generation = 0

const api = computed<StockPrepRefreshQueueApi>(() => props.api ?? createStockPrepRefreshQueueApi(props.scope))

const asymmetry = STOCK_PREP_REFRESH_NON_PILOT_ASYMMETRY
const receiptNote = STOCK_PREP_REFRESH_RECEIPT_NOTE
const rekeyNote = STOCK_PREP_REFRESH_LEDGER_REKEY_NOTE
const previewAgainText = STOCK_PREP_REFRESH_PREVIEW_AGAIN

const governed = computed<string | null>(() => summary.value?.governed ?? null)

const rendering = computed<Rendering>(() => {
  if (!openedProjectNo.value) return 'no_project'
  if (errorCode.value && !loaded.value) {
    if (errorStatus.value === 401 || errorStatus.value === 403) return 'refused'
    if (errorCode.value === 'STOCK_PREPARATION_PROJECT_ABSENT') return 'not_registered'
    if (errorStatus.value === 503 || errorStatus.value === 501) return 'unreadable'
    return 'failed'
  }
  if (!loaded.value) return 'loading'
  const current = summary.value
  if (!current || current.readable !== true || current.status === 'unreadable') return 'unreadable'
  if (current.status === 'not_governed') return 'not_governed'
  return holds.value.length > 0 ? 'holds' : 'none_pending'
})

function plainFor(key: string): StockPrepPlainEntry {
  return STOCK_PREP_REFRESH_RENDERING_PLAIN[key] ?? STOCK_PREP_REFRESH_RENDERING_PLAIN.unreadable
}

const errorText = computed<StockPrepPlainEntry>(() => stockPrepErrorPlain(errorCode.value ?? '', errorReason.value))

function clearValues(): void {
  holds.value = []
  nextCursor.value = null
  receipt.value = null
  summary.value = null
  loaded.value = false
  for (const store of [evidenceById, detailById, historyAck, typedNo, endOutcome] as Array<Record<string, unknown>>) {
    for (const key of Object.keys(store)) delete store[key]
  }
}

function recordError(error: unknown): void {
  if (error instanceof StockPreparationConfirmApiError) {
    errorCode.value = error.code
    errorReason.value = error.reason
    errorStatus.value = error.status
  } else {
    errorCode.value = 'STOCK_PREPARATION_CONFIRM_REQUEST_FAILED'
    errorReason.value = null
    errorStatus.value = 0
  }
}

function emitSummary(): void {
  const current = summary.value
  if (!current) {
    emit('refresh-changed', null)
    return
  }
  // Values-free by construction: tokens, booleans and counts only.
  emit('refresh-changed', parseStockPrepRefreshStanza({
    readable: current.readable === true,
    status: current.status,
    governed: current.governed,
    counts: current.counts,
    settled: false,
    exportAllowed: false,
  }))
}

/** Merge one page: the receipt accumulates pages server-side; holds are replaced by id (a pair page swaps one). */
function applyPage(page: StockPrepRefreshHoldPage, mode: 'replace' | 'append' | 'one'): void {
  summary.value = page.refresh
  if (page.readReceipt) receipt.value = page.readReceipt
  const incoming = Array.isArray(page.page?.holds) ? page.page.holds : []
  if (mode === 'replace') {
    holds.value = incoming
    nextCursor.value = page.page?.next ?? null
  } else if (mode === 'append') {
    const known = new Set(holds.value.map((hold) => hold.id))
    holds.value = [...holds.value, ...incoming.filter((hold) => !known.has(hold.id))]
    nextCursor.value = page.page?.next ?? null
  } else {
    holds.value = holds.value.map((hold) => incoming.find((entry) => entry.id === hold.id) ?? hold)
  }
  loaded.value = true
  emitSummary()
}

async function reload(options: { keepNotice?: boolean } = {}): Promise<void> {
  const projectNo = openedProjectNo.value
  if (!projectNo) return
  const ticket = ++generation
  busy.value = true
  errorCode.value = null
  if (!options.keepNotice) notice.value = null
  try {
    // Page 1 again — with the SAME receipt id, so pages already served stay counted (a fresh receipt otherwise).
    const page = await api.value.listHolds(projectNo, { receipt: receipt.value?.id ?? null })
    if (ticket !== generation) return
    applyPage(page, 'replace')
  } catch (error) {
    if (ticket !== generation) return
    loaded.value = false
    holds.value = []
    recordError(error)
    emit('refresh-changed', null)
  } finally {
    if (ticket === generation) busy.value = false
  }
}

async function readMore(): Promise<void> {
  const projectNo = openedProjectNo.value
  if (!projectNo || !nextCursor.value || busy.value) return
  await guarded(async () => {
    applyPage(await api.value.listHolds(projectNo, { cursor: nextCursor.value, receipt: receipt.value?.id ?? null }), 'append')
  })
}

async function readPairPage(hold: StockPrepRefreshHold): Promise<void> {
  const projectNo = openedProjectNo.value
  const next = hold.pairPage?.next
  if (!projectNo || next === null || next === undefined || busy.value) return
  await guarded(async () => {
    applyPage(await api.value.listHolds(projectNo, { holdId: hold.id, pairCursor: next, receipt: receipt.value?.id ?? null }), 'one')
  })
}

async function readEvidence(hold: StockPrepRefreshHold): Promise<void> {
  const projectNo = openedProjectNo.value
  if (!projectNo || busy.value) return
  await guarded(async () => {
    evidenceById[hold.id] = await api.value.readEvidence(projectNo, hold.id)
  })
}

async function readDetail(hold: StockPrepRefreshHold): Promise<void> {
  const projectNo = openedProjectNo.value
  if (!projectNo || !hold.continuationId || busy.value) return
  const continuationId = hold.continuationId
  await guarded(async () => {
    detailById[continuationId] = await api.value.readContinuation(projectNo, continuationId)
  })
}

/** One request at a time; a refusal that means "the item moved on" re-reads page 1 (hold-id churn). */
async function guarded(work: () => Promise<void>): Promise<boolean> {
  busy.value = true
  errorCode.value = null
  try {
    await work()
    return true
  } catch (error) {
    recordError(error)
    if (stockPrepRefreshNeedsReread(errorCode.value, errorReason.value)) {
      const code = errorCode.value
      const reason = errorReason.value
      busy.value = false
      await reload({ keepNotice: true })
      notice.value = STOCK_PREP_REFRESH_ITEM_UPDATED
      errorCode.value = code
      errorReason.value = reason
    }
    return false
  } finally {
    busy.value = false
  }
}

function typedMatches(hold: StockPrepRefreshHold): boolean {
  return stockPrepProjectNumbersMatch(openedProjectNo.value, typedNo[hold.id] ?? '')
}

/**
 * PR-7b (review N3): the number the puller TYPED, trimmed — sent as `confirmProjectNo` (as the archive and
 * pilot-enable flows send theirs, projectTarget.ts). The client check above still stops a mismatch before any
 * request; sending the typed value makes the server's own typed check (http-routes.cjs, 400
 * STOCK_PREP_REFRESH_DECISION_REQUEST_INVALID) a real second check instead of one that always passes.
 */
function typedConfirmNo(hold: StockPrepRefreshHold): string {
  return (typedNo[hold.id] ?? '').trim()
}

/** PR-7b (review N1): 「结束沿用关系」 only where the store can end it — a relationship awaiting re-confirmation. */
function endOffered(hold: StockPrepRefreshHold): boolean {
  return hold.kind === 'relationship_reconfirm' && typeof hold.continuationId === 'string' && hold.continuationId.length > 0
}

function confirmBodyFor(hold: StockPrepRefreshHold): StockPrepRefreshConfirmBody | null {
  if (!typedMatches(hold)) return null
  const mode = stockPrepRefreshHoldConfirmMode(hold)
  const options = { confirmProjectNo: typedConfirmNo(hold), historyAcknowledged: historyAck[hold.id] === true }
  if (mode === 'confirm') return buildCandidateConfirmBody(hold, receipt.value, options)
  if (mode === 'reconfirm') {
    const detail = hold.continuationId ? detailById[hold.continuationId] : undefined
    return buildReconfirmBody(hold, receipt.value, detail ? detail.continuation : null, options)
  }
  return null
}

function confirmWhy(hold: StockPrepRefreshHold): string {
  // PR-7b: the reason itself is the worded line under the title (stock-prep-refresh-not-confirmable); point to it.
  if (!hold.confirmable) return bi('原因见上。', 'See the reason above.')
  if (!holdFingerprintsPresent(hold)) return bi('这一项还缺对照或需求依据的记录,不能确认。', 'This item lacks a comparison or evidence record, so it cannot be confirmed.')
  if (!receiptCompleteFor(receipt.value, hold.id)) return bi('先把这一项的每一页对照都打开看过。', 'Open every comparison page of this item first.')
  if (hold.history === 'history_unknown' && historyAck[hold.id] !== true) return bi('先勾选「我知道这份需求的历史无法查证」。', 'Tick “I understand this demand’s history cannot be verified” first.')
  if (stockPrepRefreshHoldConfirmMode(hold) === 'reconfirm' && !(hold.continuationId && detailById[hold.continuationId])) {
    return bi('先点「查看沿用关系」。', 'Press “Show the relationship” first.')
  }
  if (!typedMatches(hold)) return bi('输入本项目的项目号后才能确认。', 'Type this project’s number to confirm.')
  return ''
}

function endBodyFor(hold: StockPrepRefreshHold): StockPrepRefreshEndBody | null {
  const outcome = endOutcome[hold.id]
  if (outcome !== 'release_to_normal_refresh' && outcome !== 'escalate_special_repair') return null
  if (outcome === 'release_to_normal_refresh' && !releaseAdmissibleOnPage(hold)) return null
  if (!typedMatches(hold)) return null
  const detail = hold.continuationId ? detailById[hold.continuationId] : undefined
  return buildEndBody(hold, detail ? detail.continuation : null, outcome, { confirmProjectNo: typedConfirmNo(hold) })
}

function endWhy(hold: StockPrepRefreshHold): string {
  const outcome = endOutcome[hold.id]
  if (outcome !== 'release_to_normal_refresh' && outcome !== 'escalate_special_repair') return bi('先选一种结束方式。', 'Choose how to end it first.')
  if (!(hold.continuationId && detailById[hold.continuationId])) return bi('先点「查看沿用关系」。', 'Press “Show the relationship” first.')
  if (!typedMatches(hold)) return bi('输入本项目的项目号后才能结束。', 'Type this project’s number to end it.')
  return ''
}

async function keep(hold: StockPrepRefreshHold): Promise<void> {
  const projectNo = openedProjectNo.value
  if (!projectNo || busy.value) return
  // R-62 ⑧: 「暂不处理」 changes nothing, so the opened project fills `confirmProjectNo` itself.
  const ok = await guarded(async () => {
    await api.value.keep(projectNo, hold.id, { confirmProjectNo: projectNo, holdFingerprint: hold.fingerprint })
  })
  if (ok) {
    notice.value = {
      zh: '已记下:这一项暂不处理。它仍然挂起整次拉取,什么都没有改动。',
      en: 'Noted: this item is kept for now. It still suspends the whole pull; nothing was changed.',
    }
  }
}

async function confirm(hold: StockPrepRefreshHold): Promise<void> {
  const projectNo = openedProjectNo.value
  const body = confirmBodyFor(hold)
  if (!projectNo || !body || busy.value) return
  let result: { nextStep?: string } | null = null
  const ok = await guarded(async () => {
    result = await api.value.confirm(projectNo, body)
  })
  if (ok) await afterDecision('confirmed', result)
}

async function end(hold: StockPrepRefreshHold): Promise<void> {
  const projectNo = openedProjectNo.value
  const body = endBodyFor(hold)
  if (!projectNo || !body || !hold.continuationId || busy.value) return
  const continuationId = hold.continuationId
  let result: { nextStep?: string } | null = null
  const ok = await guarded(async () => {
    result = await api.value.end(projectNo, continuationId, body)
  })
  if (ok) await afterDecision('ended', result)
}

/** E-4: every decision answers `nextStep: 'preview_again'` — re-read the holds and say a preview must follow. */
async function afterDecision(kind: 'confirmed' | 'ended', _result: { nextStep?: string } | null): Promise<void> {
  previewAgain.value = kind
  await reload({ keepNotice: true })
}

function goPreview(): void {
  emit('navigate-stage', 'project-board', openedProjectNo.value)
}

function copyError(): void {
  void copyTextToClipboard(stockPrepErrorCopyText(errorCode.value, locale.value === 'zh-CN'))
}

// ── rendering helpers (values from the PULL-tier payload, displayed only) ───────────────────────────

// PR-7b (review N2 / N8): server tokens → words (plainLanguage.ts). `null` = not in the map; the template then
// says 「未识别…」 and shows the token in its own <code>, outside the sentence.
function words(entry: StockPrepPlainText | null): string | null {
  return entry ? bi(entry.zh, entry.en) : null
}

function wordsOr(text: string | null, fallback: string): string {
  return text ?? fallback
}

function holdKindWords(kind: string): string | null {
  return words(stockPrepRefreshTokenPlain(STOCK_PREP_REFRESH_HOLD_KIND_PLAIN, kind))
}

function shapeWords(token: string | null): string | null {
  return words(stockPrepRefreshTokenPlain(STOCK_PREP_REFRESH_SHAPE_PLAIN, token))
}

function reasonWords(token: string | null): string | null {
  return words(stockPrepRefreshTokenPlain(STOCK_PREP_REFRESH_NOT_CONFIRMABLE_PLAIN, token))
}

function notConfirmableText(hold: StockPrepRefreshHold): string {
  const head = bi('这一项现在不能确认', 'This item cannot be confirmed right now')
  if (!hold.notConfirmableReason) return `${head}${bi('(没有记录原因)。', ' (no reason was recorded).')}`
  const why = reasonWords(hold.notConfirmableReason)
  return why ? `${head}:${why}。` : `${head}:${bi('原因未识别', 'the reason is not recognised')}`
}

/** Values-free status words for a sentence: the token's words, or 「未识别」 followed by nothing of the token. */
function statusWords(map: Record<string, StockPrepPlainText>, token: unknown): string {
  return words(stockPrepRefreshTokenPlain(map, typeof token === 'string' ? token : null)) ?? bi(STOCK_PREP_REFRESH_TOKEN_UNKNOWN.zh, STOCK_PREP_REFRESH_TOKEN_UNKNOWN.en)
}

function pagesText(hold: StockPrepRefreshHold): string {
  const progress = receiptProgressFor(receipt.value, hold.id)
  if (!progress) {
    const count = hold.pairPage?.count ?? 1
    return bi(`对照共 ${count} 页`, `${count} comparison page(s)`)
  }
  return bi(`已看 ${progress.served} / ${progress.count} 页`, `Read ${progress.served} / ${progress.count} page(s)`)
}

function comparisonOf(hold: StockPrepRefreshHold) {
  return hold.candidates[0]?.comparison ?? hold.verification?.comparison ?? null
}

interface ComparisonRow { path: string; field: string; before: string; after: string; status: string; statusText: string }

function comparisonRows(hold: StockPrepRefreshHold): ComparisonRow[] {
  const items = comparisonOf(hold)?.items
  if (!Array.isArray(items)) return []
  const rows: ComparisonRow[] = []
  for (const item of items) {
    const path = Array.isArray(item?.relativePath) && item.relativePath.length > 0 ? stockPrepRefreshCellText(item.relativePath) : bi('根', 'root')
    for (const [field, entry] of Object.entries(item?.fields ?? {})) {
      const status = typeof entry?.status === 'string' ? entry.status : ''
      rows.push({
        path,
        field,
        before: stockPrepRefreshCellText(entry?.old),
        after: stockPrepRefreshCellText(entry?.new),
        status,
        // PR-7b (review N8): the column reads words; the token rides on the cell's data attribute only.
        statusText: status ? statusWords(STOCK_PREP_REFRESH_COMPARISON_STATUS_PLAIN, status) : '—',
      })
    }
  }
  return rows
}

function contentRows(hold: StockPrepRefreshHold): Array<{ field: string; change: string }> {
  const rows: Array<{ field: string; change: string }> = []
  for (const change of hold.contentChanges ?? []) {
    for (const [field, value] of Object.entries(change?.fields ?? {})) {
      const pair = value && typeof value === 'object' ? value as { before?: unknown; after?: unknown } : null
      rows.push({ field, change: pair && ('before' in pair || 'after' in pair) ? `${stockPrepRefreshCellText(pair.before)} → ${stockPrepRefreshCellText(pair.after)}` : stockPrepRefreshCellText(value) })
    }
  }
  return rows
}

function evidenceText(holdId: string): string {
  const evidence = evidenceById[holdId] as { current?: { observations?: unknown[]; completeness?: { status?: unknown } }; history?: { status?: unknown } } | undefined
  if (!evidence) return ''
  const observations = Array.isArray(evidence.current?.observations) ? evidence.current?.observations ?? [] : []
  const history = typeof evidence.history?.status === 'string' ? evidence.history.status : 'history_unknown'
  const lines = observations.map((entry) => stockPrepRefreshCellText(entry))
  // PR-7b (review N8): the history status in words, never the raw token inside the sentence.
  return `${bi('需求依据', 'Demand evidence')}: ${lines.length > 0 ? lines.join(';') : '—'} · ${bi('历史', 'History')}: ${statusWords(STOCK_PREP_REFRESH_HISTORY_PLAIN, history)}`
}

function detailText(continuationId: string): string {
  const detail = detailById[continuationId]
  if (!detail) return ''
  const header = detail.continuation
  // PR-7b (review N8): the relationship status in words.
  return `${bi('沿用关系', 'Relationship')}: ${statusWords(STOCK_PREP_REFRESH_CONTINUATION_STATUS_PLAIN, header.status)} · ${bi('版本', 'revision')} ${header.revision} · ${bi('成员', 'members')} ${Array.isArray(detail.members) ? detail.members.length : 0}`
}

// A different project: drop every value of the previous one BEFORE reading the new one.
watch(openedProjectNo, () => {
  generation += 1
  clearValues()
  errorCode.value = null
  notice.value = null
  previewAgain.value = null
  void reload()
}, { immediate: true })

onBeforeUnmount(() => {
  generation += 1
  clearValues()
})
</script>

<style scoped>
.sp-refresh {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-3);
}

.sp-refresh__head,
.sp-refresh__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--ms-space-2);
}

.sp-refresh__project {
  font-weight: 600;
  color: var(--ms-text-1);
}

.sp-refresh__state,
.sp-refresh__note,
.sp-refresh__notice,
.sp-refresh__pages,
.sp-refresh__evidence {
  margin: 0;
  color: var(--ms-text-2);
  font-size: 13px;
  line-height: 1.7;
}

.sp-refresh__error,
.sp-refresh__warning {
  margin: 0;
  color: var(--ms-color-danger);
  font-size: 13px;
  line-height: 1.7;
}

.sp-refresh__hint {
  display: block;
  color: var(--ms-text-3);
  font-size: 12px;
}

.sp-refresh__token {
  font-family: var(--ms-font-mono, monospace);
  font-size: 12px;
  margin: 0 var(--ms-space-1);
}

.sp-refresh__holds {
  margin: 0;
  padding-left: var(--ms-space-4);
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-4);
}

.sp-refresh__hold-title {
  margin: 0 0 var(--ms-space-2);
  font-size: 14px;
  color: var(--ms-text-1);
}

.sp-refresh__table {
  border-collapse: collapse;
  font-size: 12px;
}

.sp-refresh__table th,
.sp-refresh__table td {
  border: 1px solid var(--ms-border-1, currentColor);
  padding: 2px var(--ms-space-2);
  text-align: left;
}

.sp-refresh__button {
  padding: 4px 12px;
  font-size: 13px;
  cursor: pointer;
}

.sp-refresh__button--primary {
  font-weight: 600;
}

.sp-refresh__link {
  border: none;
  background: none;
  padding: 0;
  color: var(--ms-color-primary);
  cursor: pointer;
  font-size: 13px;
}

.sp-refresh__end {
  margin: var(--ms-space-2) 0 0;
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-1);
}

.sp-refresh__typed,
.sp-refresh__ack {
  display: flex;
  align-items: center;
  gap: var(--ms-space-2);
  font-size: 13px;
}
</style>
