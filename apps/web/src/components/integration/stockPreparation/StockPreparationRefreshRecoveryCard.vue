<template>
  <section
    class="sp-recovery"
    data-testid="stock-prep-refresh-recovery"
    :data-recovery-state="state"
  >
    <!-- 备料分批拉取第一期 step 6a-3 (S6-3; step-6 design §5.4 as amended by the 2026-11-09 rebaseline; register R-91) —
         「拉取待确认」's RECOVERY CARD. Rendered by the page ONLY while its refresh summary says 失败待恢复
         (failed_pending_recovery), so the audited executions list is never read for any other project (dormancy, RC-W1).
         Every control below carries its manifest control id (workbenchAccess.ts `refresh.executions` / `refresh.recover`
         / `refresh.closeUnverified`); each is PRESENT whenever the card offers it and DISABLED — never absent — while a
         precondition is missing (presence = grant, RC-ALIGN). The runbook escape is rendered for the ADMIN tier only.
         批次标识 (N-SWITCH): a batch line renders only where the server SENT a batch key — absent while the switch is off. -->
    <div class="sp-recovery__head">
      <h3 class="sp-recovery__title">{{ bi('上次写入未完成', 'Last write unfinished') }}</h3>
      <button
        type="button"
        class="sp-recovery__button"
        data-testid="stock-prep-refresh-executions"
        :disabled="busy"
        @click="readList()"
      >{{ busy ? bi('正在处理…', 'Working…') : bi('重新读取执行记录', 'Read the executions again') }}</button>
    </div>
    <!-- The lead names 「核对上次写入」, so it renders only where that button can exist (loading / ready) — never over
         the 'none' or 'unreadable' line, which name their own way out. -->
    <p v-if="state === 'loading' || state === 'ready'" class="sp-recovery__note" data-testid="stock-prep-refresh-recovery-intro">{{ bi(intro.zh, intro.en) }}</p>

    <p v-if="errorCode" class="sp-recovery__error" data-testid="stock-prep-refresh-recovery-error" role="alert">
      {{ bi(errorText.zh, errorText.en) }}
      <code class="sp-recovery__token">{{ errorCode }}</code>
      <span v-if="errorText.zhNext" class="sp-recovery__hint">{{ bi(errorText.zhNext, errorText.enNext ?? '') }}</span>
      <button type="button" class="sp-recovery__link" data-testid="stock-prep-refresh-recovery-error-copy" @click="copyError">
        {{ bi('复制这条报错', 'Copy this error') }}
      </button>
    </p>

    <p v-if="state === 'loading'" class="sp-recovery__state" data-testid="stock-prep-refresh-recovery-loading">
      {{ bi('正在读取执行记录…', 'Reading the executions…') }}
    </p>
    <p v-else-if="state === 'unreadable'" class="sp-recovery__state" data-testid="stock-prep-refresh-recovery-unreadable">
      {{ bi('执行记录读不出来,现在不能在这里核对。', 'The executions could not be read, so nothing can be checked here right now.') }}
      <span class="sp-recovery__hint">{{ bi('稍后点「重新读取执行记录」;一直这样请联系平台管理员。', 'Press “Read the executions again” shortly; if it persists, ask the platform admin.') }}</span>
    </p>
    <p v-else-if="state === 'none'" class="sp-recovery__state" data-testid="stock-prep-refresh-recovery-none">
      {{ bi(noneCopy.zh, noneCopy.en) }}
      <span class="sp-recovery__hint">{{ bi(noneCopy.zhNext ?? '', noneCopy.enNext ?? '') }}</span>
    </p>

    <ol v-if="state === 'ready'" class="sp-recovery__executions">
      <li
        v-for="execution in unfinished"
        :key="execution.id"
        class="sp-recovery__execution"
        data-testid="stock-prep-refresh-recovery-execution"
        :data-execution-status="execution.status"
        :data-recoverable="execution.recoverable ? 'true' : 'false'"
      >
        <p class="sp-recovery__facts" data-testid="stock-prep-refresh-recovery-execution-facts">
          {{ bi('状态', 'Status') }}:{{ statusText(execution.status) }}<code v-if="!statusKnown(execution.status)" class="sp-recovery__token" data-testid="stock-prep-refresh-recovery-unknown-token">{{ execution.status }}</code>
          · {{ bi('开始于', 'Started') }} {{ timeText(execution.startedAt) }}
          · {{ bi('已写入', 'Written') }} {{ countText(execution.written) }} / {{ bi('尝试写入', 'attempted') }} {{ countText(execution.attemptedWrites) }}
          · {{ execution.binding.changePlanBound ? bi('带变更计划', 'with a change plan') : bi('没有变更计划', 'no change plan') }}
        </p>
        <p
          v-if="listBatch(execution).shown"
          class="sp-recovery__facts"
          data-testid="stock-prep-refresh-recovery-execution-batch"
        >{{ listBatchText(execution) }}</p>
        <p v-if="!execution.recoverable" class="sp-recovery__hint" data-testid="stock-prep-refresh-recovery-running">
          {{ bi('这次执行还在写入中(仍占着写入),现在不能核对;请稍后点「重新读取执行记录」。', 'This execution is still writing (it still holds the write turn), so it cannot be checked now; press “Read the executions again” shortly.') }}
        </p>

        <!-- ONE typed project number per execution gates all four actions: every one of them takes the recovery lease,
             and the server types the project in every mode (http-routes.cjs, `confirmTyped: true`). -->
        <label class="sp-recovery__typed">
          {{ bi('输入项目号以确认操作', 'Type the project number to confirm') }}
          <input
            v-model="typedNo[execution.id]"
            type="text"
            data-testid="stock-prep-refresh-recovery-typed-project-no"
            autocomplete="off"
          />
        </label>

        <div class="sp-recovery__actions">
          <button
            type="button"
            class="sp-recovery__button"
            data-testid="stock-prep-refresh-recover"
            :disabled="busy || !verifyBodyFor(execution)"
            @click="verify(execution)"
          >{{ bi('核对上次写入', 'Check the last write') }}</button>
          <button
            type="button"
            class="sp-recovery__button sp-recovery__button--primary"
            data-testid="stock-prep-refresh-recovery-close"
            :disabled="busy || !closeBodyFor(execution)"
            @click="close(execution)"
          >{{ bi('结束这次执行', 'Close this execution') }}</button>
        </div>
        <p v-if="!closeBodyFor(execution)" class="sp-recovery__hint" data-testid="stock-prep-refresh-recovery-close-why">{{ closeWhy(execution) }}</p>

        <!-- The verify report (values-free) and ONE page of the private pending list. -->
        <div
          v-if="verifyReports[execution.id]"
          class="sp-recovery__report"
          data-testid="stock-prep-refresh-recovery-report"
          :data-result="verifyReports[execution.id].result"
          :data-close-admissible="verifyReports[execution.id].closeAdmissible ? 'true' : 'false'"
        >
          <p class="sp-recovery__lead" data-testid="stock-prep-refresh-recovery-result">
            {{ bi('核对结果', 'Check result') }}:{{ resultText(verifyReports[execution.id].result) }}<code v-if="!resultKnown(verifyReports[execution.id].result)" class="sp-recovery__token" data-testid="stock-prep-refresh-recovery-unknown-token">{{ verifyReports[execution.id].result }}</code>
          </p>
          <p class="sp-recovery__facts" data-testid="stock-prep-refresh-recovery-counts">{{ countsText(verifyReports[execution.id]) }}</p>
          <ul v-if="verifyReports[execution.id].refusalReasons.length > 0" class="sp-recovery__reasons" data-testid="stock-prep-refresh-recovery-reasons">
            <li
              v-for="reason in verifyReports[execution.id].refusalReasons"
              :key="reason"
              data-testid="stock-prep-refresh-recovery-reason"
              :data-reason="reason"
            >{{ reasonText(reason) }}<code v-if="!reasonKnown(reason)" class="sp-recovery__token" data-testid="stock-prep-refresh-recovery-unknown-token">{{ reason }}</code></li>
          </ul>
          <p v-if="verifyReports[execution.id].closeAdmissible !== true" class="sp-recovery__warning" data-testid="stock-prep-refresh-recovery-unprovable">
            {{ bi(unprovableHint.zh, unprovableHint.en) }}
          </p>
          <p v-if="verifyReports[execution.id].remaining" class="sp-recovery__facts" data-testid="stock-prep-refresh-recovery-remaining">{{ remainingText(verifyReports[execution.id]) }}</p>
          <p v-if="verifyReports[execution.id].changePlan" class="sp-recovery__facts" data-testid="stock-prep-refresh-recovery-change-plan">{{ changePlanText(verifyReports[execution.id]) }}</p>
          <p v-if="reportBatch(verifyReports[execution.id]).shown" class="sp-recovery__facts" data-testid="stock-prep-refresh-recovery-report-batch">{{ reportBatchText(verifyReports[execution.id]) }}</p>
          <p v-if="verifyReports[execution.id].closeAdmissible === true" class="sp-recovery__facts" data-testid="stock-prep-refresh-recovery-settles" :data-settles="verifyReports[execution.id].settlesIfClosedNow ? 'true' : 'false'">
            {{ verifyReports[execution.id].settlesIfClosedNow
              ? bi('结束后,本项目的这次写入就算核对过了;之后仍要重新试算。', 'After the close, this write counts as checked; preview again afterwards.')
              : bi('结束后,还要重新试算(并在写入后核对)才能正式导出。', 'After the close, preview again (and check after the write) before the formal export.') }}
          </p>

          <template v-if="pendingPages[execution.id]">
            <p class="sp-recovery__pages" data-testid="stock-prep-refresh-recovery-pending-pages">
              {{ pendingPagesText(execution.id, verifyReports[execution.id]) }}
              <button
                v-if="pendingPages[execution.id].nextCursor !== null"
                type="button"
                class="sp-recovery__link"
                data-testid="stock-prep-refresh-recovery-pending-next"
                :disabled="busy || !verifyBodyFor(execution)"
                @click="verify(execution, pendingPages[execution.id].nextCursor)"
              >{{ bi('下一页', 'Next page') }}</button>
            </p>
            <table v-if="pendingPages[execution.id].entries.length > 0" class="sp-recovery__table" data-testid="stock-prep-refresh-recovery-pending">
              <thead>
                <tr>
                  <th>{{ bi('序号', 'No.') }}</th>
                  <th>{{ bi('计划', 'Planned') }}</th>
                  <th>{{ bi('核对', 'Check') }}</th>
                  <th>{{ bi('部件编码', 'Part code') }}</th>
                  <th>{{ bi('部件名称', 'Part name') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="entry in pendingPages[execution.id].entries"
                  :key="entry.decisionIndex"
                  data-testid="stock-prep-refresh-recovery-pending-entry"
                  :data-entry-class="entry.class"
                >
                  <td>{{ entry.decisionIndex + 1 }}</td>
                  <td>{{ kindText(entry.kind) }}</td>
                  <td>{{ classText(entry.class) }}</td>
                  <td>{{ cellText(entry.componentCode) }}</td>
                  <td>{{ cellText(entry.componentName) }}<span v-if="entry.sourceGone" class="sp-recovery__hint" data-testid="stock-prep-refresh-recovery-source-gone">{{ bi('源中已无', 'no longer in the source') }}</span></td>
                </tr>
              </tbody>
            </table>
          </template>
        </div>

        <!-- The runbook escape (design §3.8): ADMIN tier only — absent for everyone else (presence = grant). -->
        <fieldset v-if="canCloseUnverified" class="sp-recovery__runbook" data-testid="stock-prep-refresh-close-unverified-fieldset">
          <legend>{{ bi('按手册结束(结果未知)', 'Close per the runbook (result unknown)') }}</legend>
          <p class="sp-recovery__warning" data-testid="stock-prep-refresh-close-unverified-warning">{{ bi(unverifiedWarning.zh, unverifiedWarning.en) }}</p>
          <div class="sp-recovery__actions">
            <button
              type="button"
              class="sp-recovery__button"
              data-testid="stock-prep-refresh-close-unverified-inspect"
              :disabled="busy || !inspectBodyFor(execution)"
              @click="inspect(execution)"
            >{{ bi('检查表格', 'Inspect the sheet') }}</button>
          </div>
          <div v-if="inspectReports[execution.id]" class="sp-recovery__report" data-testid="stock-prep-refresh-close-unverified-report" :data-result="inspectReports[execution.id].result">
            <p class="sp-recovery__facts">{{ bi('表格现在', 'The sheet now') }}:{{ countsText(inspectReports[execution.id]) }}</p>
            <ul v-if="inspectReports[execution.id].refusalReasons.length > 0" class="sp-recovery__reasons">
              <li
                v-for="reason in inspectReports[execution.id].refusalReasons"
                :key="reason"
                data-testid="stock-prep-refresh-close-unverified-reason"
                :data-reason="reason"
              >{{ reasonText(reason) }}<code v-if="!reasonKnown(reason)" class="sp-recovery__token" data-testid="stock-prep-refresh-recovery-unknown-token">{{ reason }}</code></li>
            </ul>
            <p v-if="reportBatch(inspectReports[execution.id]).shown" class="sp-recovery__facts" data-testid="stock-prep-refresh-close-unverified-batch">{{ reportBatchText(inspectReports[execution.id]) }}</p>
          </div>
          <label class="sp-recovery__typed">
            {{ bi('手册工单号(字母、数字、. _ : -,最多 64 个)', 'Runbook ticket (letters, digits, . _ : -, up to 64)') }}
            <input
              v-model="runbookRef[execution.id]"
              type="text"
              data-testid="stock-prep-refresh-close-unverified-runbook-ref"
              autocomplete="off"
            />
          </label>
          <label class="sp-recovery__ack" data-testid="stock-prep-refresh-close-unverified-ack">
            <input v-model="unverifiedAck[execution.id]" type="checkbox" />
            {{ bi('我知道这次结束不核对结果,结果记为「未知」', 'I understand this close does not check the result, which is recorded as “unknown”') }}
          </label>
          <button
            type="button"
            class="sp-recovery__button"
            data-testid="stock-prep-refresh-close-unverified"
            :disabled="busy || !unverifiedBodyFor(execution)"
            @click="closeUnverified(execution)"
          >{{ bi('按手册结束(结果未知)', 'Close per the runbook (result unknown)') }}</button>
          <p v-if="!unverifiedBodyFor(execution)" class="sp-recovery__hint" data-testid="stock-prep-refresh-close-unverified-why">{{ unverifiedWhy(execution) }}</p>
        </fieldset>
      </li>
    </ol>
    <button
      v-if="(state === 'ready' || state === 'none') && nextCursor"
      type="button"
      class="sp-recovery__link"
      data-testid="stock-prep-refresh-recovery-more"
      :disabled="busy"
      @click="readList({ append: true })"
    >{{ bi('更多执行记录', 'More executions') }}</button>
  </section>
</template>

<script setup lang="ts">
// The recovery card (S6-3). VALUES: the pending page (component code / name) lives in this component's refs ONLY —
// cleared when the project changes and on unmount; never written to localStorage / sessionStorage, never put in an emit
// payload, the error banner or a clipboard string (only codes are copyable). Every other payload here is values-free.
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { useLocale } from '../../../composables/useLocale'
import { useAuth } from '../../../composables/useAuth'
import { StockPreparationConfirmApiError } from '../../../services/integration/stockPreparation/confirmApi'
import {
  STOCK_PREP_EXECUTION_STATUS_PLAIN,
  STOCK_PREP_RECOVERY_CARD_INTRO,
  STOCK_PREP_RECOVERY_CARD_NONE,
  STOCK_PREP_RECOVERY_CLASS_PLAIN,
  STOCK_PREP_RECOVERY_KIND_PLAIN,
  STOCK_PREP_RECOVERY_REASON_PLAIN,
  STOCK_PREP_RECOVERY_RESULT_PLAIN,
  STOCK_PREP_RECOVERY_UNPROVABLE_HINT,
  STOCK_PREP_RECOVERY_UNVERIFIED_WARNING,
  STOCK_PREP_REFRESH_TOKEN_UNKNOWN,
  stockPrepErrorCopyText,
  stockPrepRecoveryErrorPlain,
  stockPrepRefreshTokenPlain,
  type StockPrepPlainEntry,
  type StockPrepPlainText,
} from '../../../services/integration/stockPreparation/plainLanguage'
import {
  STOCK_PREP_RECOVERY_RELIST_CODES,
  STOCK_PREP_RECOVERY_REVERIFY_CODES,
  buildCloseUnverifiedCloseBody,
  buildCloseUnverifiedInspectBody,
  buildRecoverCloseBody,
  buildRecoverVerifyBody,
  stockPrepExecutionUnfinished,
  stockPrepRecoveryBatchOf,
  stockPrepRecoveryCloseGap,
  stockPrepRecoveryCount,
  STOCK_PREP_RECOVERY_RUNBOOK_REF_PATTERN,
  type StockPrepRecoveryBatchLink,
  type StockPrepRecoveryCloseAnswer,
  type StockPrepRecoveryPendingPage,
  type StockPrepRecoveryReport,
  type StockPrepRefreshExecution,
} from '../../../services/integration/stockPreparation/refreshRecovery'
import type { StockPrepRefreshQueueApi } from '../../../services/integration/stockPreparation/refreshQueue'
import { stockPrepRefreshCellText } from '../../../services/integration/stockPreparation/refreshQueue'
import { stockPrepProjectNumbersMatch } from '../../../services/integration/stockPreparation/projectTarget'
import { grantedStockPrepCapabilities } from '../../../services/integration/stockPreparation/workbenchAccess'
import { copyTextToClipboard } from '../../../views/plm/plmClipboard'

const props = withDefaults(
  defineProps<{
    /** The page's opened project. */
    projectNo: string
    /** The page's ONE api seam (refreshQueue.ts). */
    api: StockPrepRefreshQueueApi
    /** Bumped by the page on every re-read: the card reads its executions again. */
    generation?: number
  }>(),
  { generation: 0 },
)

const emit = defineEmits<{
  /** A close landed. Values-free: the result token and whether the post-release bump landed (T6-8). */
  (e: 'closed', outcome: { result: string; generationBumped: boolean }): void
  /** The execution is gone / already finished: the page reads its summary again. */
  (e: 'reread'): void
}>()

const { locale } = useLocale()
function bi(zh: string, en: string): string {
  return locale.value === 'zh-CN' ? zh : en
}

const auth = useAuth()
/** The runbook escape is the ADMIN tier's (workbenchAccess.ts `refresh.closeUnverified`; presence = grant). */
const canCloseUnverified = computed<boolean>(() => grantedStockPrepCapabilities(auth.getAccessSnapshot()).includes('refresh.closeUnverified'))

const intro = STOCK_PREP_RECOVERY_CARD_INTRO
/** Nothing unfinished on the pages read while the page says 失败待恢复 (an abandoned lease alone): the way out, named. */
const noneCopy = STOCK_PREP_RECOVERY_CARD_NONE
const unprovableHint = STOCK_PREP_RECOVERY_UNPROVABLE_HINT
const unverifiedWarning = STOCK_PREP_RECOVERY_UNVERIFIED_WARNING

type CardState = 'loading' | 'unreadable' | 'none' | 'ready'

const busy = ref(false)
const listed = ref<StockPrepRefreshExecution[] | null>(null)
const listFailed = ref(false)
const nextCursor = ref<string | null>(null)
const errorCode = ref<string | null>(null)
const errorReason = ref<string | null>(null)
const typedNo = reactive<Record<string, string>>({})
const runbookRef = reactive<Record<string, string>>({})
const unverifiedAck = reactive<Record<string, boolean>>({})
const verifyReports = reactive<Record<string, StockPrepRecoveryReport>>({})
const inspectReports = reactive<Record<string, StockPrepRecoveryReport>>({})
/** PRIVATE values (component code / name): refs only. */
const pendingPages = reactive<Record<string, StockPrepRecoveryPendingPage>>({})
let ticket = 0

const unfinished = computed<StockPrepRefreshExecution[]>(() => (listed.value ?? []).filter((execution) => stockPrepExecutionUnfinished(execution)))

const state = computed<CardState>(() => {
  if (listFailed.value) return 'unreadable'
  if (listed.value === null) return 'loading'
  return unfinished.value.length > 0 ? 'ready' : 'none'
})

const errorText = computed<StockPrepPlainEntry>(() => stockPrepRecoveryErrorPlain(errorCode.value ?? '', errorReason.value))

function clearValues(): void {
  listed.value = null
  listFailed.value = false
  nextCursor.value = null
  for (const store of [typedNo, runbookRef, unverifiedAck, verifyReports, inspectReports, pendingPages] as Array<Record<string, unknown>>) {
    for (const key of Object.keys(store)) delete store[key]
  }
}

function recordError(error: unknown): void {
  if (error instanceof StockPreparationConfirmApiError) {
    errorCode.value = error.code
    errorReason.value = error.reason
  } else {
    errorCode.value = 'STOCK_PREPARATION_CONFIRM_REQUEST_FAILED'
    errorReason.value = null
  }
}

/** A refusal that voids the shown report(s) of this execution: a new verify / inspect is required, never a resend. */
function dropReports(executionId: string): void {
  delete verifyReports[executionId]
  delete inspectReports[executionId]
  delete pendingPages[executionId]
}

function isListShape(value: unknown): value is { items: StockPrepRefreshExecution[]; nextCursor: string | null } {
  return Boolean(value && typeof value === 'object' && Array.isArray((value as { items?: unknown }).items))
}

async function readList(options: { append?: boolean; keepError?: boolean } = {}): Promise<void> {
  const projectNo = props.projectNo
  if (!projectNo) return
  const mine = ++ticket
  busy.value = true
  if (!options.keepError) errorCode.value = null
  try {
    const answer = await props.api.listExecutions(projectNo, { cursor: options.append ? nextCursor.value : null })
    if (mine !== ticket) return
    if (!isListShape(answer)) {
      // FAIL CLOSED: an answer that is not the list shape is never "nothing unfinished".
      listFailed.value = true
      return
    }
    listFailed.value = false
    if (options.append && listed.value) {
      const known = new Set(listed.value.map((execution) => execution.id))
      listed.value = [...listed.value, ...answer.items.filter((execution) => !known.has(execution.id))]
    } else {
      listed.value = answer.items
    }
    nextCursor.value = typeof answer.nextCursor === 'string' && answer.nextCursor.length > 0 ? answer.nextCursor : null
  } catch (error) {
    if (mine !== ticket) return
    if (!options.append) listFailed.value = true
    recordError(error)
  } finally {
    if (mine === ticket) busy.value = false
  }
}

/** One request at a time; the refusal's reading decides what is kept. */
async function guarded(executionId: string, work: () => Promise<void>): Promise<boolean> {
  busy.value = true
  errorCode.value = null
  try {
    await work()
    return true
  } catch (error) {
    recordError(error)
    const code = errorCode.value ?? ''
    if (STOCK_PREP_RECOVERY_REVERIFY_CODES.includes(code)) dropReports(executionId)
    // The execution is gone or already finished: the PAGE reads its summary again (and bumps `generation`, so this
    // card re-reads its list keeping the refusal on screen) — or unmounts the card when the project left 失败待恢复.
    if (STOCK_PREP_RECOVERY_RELIST_CODES.includes(code)) {
      dropReports(executionId)
      emit('reread')
    }
    return false
  } finally {
    busy.value = false
  }
}

function typedMatches(execution: StockPrepRefreshExecution): boolean {
  return stockPrepProjectNumbersMatch(props.projectNo, typedNo[execution.id] ?? '')
}

/** The TYPED number, trimmed — sent as `confirmProjectNo` so the server's own typed check is a real second check. */
function typedConfirmNo(execution: StockPrepRefreshExecution): string {
  return (typedNo[execution.id] ?? '').trim()
}

function verifyBodyFor(execution: StockPrepRefreshExecution, pageCursor: number | null = null) {
  if (!execution.recoverable || !typedMatches(execution)) return null
  return buildRecoverVerifyBody({ confirmProjectNo: typedConfirmNo(execution), pageCursor })
}

function closeBodyFor(execution: StockPrepRefreshExecution) {
  if (!execution.recoverable || !typedMatches(execution)) return null
  return buildRecoverCloseBody({ confirmProjectNo: typedConfirmNo(execution), executionId: execution.id, report: verifyReports[execution.id] })
}

function inspectBodyFor(execution: StockPrepRefreshExecution) {
  if (!execution.recoverable || !typedMatches(execution)) return null
  return buildCloseUnverifiedInspectBody({ confirmProjectNo: typedConfirmNo(execution) })
}

function unverifiedBodyFor(execution: StockPrepRefreshExecution) {
  if (!execution.recoverable || !typedMatches(execution)) return null
  return buildCloseUnverifiedCloseBody({
    confirmProjectNo: typedConfirmNo(execution),
    executionId: execution.id,
    report: inspectReports[execution.id],
    runbookRef: runbookRef[execution.id] ?? '',
    acknowledged: unverifiedAck[execution.id] === true,
  })
}

function closeWhy(execution: StockPrepRefreshExecution): string {
  if (!execution.recoverable) return bi('这次执行还在写入中,不能结束。', 'This execution is still writing, so it cannot be closed.')
  const gap = stockPrepRecoveryCloseGap({ report: verifyReports[execution.id], typedMatches: typedMatches(execution) })
  if (gap === 'no_report') {
    return typedMatches(execution)
      ? bi('先点「核对上次写入」;核对能证明时才能结束。', 'Press “Check the last write” first; it can be closed only when the check proves it.')
      : bi('输入本项目的项目号,再点「核对上次写入」。', 'Type this project’s number, then press “Check the last write”.')
  }
  if (gap === 'unprovable') return bi('核对证明不了写进了哪些行,不能在这里结束(原因见上)。', 'The check cannot prove which rows landed, so it cannot be closed here (see the reasons above).')
  if (gap === 'typed') return bi('输入本项目的项目号后才能结束。', 'Type this project’s number to close it.')
  return ''
}

function unverifiedWhy(execution: StockPrepRefreshExecution): string {
  if (!execution.recoverable) return bi('这次执行还在写入中,不能结束。', 'This execution is still writing, so it cannot be closed.')
  if (!typedMatches(execution)) return bi('输入本项目的项目号后才能检查和结束。', 'Type this project’s number to inspect and close.')
  if (!inspectReports[execution.id]) return bi('先点「检查表格」。', 'Press “Inspect the sheet” first.')
  if (!STOCK_PREP_RECOVERY_RUNBOOK_REF_PATTERN.test((runbookRef[execution.id] ?? '').trim())) return bi('填写手册工单号(只能用字母、数字和 . _ : -)。', 'Fill in the runbook ticket (letters, digits and . _ : - only).')
  if (unverifiedAck[execution.id] !== true) return bi('先勾选「我知道这次结束不核对结果」。', 'Tick “I understand this close does not check the result” first.')
  return ''
}

async function verify(execution: StockPrepRefreshExecution, pageCursor: number | null = null): Promise<void> {
  const body = verifyBodyFor(execution, pageCursor)
  if (!body || busy.value) return
  const projectNo = props.projectNo
  await guarded(execution.id, async () => {
    const answer = await props.api.recoverExecution(projectNo, execution.id, body)
    if (!answer || answer.operation !== 'verify' || !answer.report) throw new StockPreparationConfirmApiError(0, 'STOCK_PREPARATION_CONFIRM_REQUEST_FAILED', null)
    // Every verify is a fresh in-lease recompute: its report (and digest) replaces the shown one, page 2 included.
    verifyReports[execution.id] = answer.report
    pendingPages[execution.id] = answer.pending
  })
}

async function close(execution: StockPrepRefreshExecution): Promise<void> {
  const body = closeBodyFor(execution)
  if (!body || busy.value) return
  const projectNo = props.projectNo
  let closed: StockPrepRecoveryCloseAnswer | null = null
  const ok = await guarded(execution.id, async () => {
    const answer = await props.api.recoverExecution(projectNo, execution.id, body)
    if (!answer || answer.operation === 'verify' || (answer as StockPrepRecoveryCloseAnswer).closed !== true) throw new StockPreparationConfirmApiError(0, 'STOCK_PREPARATION_CONFIRM_REQUEST_FAILED', null)
    closed = answer as StockPrepRecoveryCloseAnswer
  })
  if (ok && closed) afterClose(execution.id, closed)
}

async function inspect(execution: StockPrepRefreshExecution): Promise<void> {
  const body = inspectBodyFor(execution)
  if (!body || busy.value) return
  const projectNo = props.projectNo
  await guarded(execution.id, async () => {
    const answer = await props.api.closeExecutionUnverified(projectNo, execution.id, body)
    if (!answer || answer.operation !== 'inspect' || !('report' in answer) || !answer.report) throw new StockPreparationConfirmApiError(0, 'STOCK_PREPARATION_CONFIRM_REQUEST_FAILED', null)
    inspectReports[execution.id] = answer.report
  })
}

async function closeUnverified(execution: StockPrepRefreshExecution): Promise<void> {
  const body = unverifiedBodyFor(execution)
  if (!body || busy.value) return
  const projectNo = props.projectNo
  let closed: StockPrepRecoveryCloseAnswer | null = null
  const ok = await guarded(execution.id, async () => {
    const answer = await props.api.closeExecutionUnverified(projectNo, execution.id, body)
    if (!answer || answer.operation === 'inspect' || (answer as StockPrepRecoveryCloseAnswer).closed !== true) throw new StockPreparationConfirmApiError(0, 'STOCK_PREPARATION_CONFIRM_REQUEST_FAILED', null)
    closed = answer as StockPrepRecoveryCloseAnswer
  })
  if (ok && closed) afterClose(execution.id, closed)
}

/** The close answer reports what was decided UNDER THE LOCKS; the page re-reads and says 「请重新预览」. */
function afterClose(executionId: string, answer: StockPrepRecoveryCloseAnswer): void {
  dropReports(executionId)
  emit('closed', {
    result: typeof answer.result === 'string' ? answer.result : 'unknown',
    generationBumped: answer.generationBumped === true,
  })
}

function copyError(): void {
  void copyTextToClipboard(stockPrepErrorCopyText(errorCode.value, locale.value === 'zh-CN'))
}

// ── words (values-free tokens and counts; the pending cells are the only values) ───────────────────

function words(map: Record<string, StockPrepPlainText>, token: string | null | undefined): string | null {
  const entry = stockPrepRefreshTokenPlain(map, token)
  return entry ? bi(entry.zh, entry.en) : null
}

const unknownWords = computed<string>(() => bi(STOCK_PREP_REFRESH_TOKEN_UNKNOWN.zh, STOCK_PREP_REFRESH_TOKEN_UNKNOWN.en))

function statusKnown(token: string): boolean {
  return words(STOCK_PREP_EXECUTION_STATUS_PLAIN, token) !== null
}

function statusText(token: string): string {
  return words(STOCK_PREP_EXECUTION_STATUS_PLAIN, token) ?? unknownWords.value
}

function resultKnown(token: string): boolean {
  return words(STOCK_PREP_RECOVERY_RESULT_PLAIN, token) !== null
}

function resultText(token: string): string {
  return words(STOCK_PREP_RECOVERY_RESULT_PLAIN, token) ?? unknownWords.value
}

function reasonKnown(token: string): boolean {
  return words(STOCK_PREP_RECOVERY_REASON_PLAIN, token) !== null
}

function reasonText(token: string): string {
  return words(STOCK_PREP_RECOVERY_REASON_PLAIN, token) ?? unknownWords.value
}

function kindText(token: string): string {
  return words(STOCK_PREP_RECOVERY_KIND_PLAIN, token) ?? unknownWords.value
}

function classText(token: string): string {
  return words(STOCK_PREP_RECOVERY_CLASS_PLAIN, token) ?? unknownWords.value
}

function countText(value: unknown): string {
  return stockPrepRecoveryCount(value)
}

function cellText(value: unknown): string {
  return stockPrepRefreshCellText(value)
}

function timeText(value: string | null): string {
  if (typeof value !== 'string' || value.length === 0) return '—'
  const at = new Date(value)
  return Number.isNaN(at.getTime()) ? '—' : at.toLocaleString(locale.value === 'zh-CN' ? 'zh-CN' : 'en-US')
}

function countsText(report: StockPrepRecoveryReport): string {
  const c = report.counts
  return bi(
    `计划写 ${countText(c.intended)} 行:已写入 ${countText(c.landed)},没写入 ${countText(c.notLanded)},对不上 ${countText(c.diverged)},重复 ${countText(c.duplicate)},已不见 ${countText(c.vanished)},被替换 ${countText(c.replaced)}。`,
    `${countText(c.intended)} row(s) planned: landed ${countText(c.landed)}, not landed ${countText(c.notLanded)}, diverged ${countText(c.diverged)}, duplicate ${countText(c.duplicate)}, vanished ${countText(c.vanished)}, replaced ${countText(c.replaced)}.`,
  )
}

function remainingText(report: StockPrepRecoveryReport): string {
  const r = report.remaining
  if (!r) return ''
  const holds = r.suspended
    ? bi(`;还会挂起 ${countText(r.holdCount)} 项等确认`, `; it will suspend on ${countText(r.holdCount)} item(s) awaiting a decision`)
    : ''
  return bi(
    `按数据源现在的内容,结束后下次试算还要:新增 ${countText(r.add)},更新 ${countText(r.update)},停用 ${countText(r.inactive)},待人工确认 ${countText(r.manualConfirm)}${holds}。`,
    `By the source as it is now, the next preview after the close still has: add ${countText(r.add)}, update ${countText(r.update)}, inactivate ${countText(r.inactive)}, manual confirmation ${countText(r.manualConfirm)}${holds}.`,
  )
}

function changePlanText(report: StockPrepRecoveryReport): string {
  const p = report.changePlan
  if (!p) return ''
  return bi(
    `这次执行带着变更计划:已写入 ${countText(p.landedRecords)} 行,没写入 ${countText(p.notLandedRecords)} 行,说不准 ${countText(p.possiblyLandedRecords)} 行${p.writtenPlanPending ? ';另有一份已写入的计划等复核' : ''}。`,
    `This execution carries a change plan: ${countText(p.landedRecords)} row(s) landed, ${countText(p.notLandedRecords)} not landed, ${countText(p.possiblyLandedRecords)} uncertain${p.writtenPlanPending ? '; another written plan awaits its review' : ''}.`,
  )
}

/** N-SWITCH by KEY PRESENCE on a list item. */
function listBatch(execution: StockPrepRefreshExecution) {
  return stockPrepRecoveryBatchOf<StockPrepRecoveryBatchLink>(execution, 'batch')
}

function listBatchText(execution: StockPrepRefreshExecution): string {
  const batch = listBatch(execution)
  if (!batch.shown) return ''
  const link = batch.value
  if (!link) return bi('拉取批次:这次执行没有关联拉取批次。', 'Pull batch: this execution has no pull batch.')
  return bi(`拉取批次:${cellText(link.label)}(第 ${countText(link.batchNo)} 批)。`, `Pull batch: ${cellText(link.label)} (batch ${countText(link.batchNo)}).`)
}

/** N-SWITCH by KEY PRESENCE on a report. */
function reportBatch(report: StockPrepRecoveryReport) {
  return stockPrepRecoveryBatchOf<NonNullable<StockPrepRecoveryReport['batch']>>(report, 'batch')
}

function reportBatchText(report: StockPrepRecoveryReport): string {
  const batch = reportBatch(report)
  if (!batch.shown) return ''
  const value = batch.value
  if (!value || value.linked !== true) return bi('拉取批次:这次执行没有关联拉取批次。', 'Pull batch: this execution has no pull batch.')
  return bi(
    `拉取批次:第 ${countText(value.batchNo)} 批;表格证明这次执行写进该批次的新行 ${countText(value.verifiedCreatedRows)} 行。`,
    `Pull batch: batch ${countText(value.batchNo)}; the sheet proves ${countText(value.verifiedCreatedRows)} new row(s) this execution wrote into it.`,
  )
}

function pendingPagesText(executionId: string, report: StockPrepRecoveryReport): string {
  const page = pendingPages[executionId]
  const total = report.pending ? report.pending.total : 0
  const count = report.pending ? report.pending.pageCount : 0
  if (!page || total === 0) return bi('没有未证明写入的行。', 'No row is left unproven.')
  return bi(
    `没能证明写入的共 ${countText(total)} 行,这是第 ${countText(page.pageIndex + 1)} / ${countText(count)} 页(每页最多 200 行)。`,
    `${countText(total)} row(s) are not proven landed; this is page ${countText(page.pageIndex + 1)} / ${countText(count)} (up to 200 per page).`,
  )
}

// A different project: drop every value of the previous one BEFORE reading the new one. The page bumps `generation`
// on every re-read of its own summary — the card reads its executions again (its reports are dropped: a new verify).
watch(() => [props.projectNo, props.generation] as const, ([projectNo], previous) => {
  ticket += 1
  if (!previous || previous[0] !== projectNo) {
    clearValues()
    errorCode.value = null
    void readList()
    return
  }
  for (const id of new Set([...Object.keys(verifyReports), ...Object.keys(inspectReports)])) dropReports(id)
  void readList({ keepError: true })
}, { immediate: true })

onBeforeUnmount(() => {
  ticket += 1
  clearValues()
})
</script>

<style scoped>
.sp-recovery {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-2);
  padding: var(--ms-space-3);
  border: 1px solid var(--ms-color-danger, currentColor);
  border-radius: 4px;
}

.sp-recovery__head,
.sp-recovery__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--ms-space-2);
}

