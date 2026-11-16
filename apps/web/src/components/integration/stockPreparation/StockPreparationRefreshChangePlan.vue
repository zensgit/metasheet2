<template>
  <section
    class="sp-plan"
    data-testid="stock-prep-refresh-change-plan-section"
    :data-change-plan-state="state"
  >
    <!-- 备料分批拉取第一期 step 5 PR-9 (design §10.3, §13, §17 PR-9 row; register R-77) — the 「变更计划」 and
         「变更复核」 sections of 「拉取待确认」 (R-77 ①: sections of this page, not a new rail item). Every control
         below carries its manifest control id (workbenchAccess.ts `refresh.changePlan*` / `refresh.reviewComplete`);
         each is PRESENT whenever the section that offers it renders and DISABLED — never absent — while a precondition
         is missing (presence = grant, CP-ALIGN). FAIL CLOSED: an answer that is not the PR-8 page shape is never
         "nothing to do" — it renders one state line and no confirm / review control. -->
    <div class="sp-plan__head">
      <h3 class="sp-plan__title">{{ bi('变更计划与变更复核', 'Change plan and change review') }}</h3>
      <button
        type="button"
        class="sp-plan__button"
        data-testid="stock-prep-refresh-change-plan"
        :disabled="busy"
        @click="reloadPlan()"
      >{{ busy ? bi('正在读取…', 'Reading…') : bi('重新读取变更计划', 'Read the change plan again') }}</button>
    </div>

    <p v-if="errorCode" class="sp-plan__error" data-testid="stock-prep-refresh-change-plan-error" role="alert">
      {{ bi(errorText.zh, errorText.en) }}
      <code class="sp-plan__token">{{ errorCode }}</code>
      <span v-if="errorText.zhNext" class="sp-plan__hint">{{ bi(errorText.zhNext, errorText.enNext ?? '') }}</span>
      <button type="button" class="sp-plan__link" data-testid="stock-prep-refresh-change-plan-error-copy" @click="copyError">
        {{ bi('复制这条报错', 'Copy this error') }}
      </button>
    </p>

    <p v-if="state === 'loading'" class="sp-plan__state" data-testid="stock-prep-refresh-change-plan-loading">
      {{ bi('正在读取变更计划…', 'Reading the change plan…') }}
    </p>
    <p v-else-if="state !== 'ready'" class="sp-plan__state" data-testid="stock-prep-refresh-change-plan-state">
      {{ bi('变更计划读不出来,现在不能在这里确认或复核。', 'The change plan could not be read, so nothing can be confirmed or reviewed here right now.') }}
      <span class="sp-plan__hint">{{ bi('稍后点「重新读取变更计划」;一直这样请联系平台管理员。', 'Press “Read the change plan again” shortly; if it persists, ask the platform admin.') }}</span>
    </p>

    <template v-if="state === 'ready' && page">
      <p v-if="nothingToShow" class="sp-plan__state" data-testid="stock-prep-refresh-change-plan-empty">
        {{ bi('现在没有待确认的内容变化,也没有等复核的变更。', 'No content change is open and no change awaits review right now.') }}
      </p>

      <!-- a) 「变更计划」: the open content changes as ONE plan (design §10.3 (1)-(5); R-77 ③). -->
      <section v-if="proposal && proposal.holdIds.length > 0" id="stock-prep-change-plan-proposal" class="sp-plan__block" data-testid="stock-prep-refresh-change-plan-proposal">
        <h4 class="sp-plan__subtitle">{{ bi('变更计划', 'Change plan') }}</h4>
        <p class="sp-plan__lead" data-testid="stock-prep-refresh-change-plan-header">
          {{ bi(`这次有 ${proposal.holdIds.length} 项内容变化,合起来是一份变更计划(共 ${proposal.recordCount} 行)。`, `${proposal.holdIds.length} content change(s) form one change plan (${proposal.recordCount} row(s)).`) }}
        </p>
        <p class="sp-plan__note" data-testid="stock-prep-refresh-change-plan-scope">{{ bi(scopeText.zh, scopeText.en) }}</p>
        <p v-if="proposal.blocked !== null" class="sp-plan__warning" data-testid="stock-prep-refresh-change-plan-blocked" :data-blocked-token="proposal.blocked">
          {{ bi('现在不能确认这份变更计划:', 'This change plan cannot be confirmed right now: ') }}{{ wordsOr(blockedWords(proposal.blocked), bi('原因未识别', 'the reason is not recognised')) }}。
        </p>

        <p class="sp-plan__pages" data-testid="stock-prep-refresh-change-plan-receipt">
          {{ bi(`这份计划涉及的 ${proposal.holdIds.length} 项里,已打开看完 ${holdsProgress.done} 项。`, `Of the ${proposal.holdIds.length} item(s) in this plan, ${holdsProgress.done} have been opened in full.`) }}
          <template v-if="hasMoreHolds">
            <span class="sp-plan__hint">{{ bi('还有待确认项在后面的页里,请点上面的「更多待确认项」。', 'More holds are on later pages — press “More holds” above.') }}</span>
            <button
              type="button"
              class="sp-plan__link"
              data-testid="stock-prep-refresh-change-plan-more-holds"
              :disabled="busy"
              @click="emit('read-more-holds')"
            >{{ bi('读下一批待确认项', 'Read the next batch of holds') }}</button>
          </template>
        </p>
        <p v-if="holdsMoved" class="sp-plan__warning" data-testid="stock-prep-refresh-change-plan-xcheck">
          {{ bi('待确认项在您打开页面之后变了,请重新读取。', 'The holds changed after you opened the page; read them again.') }}
        </p>

        <table v-if="proposalRows.length > 0" class="sp-plan__table" data-testid="stock-prep-refresh-change-plan-records">
          <thead>
            <tr>
              <th>{{ bi('记录', 'Record') }}</th>
              <th>{{ bi('位置', 'Position') }}</th>
              <th>{{ bi('字段', 'Field') }}</th>
              <th>{{ bi('原来', 'Before') }}</th>
              <th>{{ bi('改为', 'After') }}</th>
              <th>{{ bi('人工已填', 'Human entries') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, index) in proposalRows" :key="index" data-testid="stock-prep-refresh-change-plan-row">
              <td>{{ row.record }}</td>
              <td>{{ row.position }}</td>
              <td>{{ row.field }}<code v-if="row.fieldId" class="sp-plan__token" data-testid="stock-prep-refresh-field-id">{{ row.fieldId }}</code></td>
              <td>{{ row.before }}</td>
              <td>{{ row.after }}</td>
              <td>{{ row.human }}</td>
            </tr>
          </tbody>
        </table>
        <p v-else class="sp-plan__hint">{{ bi('这一页没有这份计划的行。', 'This page has no rows of this plan.') }}</p>
        <div class="sp-plan__pager">
          <button type="button" class="sp-plan__link" data-testid="stock-prep-refresh-change-plan-prev" :disabled="busy || cursor === 0" @click="goPage(cursor - 1)">{{ bi('上一页', 'Previous page') }}</button>
          <button type="button" class="sp-plan__link" data-testid="stock-prep-refresh-change-plan-next" :disabled="busy || proposal.recordPage.next === null" @click="goNext(proposal.recordPage.next)">{{ bi('下一页', 'Next page') }}</button>
          <span class="sp-plan__hint" data-testid="stock-prep-refresh-change-plan-pages">{{ bi(`已看计划 ${proposalSeen.size} / ${proposal.recordPage.count} 页`, `Plan pages read: ${proposalSeen.size} / ${proposal.recordPage.count}`) }}</span>
        </div>

        <!-- Combined candidates (design §10.3 (5)): the same change also confirms a relationship (pilot only). -->
        <ul v-if="proposal.candidates.length > 0" class="sp-plan__candidates">
          <li v-for="candidate in proposal.candidates" :key="candidate.holdId" data-testid="stock-prep-refresh-change-plan-candidate">
            {{ bi('这一项同时要确认沿用(同一份需求换了位置)。', 'This item also confirms a relationship (the same demand at a new position).') }}
            <label v-if="candidate.history === 'history_unknown'" class="sp-plan__ack" data-testid="stock-prep-refresh-change-plan-candidate-history-ack">
              <input :checked="candidateChoices[candidate.holdId]?.historyAcknowledged === true" type="checkbox" @change="setCandidateAck(candidate.holdId, ($event.target as HTMLInputElement).checked)" />
              {{ bi('我知道这份需求的历史无法查证', 'I understand this demand’s history cannot be verified') }}
            </label>
            <label class="sp-plan__typed">
              {{ bi('依据说明(可选,一行)', 'Basis note (optional, one line)') }}
              <input
                type="text"
                maxlength="2000"
                autocomplete="off"
                data-testid="stock-prep-refresh-change-plan-candidate-note"
                :value="candidateChoices[candidate.holdId]?.note ?? ''"
                @input="setCandidateNote(candidate.holdId, ($event.target as HTMLInputElement).value)"
              />
            </label>
          </li>
        </ul>
        <p v-if="proposal.candidates.length > 0 && !pilot" class="sp-plan__warning" data-testid="stock-prep-refresh-change-plan-not-pilot">
          {{ bi('本项目不是试点,不能在这里确认沿用。', 'This project is not a pilot, so a relationship cannot be confirmed here.') }}
        </p>

        <label class="sp-plan__ack" data-testid="stock-prep-refresh-change-plan-ack">
          <input v-model="planAck" type="checkbox" />
          {{ bi(planAckText.zh, planAckText.en) }}
        </label>
        <label class="sp-plan__typed">
          {{ bi('输入项目号以确认变更计划', 'Type the project number to confirm the change plan') }}
          <input v-model="planTypedNo" type="text" autocomplete="off" data-testid="stock-prep-refresh-change-plan-typed-project-no" />
        </label>
        <div class="sp-plan__actions">
          <button
            type="button"
            class="sp-plan__button sp-plan__button--primary"
            data-testid="stock-prep-refresh-change-plan-confirm"
            :disabled="busy || !confirmBody"
            @click="confirmPlan"
          >{{ bi('确认变更计划', 'Confirm the change plan') }}</button>
        </div>
        <p v-if="!confirmBody" class="sp-plan__hint" data-testid="stock-prep-refresh-change-plan-confirm-why" :data-gap="confirmGap ?? ''">{{ confirmWhy }}</p>
      </section>

      <!-- b) A confirmed plan that is not written yet. -->
      <section v-if="confirmedPlan" class="sp-plan__block" data-testid="stock-prep-refresh-change-plan-confirmed">
        <h4 class="sp-plan__subtitle">{{ bi('已确认、待写入的变更计划', 'Confirmed change plan awaiting its write') }}</h4>
        <p class="sp-plan__lead">{{ bi('还没写入:请到项目备料页重新试算并写入;写入后回到这里完成变更复核。', 'Not written yet: preview again and write on the project page; after the write, come back here to complete the change review.') }}</p>
        <table v-if="confirmedRows.length > 0" class="sp-plan__table" data-testid="stock-prep-refresh-change-plan-confirmed-records">
          <thead>
            <tr>
              <th>{{ bi('记录', 'Record') }}</th>
              <th>{{ bi('字段', 'Field') }}</th>
              <th>{{ bi('原来', 'Before') }}</th>
              <th>{{ bi('改为', 'After') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, index) in confirmedRows" :key="index">
              <td>{{ row.record }}</td>
              <td>{{ row.field }}<code v-if="row.fieldId" class="sp-plan__token" data-testid="stock-prep-refresh-field-id">{{ row.fieldId }}</code></td>
              <td>{{ row.before }}</td>
              <td>{{ row.after }}</td>
            </tr>
          </tbody>
        </table>
        <div class="sp-plan__pager">
          <button type="button" class="sp-plan__link" :disabled="busy || cursor === 0" @click="goPage(cursor - 1)">{{ bi('上一页', 'Previous page') }}</button>
          <button type="button" class="sp-plan__link" :disabled="busy || confirmedPlan.recordPage.next === null" @click="goNext(confirmedPlan.recordPage.next)">{{ bi('下一页', 'Next page') }}</button>
        </div>
        <button
          type="button"
          class="sp-plan__button"
          data-testid="stock-prep-refresh-change-plan-go-preview"
          @click="emit('go-preview')"
        >{{ bi('去重新试算', 'Preview again') }}</button>
      </section>

      <!-- c) 「变更复核」: the written plan, bound to what the sheet holds NOW (C05 / C06 / C11 / C12; R-77 ④). -->
      <section v-if="writtenPlan" id="stock-prep-change-plan-review" class="sp-plan__block" data-testid="stock-prep-refresh-change-review">
        <h4 class="sp-plan__subtitle">{{ bi('变更复核', 'Change review') }}</h4>
        <p class="sp-plan__lead" data-testid="stock-prep-refresh-change-review-intro">{{ fillN(bi(reviewIntro.zh, reviewIntro.en), writtenPlan.recordCount) }}</p>
        <p class="sp-plan__note" data-testid="stock-prep-refresh-change-review-permission">{{ bi(permissionNote.zh, permissionNote.en) }}</p>
        <p v-if="writtenPlan.confirmedBySelf" class="sp-plan__note" data-testid="stock-prep-refresh-change-review-self">{{ bi(selfNote.zh, selfNote.en) }}</p>
        <p v-if="writtenPlan.absorbedChangePlanIds.length > 0" class="sp-plan__note" data-testid="stock-prep-refresh-change-review-absorbed">
          {{ bi(`其中包含之前写入、尚未复核的 ${writtenPlan.absorbedChangePlanIds.length} 份变更(标「上次写入」的格子)。`, `It includes ${writtenPlan.absorbedChangePlanIds.length} earlier written change(s) not reviewed yet (the cells marked “earlier write”).`) }}
        </p>
        <p v-if="writtenPlan.contentMatchesWrite === true" class="sp-plan__note" data-testid="stock-prep-refresh-change-review-digest" data-content-matches="true">
          {{ bi('表里现在的内容与写入时一致。', 'What the sheet holds now matches the write.') }}
        </p>
        <p v-else class="sp-plan__warning" data-testid="stock-prep-refresh-change-review-digest" data-content-matches="false">
          {{ bi('写入之后表里的内容又被改过,现在不能复核:请重新试算(系统会把新的变化列出来)。', 'The sheet was changed after the write, so it cannot be reviewed now: preview again (the new change will be listed).') }}
        </p>
        <p v-if="digestMoved" class="sp-plan__warning" data-testid="stock-prep-refresh-change-review-moved">
          {{ bi('表里的内容在您阅读时变了,请从第一页重新看。', 'The sheet changed while you were reading; read again from the first page.') }}
        </p>
        <p v-if="reviewBlock" class="sp-plan__warning" data-testid="stock-prep-refresh-change-review-blocked" :data-block-token="reviewBlock">{{ blockWords(reviewBlock) }}</p>

        <table v-if="writtenRows.length > 0" class="sp-plan__table" data-testid="stock-prep-refresh-change-review-records">
          <thead>
            <tr>
              <th>{{ bi('记录', 'Record') }}</th>
              <th>{{ bi('字段', 'Field') }}</th>
              <th>{{ bi('上次复核时', 'At the last review') }}</th>
              <th>{{ bi('写入前', 'Before the write') }}</th>
              <th>{{ bi('写入后', 'After the write') }}</th>
              <th>{{ bi('表里现在', 'In the sheet now') }}</th>
              <th>{{ bi('人工已填', 'Human entries') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, index) in writtenRows" :key="index" data-testid="stock-prep-refresh-change-review-row" :data-review-only="row.reviewOnly ? 'true' : 'false'">
              <td>{{ row.record }}<span v-if="row.root" class="sp-plan__hint">{{ bi(`根件(${rootNote.zh})`, `root (${rootNote.en})`) }}</span></td>
              <td>{{ row.field }}<code v-if="row.fieldId" class="sp-plan__token" data-testid="stock-prep-refresh-field-id">{{ row.fieldId }}</code><span v-if="row.reviewOnly" class="sp-plan__hint" data-testid="stock-prep-refresh-change-review-earlier">{{ bi('上次写入', 'earlier write') }}</span></td>
              <td>{{ row.baseline }}</td>
              <td>{{ row.before }}</td>
              <td>{{ row.after }}</td>
              <td>{{ row.current }}</td>
              <td>{{ row.human }}</td>
            </tr>
          </tbody>
        </table>
        <div class="sp-plan__pager">
          <button type="button" class="sp-plan__link" data-testid="stock-prep-refresh-change-review-prev" :disabled="busy || cursor === 0" @click="goPage(cursor - 1)">{{ bi('上一页', 'Previous page') }}</button>
          <button type="button" class="sp-plan__link" data-testid="stock-prep-refresh-change-review-next" :disabled="busy || writtenPlan.recordPage.next === null" @click="goNext(writtenPlan.recordPage.next)">{{ bi('下一页', 'Next page') }}</button>
          <span class="sp-plan__hint" data-testid="stock-prep-refresh-change-review-pages">{{ writtenPagesText }}</span>
        </div>

        <fieldset class="sp-plan__conclusion">
          <legend>{{ bi('复核结论', 'Review conclusion') }}</legend>
          <label data-testid="stock-prep-refresh-change-review-conclusion-handled">
            <input v-model="conclusion" type="radio" value="handled" />
            {{ bi(conclusionWords('handled').zh, conclusionWords('handled').en) }}
          </label>
          <label data-testid="stock-prep-refresh-change-review-conclusion-handled-with-notes">
            <input v-model="conclusion" type="radio" value="handled_with_notes" />
            {{ bi(conclusionWords('handled_with_notes').zh, conclusionWords('handled_with_notes').en) }}
          </label>
        </fieldset>
        <label class="sp-plan__typed">
          {{ bi('说明(一行,不超过 2000 字;选「已处理(附说明)」时必填)', 'Notes (one line, at most 2000 characters; required for “Handled (with notes)”)') }}
          <input v-model="notes" type="text" maxlength="2000" autocomplete="off" data-testid="stock-prep-refresh-change-review-notes" />
        </label>
        <label class="sp-plan__typed">
          {{ bi('输入项目号以完成复核', 'Type the project number to complete the review') }}
          <input v-model="reviewTypedNo" type="text" autocomplete="off" data-testid="stock-prep-refresh-change-review-typed-project-no" />
        </label>
        <div class="sp-plan__actions">
          <button
            type="button"
            class="sp-plan__button sp-plan__button--primary"
            data-testid="stock-prep-refresh-change-review-complete"
            :disabled="busy || !reviewBody"
            @click="completeReview"
          >{{ bi('完成变更复核', 'Complete the change review') }}</button>
        </div>
        <p v-if="!reviewBody" class="sp-plan__hint" data-testid="stock-prep-refresh-change-review-why" :data-gap="reviewGap ?? ''">{{ reviewWhy }}</p>
      </section>
    </template>
  </section>
</template>

<script setup lang="ts">
// 「变更计划」 / 「变更复核」 (备料分批拉取第一期 step 5 PR-9). VALUES: the plan's records (cells, keys, the human-column
// presence), the candidate choices, the acknowledgement, both typed numbers, the conclusion and the notes live in this
// component's refs ONLY — cleared when the project changes, when the parent re-reads (`generation`), after a decision and
// on unmount; never written to localStorage / sessionStorage, never put in an emit payload (the receipt it emits is ids
// and page indexes), the error banner, a clipboard string (only the code is copyable) or any console call.
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { useLocale } from '../../../composables/useLocale'
import { StockPreparationConfirmApiError } from '../../../services/integration/stockPreparation/confirmApi'
import {
  STOCK_PREP_REFRESH_BEFORE_CHANGE_NOTE,
  STOCK_PREP_REFRESH_CHANGE_PLAN_ACK,
  STOCK_PREP_REFRESH_CHANGE_PLAN_BLOCKED_PLAIN,
  STOCK_PREP_REFRESH_CHANGE_PLAN_SCOPE,
  STOCK_PREP_REFRESH_FIELD_OTHER,
  STOCK_PREP_REFRESH_FIELD_PLAIN,
  STOCK_PREP_REFRESH_REVIEW_CONCLUSION_PLAIN,
  STOCK_PREP_REFRESH_REVIEW_INTRO,
  STOCK_PREP_REFRESH_REVIEW_PERMISSION_NOTE,
  STOCK_PREP_REFRESH_REVIEW_SELF_NOTE,
  STOCK_PREP_REFRESH_ROOT_NOTE,
  stockPrepErrorCopyText,
  stockPrepErrorPlain,
  stockPrepRefreshTokenPlain,
  type StockPrepPlainEntry,
  type StockPrepPlainText,
} from '../../../services/integration/stockPreparation/plainLanguage'
import {
  receiptProgressFor,
  stockPrepRefreshCellText,
  type StockPrepRefreshHold,
  type StockPrepRefreshQueueApi,
  type StockPrepRefreshReceipt,
} from '../../../services/integration/stockPreparation/refreshQueue'
import {
  buildChangePlanConfirmBody,
  buildChangeReviewBody,
  changePlanConfirmGap,
  changePlanReceiptProgress,
  changeReviewGap,
  stockPrepChangePlanNeedsReread,
  stockPrepChangePlanPageUsable,
  stockPrepChangeReviewBlock,
  stockPrepReviewNotesProblem,
  type StockPrepChangePlanCandidateChoice,
  type StockPrepChangePlanPage,
  type StockPrepChangePlanView,
  type StockPrepChangeReviewBlock,
} from '../../../services/integration/stockPreparation/refreshChangePlan'
import { stockPrepProjectNumbersMatch } from '../../../services/integration/stockPreparation/projectTarget'
import { copyTextToClipboard } from '../../../views/plm/plmClipboard'

const props = withDefaults(
  defineProps<{
    projectNo: string
    api: StockPrepRefreshQueueApi
    /** The page's ONE read receipt (the holds pages and the plan pages thread the same id). */
    receipt?: StockPrepRefreshReceipt | null
    /** The holds the parent loaded (for C12: an open hold blocks the review). */
    holds?: StockPrepRefreshHold[]
    /** The holds page's `holdSetFingerprint` — the advisory cross-check against the proposal's. */
    holdsPageFingerprint?: string | null
    /** True when the holds page has more pages (an unloaded hold may be named by the plan). */
    hasMoreHolds?: boolean
    /** Bumped by the parent on every holds re-read: the plan is read again and the local choices cleared. */
    generation?: number
  }>(),
  { receipt: null, holds: () => [], holdsPageFingerprint: null, hasMoreHolds: false, generation: 0 },
)

const emit = defineEmits<{
  /** Values-free: ids, expiry and page indexes only. */
  (e: 'receipt-changed', receipt: StockPrepRefreshReceipt): void
  (e: 'decided', kind: 'plan_confirmed' | 'reviewed'): void
  (e: 'reread'): void
  (e: 'read-more-holds'): void
  (e: 'go-preview'): void
  (e: 'proposal-shown', shown: boolean): void
}>()

const { locale } = useLocale()
function bi(zh: string, en: string): string {
  return locale.value === 'zh-CN' ? zh : en
}

const scopeText = STOCK_PREP_REFRESH_CHANGE_PLAN_SCOPE
const planAckText = STOCK_PREP_REFRESH_CHANGE_PLAN_ACK
const reviewIntro = STOCK_PREP_REFRESH_REVIEW_INTRO
const permissionNote = STOCK_PREP_REFRESH_REVIEW_PERMISSION_NOTE
const selfNote = STOCK_PREP_REFRESH_REVIEW_SELF_NOTE
const rootNote = STOCK_PREP_REFRESH_ROOT_NOTE

type PlanState = 'loading' | 'ready' | 'unusable' | 'failed'

const state = ref<PlanState>('loading')
const busy = ref(false)
const page = ref<StockPrepChangePlanPage | null>(null)
const cursor = ref(0)
const errorCode = ref<string | null>(null)
const errorReason = ref<string | null>(null)
const planAck = ref(false)
const planTypedNo = ref('')
const candidateChoices = reactive<Record<string, StockPrepChangePlanCandidateChoice>>({})
const conclusion = ref('')
const notes = ref('')
const reviewTypedNo = ref('')
const proposalSeen = reactive(new Set<number>())
const digestMoved = ref(false)
// The written plan's digest at the last read (values-free: a digest, never a cell) — a move between two reads means
// the sheet changed while the puller was reading.
let lastWritten: { id: string; digest: string | null } | null = null
let ticket = 0

const proposal = computed(() => page.value?.proposal ?? null)
const confirmedPlan = computed<StockPrepChangePlanView | null>(() => page.value?.current?.confirmed ?? null)
const writtenPlan = computed<StockPrepChangePlanView | null>(() => page.value?.current?.written ?? null)
const pilot = computed<boolean>(() => page.value?.refresh?.pilot === true)
const nothingToShow = computed<boolean>(() => !(proposal.value && proposal.value.holdIds.length > 0) && !confirmedPlan.value && !writtenPlan.value)

const errorText = computed<StockPrepPlainEntry>(() => stockPrepErrorPlain(errorCode.value ?? '', errorReason.value))

function clearChoices(): void {
  planAck.value = false
  planTypedNo.value = ''
  conclusion.value = ''
  notes.value = ''
  reviewTypedNo.value = ''
  for (const key of Object.keys(candidateChoices)) delete candidateChoices[key]
}

function clearValues(): void {
  page.value = null
  cursor.value = 0
  proposalSeen.clear()
  digestMoved.value = false
  lastWritten = null
  clearChoices()
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

/** Read one page of the change plan with the page's receipt id; fail closed on anything that is not the PR-8 shape. */
async function read(nextCursor: number): Promise<void> {
  const projectNo = props.projectNo.trim()
  if (!projectNo) return
  const mine = ++ticket
  busy.value = true
  try {
    const answer = await props.api.readChangePlan(projectNo, { recordCursor: nextCursor, receipt: props.receipt?.id ?? null })
    if (mine !== ticket) return
    if (!stockPrepChangePlanPageUsable(answer)) {
      page.value = null
      state.value = 'unusable'
      return
    }
    if (answer.readReceipt) emit('receipt-changed', answer.readReceipt)
    const written = answer.current.written
    if (written && lastWritten && lastWritten.id === written.id && lastWritten.digest !== (written.currentContentDigest ?? null)) {
      digestMoved.value = true
    } else if (!written || !lastWritten || lastWritten.id !== written.id) {
      digestMoved.value = false
    }
    lastWritten = written ? { id: written.id, digest: written.currentContentDigest ?? null } : null
    page.value = answer
    cursor.value = nextCursor
    if (answer.proposal.recordPage.index < answer.proposal.recordPage.count) proposalSeen.add(answer.proposal.recordPage.index)
    state.value = 'ready'
  } catch (error) {
    if (mine !== ticket) return
    page.value = null
    recordError(error)
    // A 404 / 501 (an older backend, receipts or the store not wired) and every other failure: no control, one line.
    state.value = error instanceof StockPreparationConfirmApiError && (error.status === 404 || error.status === 501) ? 'unusable' : 'failed'
  } finally {
    if (mine === ticket) busy.value = false
  }
}

function reloadPlan(): void {
  errorCode.value = null
  void read(0)
}

function goPage(next: number): void {
  if (next < 0 || busy.value) return
  void read(next)
}

function goNext(next: number | null): void {
  if (next === null || busy.value) return
  void read(next)
}

function typedMatches(value: string): boolean {
  return stockPrepProjectNumbersMatch(props.projectNo, value)
}

function setCandidateAck(holdId: string, checked: boolean): void {
  candidateChoices[holdId] = { ...(candidateChoices[holdId] ?? {}), historyAcknowledged: checked }
}

function setCandidateNote(holdId: string, value: string): void {
  candidateChoices[holdId] = { ...(candidateChoices[holdId] ?? {}), note: value }
}

const holdsProgress = computed(() => changePlanReceiptProgress(props.receipt, proposal.value?.holdIds ?? []))
const holdsMoved = computed<boolean>(() => Boolean(proposal.value && props.holdsPageFingerprint !== proposal.value.holdSetFingerprint))

const confirmOptions = computed(() => ({
  confirmProjectNo: planTypedNo.value.trim(),
  typedMatches: typedMatches(planTypedNo.value),
  acknowledged: planAck.value,
  candidateChoices: { ...candidateChoices },
  holdsPageFingerprint: props.holdsPageFingerprint,
  pilot: pilot.value,
}))
const confirmGap = computed(() => changePlanConfirmGap(page.value, props.receipt, confirmOptions.value))
const confirmBody = computed(() => buildChangePlanConfirmBody(page.value, props.receipt, confirmOptions.value))

const confirmWhy = computed<string>(() => {
  switch (confirmGap.value) {
    case 'blocked': return bi('原因见上。', 'See the reason above.')
    case 'no_fingerprint': return bi('这份变更计划还没有完整的记录,不能确认;请重新试算。', 'This change plan is not fully recorded yet, so it cannot be confirmed; preview again.')
    case 'holds_moved': return bi('待确认项在您打开页面之后变了,请重新读取。', 'The holds changed after you opened the page; read them again.')
    case 'pages_unread': return bi('先把这份计划涉及的每一项都打开看完(见上面的进度)。', 'Open every item of this plan in full first (see the progress above).')
    case 'not_pilot': return bi('本项目不是试点,不能在这里确认沿用。', 'This project is not a pilot, so a relationship cannot be confirmed here.')
    case 'candidate': return bi('其中一项的沿用候选缺少记录,不能确认;请重新读取。', 'A relationship candidate lacks its record, so it cannot be confirmed; read again.')
    case 'history_ack': return bi('先勾选「我知道这份需求的历史无法查证」。', 'Tick “I understand this demand’s history cannot be verified” first.')
    case 'basis_note': return bi('依据说明只能是一行,不超过 2000 字。', 'A basis note is one line of at most 2000 characters.')
    case 'ack': return bi('先勾选上面的确认说明。', 'Tick the statement above first.')
    case 'typed': return bi('输入本项目的项目号后才能确认。', 'Type this project’s number to confirm.')
    default: return bi('现在不能确认。', 'It cannot be confirmed right now.')
  }
})

const reviewBlock = computed<StockPrepChangeReviewBlock>(() => stockPrepChangeReviewBlock(page.value, { openHolds: props.holds.length }))
const reviewOptions = computed(() => ({
  confirmProjectNo: reviewTypedNo.value.trim(),
  typedMatches: typedMatches(reviewTypedNo.value),
  conclusion: conclusion.value,
  notes: notes.value,
  block: reviewBlock.value,
}))
const reviewGap = computed(() => changeReviewGap(page.value, props.receipt, reviewOptions.value))
const reviewBody = computed(() => buildChangeReviewBody(page.value, props.receipt, reviewOptions.value))

function blockWords(block: StockPrepChangeReviewBlock): string {
  if (block === 'hold_open') return bi('还有待确认项,复核要等它们处理完。', 'Holds are still open; the review waits for them.')
  if (block === 'change_plan_pending') return bi('还有一份已确认、待写入的变更计划,复核要等它写入。', 'A confirmed change plan still awaits its write; the review waits for it.')
  if (block === 'recovery') return bi('上次写入没有正常结束,在等恢复;恢复之前不能复核。', 'The last write did not finish cleanly and awaits recovery; no review until then.')
  if (block === 'executing') return bi('本项目正在写入,写入结束后才能复核。', 'This project is being written; the review waits until the write ends.')
  return ''
}

const reviewWhy = computed<string>(() => {
  switch (reviewGap.value) {
    case 'content_moved': return bi('写入之后表里的内容又被改过,现在不能复核。', 'The sheet was changed after the write, so it cannot be reviewed now.')
    case 'pages_unread': return bi('先把当前差异的每一页都打开看过。', 'Open every page of the current difference first.')
    case 'blocked': return blockWords(reviewBlock.value)
    case 'conclusion': return bi('先选一个复核结论。', 'Choose a review conclusion first.')
    case 'notes': {
      const problem = stockPrepReviewNotesProblem(notes.value, conclusion.value)
      if (problem === 'required') return bi('选了「已处理(附说明)」就要写说明。', '“Handled (with notes)” needs the notes.')
      if (problem === 'control_character') return bi('说明只能是一行(不能换行或含控制字符)。', 'The notes must be one line (no line break or control character).')
      return bi('说明不能超过 2000 字。', 'The notes must be at most 2000 characters.')
    }
    case 'typed': return bi('输入本项目的项目号后才能完成复核。', 'Type this project’s number to complete the review.')
    default: return bi('现在不能复核。', 'It cannot be reviewed right now.')
  }
})

const writtenPagesText = computed<string>(() => {
  const written = writtenPlan.value
  if (!written) return ''
  const progress = receiptProgressFor(props.receipt, written.id)
  if (!progress) return bi(`当前差异共 ${written.recordPage.count} 页`, `${written.recordPage.count} page(s) of current difference`)
  return bi(`已看 ${progress.served} / ${progress.count} 页`, `Read ${progress.served} / ${progress.count} page(s)`)
})

// ── words ────────────────────────────────────────────────────────────────────────────────────────

function words(entry: StockPrepPlainText | null): string | null {
  return entry ? bi(entry.zh, entry.en) : null
}

function wordsOr(text: string | null, fallback: string): string {
  return text ?? fallback
}

function blockedWords(token: string | null): string | null {
  return words(stockPrepRefreshTokenPlain(STOCK_PREP_REFRESH_CHANGE_PLAN_BLOCKED_PLAIN, token))
}

function conclusionWords(token: string): StockPrepPlainText {
  return STOCK_PREP_REFRESH_REVIEW_CONCLUSION_PLAIN[token] ?? { zh: token, en: token }
}

function fillN(text: string, n: number): string {
  return text.replace('{n}', String(Number.isInteger(n) ? n : 0))
}

/** A field id in words; an id outside the map (a customer pack column) reads 「其他列」 with the id apart. */
function fieldLabel(fieldId: string): { text: string; id: string | null } {
  const entry = stockPrepRefreshTokenPlain(STOCK_PREP_REFRESH_FIELD_PLAIN, fieldId)
  return entry ? { text: bi(entry.zh, entry.en), id: null } : { text: bi(STOCK_PREP_REFRESH_FIELD_OTHER.zh, STOCK_PREP_REFRESH_FIELD_OTHER.en), id: fieldId }
}

function humanText(present: Record<string, unknown> | null | undefined): string {
  if (!present || typeof present !== 'object') return '—'
  const labels = Object.entries(present).filter(([, value]) => value === true).map(([fieldId]) => fieldLabel(fieldId).text)
  if (labels.length === 0) return '—'
  return `${labels.join(bi('、', ', '))}${bi(`(${STOCK_PREP_REFRESH_BEFORE_CHANGE_NOTE.zh})`, ` (${STOCK_PREP_REFRESH_BEFORE_CHANGE_NOTE.en})`)}`
}

function positionText(record: { root?: unknown; inContinuation?: unknown }): string {
  const parts: string[] = []
  if (record.root === true) parts.push(bi(`根件(${rootNote.zh})`, `root (${rootNote.en})`))
  if (record.inContinuation) parts.push(bi('沿用关系里的旧行', 'an old row in a relationship'))
  return parts.length > 0 ? parts.join(bi(';', '; ')) : '—'
}

interface ProposalRow { record: string; position: string; field: string; fieldId: string | null; before: string; after: string; human: string }

const proposalRows = computed<ProposalRow[]>(() => {
  const rows: ProposalRow[] = []
  for (const record of proposal.value?.records ?? []) {
    const fields = record.fields && typeof record.fields === 'object' ? record.fields : {}
    const human = humanText(record.humanColumnsPresent)
    for (const [fieldId, cell] of Object.entries(fields)) {
      const pair = cell && typeof cell === 'object' ? cell as { before?: unknown; after?: unknown } : {}
      const label = fieldLabel(fieldId)
      rows.push({ record: stockPrepRefreshCellText(record.key), position: positionText(record), field: label.text, fieldId: label.id, before: stockPrepRefreshCellText(pair.before), after: stockPrepRefreshCellText(pair.after), human })
    }
  }
  return rows
})

interface PlanRow { record: string; field: string; fieldId: string | null; baseline: string; before: string; after: string; current: string; reviewOnly: boolean; root: boolean; human: string }

function planRows(plan: StockPrepChangePlanView | null): PlanRow[] {
  const rows: PlanRow[] = []
  for (const record of plan?.records ?? []) {
    const human = humanText(record.humanColumnsPresent)
    for (const [fieldId, cell] of Object.entries(record.fields ?? {})) {
      const label = fieldLabel(fieldId)
      rows.push({
        record: stockPrepRefreshCellText(record.key),
        field: label.text,
        fieldId: label.id,
        baseline: stockPrepRefreshCellText(cell?.baseline),
        before: stockPrepRefreshCellText(cell?.before),
        after: stockPrepRefreshCellText(cell?.after),
        current: stockPrepRefreshCellText(cell?.current),
        reviewOnly: cell?.reviewOnly === true,
        root: record.root === true,
        human,
      })
    }
  }
  return rows
}

const confirmedRows = computed(() => planRows(confirmedPlan.value))
const writtenRows = computed(() => planRows(writtenPlan.value))

// ── decisions ────────────────────────────────────────────────────────────────────────────────────

async function decide(work: () => Promise<void>): Promise<boolean> {
  busy.value = true
  errorCode.value = null
  errorReason.value = null
  try {
    await work()
    return true
  } catch (error) {
    recordError(error)
    // The picture moved on (a newer computation, a replaced plan): the parent re-reads the holds page 1 (same
    // receipt) and bumps `generation`, which re-reads this plan. The refusal's words stay on this section.
    if (stockPrepChangePlanNeedsReread(errorCode.value, errorReason.value)) emit('reread')
    return false
  } finally {
    busy.value = false
  }
}

async function confirmPlan(): Promise<void> {
  const body = confirmBody.value
  const projectNo = props.projectNo.trim()
  if (!body || !projectNo || busy.value) return
  const ok = await decide(async () => {
    await props.api.confirmChangePlan(projectNo, body)
  })
  if (ok) {
    // C11: nothing of the confirm carries over to the review — the review's typed field and conclusion start empty.
    clearChoices()
    emit('decided', 'plan_confirmed')
  }
}

async function completeReview(): Promise<void> {
  const body = reviewBody.value
  const projectNo = props.projectNo.trim()
  if (!body || !projectNo || busy.value) return
  const ok = await decide(async () => {
    await props.api.completeChangeReview(projectNo, body)
  })
  if (ok) {
    clearChoices()
    emit('decided', 'reviewed')
  }
}

function copyError(): void {
  void copyTextToClipboard(stockPrepErrorCopyText(errorCode.value, locale.value === 'zh-CN'))
}

/** For the parent's per-hold pointer (values-free boolean): is section (a) on the page right now? */
const proposalShown = computed<boolean>(() => state.value === 'ready' && Boolean(proposal.value && proposal.value.holdIds.length > 0))
watch(proposalShown, (shown) => emit('proposal-shown', shown), { immediate: true })

// A different project: drop every value of the previous one BEFORE reading the new one.
watch(() => props.projectNo, () => {
  ticket += 1
  clearValues()
  errorCode.value = null
  errorReason.value = null
  state.value = 'loading'
  void read(0)
}, { immediate: true })

// The parent re-read its holds: read the plan again (page 1) and drop the local choices; a refusal's words stay.
watch(() => props.generation, () => {
  clearChoices()
  void read(0)
})

onBeforeUnmount(() => {
  ticket += 1
  clearValues()
})
</script>

<style scoped>
.sp-plan {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-3);
  border-top: 1px solid var(--ms-border-1, currentColor);
  padding-top: var(--ms-space-3);
}

.sp-plan__head,
.sp-plan__actions,
.sp-plan__pager {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--ms-space-2);
}

.sp-plan__title,
.sp-plan__subtitle {
  margin: 0;
  font-size: 14px;
  color: var(--ms-text-1);
}

.sp-plan__block {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-2);
}

.sp-plan__state,
.sp-plan__lead,
.sp-plan__note,
.sp-plan__pages {
  margin: 0;
  color: var(--ms-text-2);
  font-size: 13px;
  line-height: 1.7;
}

.sp-plan__error,
.sp-plan__warning {
  margin: 0;
  color: var(--ms-color-danger);
  font-size: 13px;
  line-height: 1.7;
}

.sp-plan__hint {
  display: block;
  color: var(--ms-text-3);
  font-size: 12px;
}

.sp-plan__token {
  font-family: var(--ms-font-mono, monospace);
  font-size: 12px;
  margin: 0 var(--ms-space-1);
}

.sp-plan__table {
  border-collapse: collapse;
  font-size: 12px;
}

.sp-plan__table th,
.sp-plan__table td {
  border: 1px solid var(--ms-border-1, currentColor);
  padding: 2px var(--ms-space-2);
  text-align: left;
}

.sp-plan__candidates {
  margin: 0;
  padding-left: var(--ms-space-4);
  font-size: 13px;
}

.sp-plan__conclusion {
  display: flex;
  flex-wrap: wrap;
  gap: var(--ms-space-3);
  font-size: 13px;
}

.sp-plan__button {
  padding: 4px 12px;
  font-size: 13px;
  cursor: pointer;
}

.sp-plan__button--primary {
  font-weight: 600;
}

.sp-plan__link {
  border: none;
  background: none;
  padding: 0;
  color: var(--ms-color-primary);
  cursor: pointer;
  font-size: 13px;
}

.sp-plan__typed,
.sp-plan__ack {
  display: flex;
  align-items: center;
  gap: var(--ms-space-2);
  font-size: 13px;
}
</style>