.sp-recovery__title {
  margin: 0;
  font-size: 15px;
  color: var(--ms-text-1);
}

.sp-recovery__state,
.sp-recovery__note,
.sp-recovery__facts,
.sp-recovery__pages,
.sp-recovery__lead {
  margin: 0;
  color: var(--ms-text-2);
  font-size: 13px;
  line-height: 1.7;
}

.sp-recovery__lead {
  font-weight: 600;
  color: var(--ms-text-1);
}

.sp-recovery__error,
.sp-recovery__warning {
  margin: 0;
  color: var(--ms-color-danger);
  font-size: 13px;
  line-height: 1.7;
}

.sp-recovery__hint {
  display: block;
  color: var(--ms-text-3);
  font-size: 12px;
}

.sp-recovery__token {
  font-family: var(--ms-font-mono, monospace);
  font-size: 12px;
  margin: 0 var(--ms-space-1);
}

.sp-recovery__executions {
  margin: 0;
  padding-left: var(--ms-space-4);
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-4);
}

.sp-recovery__execution,
.sp-recovery__report {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-1);
}

.sp-recovery__reasons {
  margin: 0;
  padding-left: var(--ms-space-4);
  font-size: 13px;
}

.sp-recovery__table {
  border-collapse: collapse;
  font-size: 12px;
}

.sp-recovery__table th,
.sp-recovery__table td {
  border: 1px solid var(--ms-border-1, currentColor);
  padding: 2px var(--ms-space-2);
  text-align: left;
}

.sp-recovery__button {
  padding: 4px 12px;
  font-size: 13px;
  cursor: pointer;
}

.sp-recovery__button--primary {
  font-weight: 600;
}

.sp-recovery__link {
  border: none;
  background: none;
  padding: 0;
  color: var(--ms-color-primary);
  cursor: pointer;
  font-size: 13px;
}

.sp-recovery__runbook {
  margin: var(--ms-space-2) 0 0;
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-1);
}

.sp-recovery__typed,
.sp-recovery__ack {
  display: flex;
  align-items: center;
  gap: var(--ms-space-2);
  font-size: 13px;
}
</style>
