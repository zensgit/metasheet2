<template>
  <section class="sp-sync" data-testid="stock-prep-project-sync">
    <header class="sp-sync__head">
      <h3 class="sp-sync__title">{{ bi('项目接入', 'Bring a project in') }}</h3>
      <p class="sp-sync__lede" data-testid="stock-prep-project-sync-lede">
        {{ bi(
          '填一个项目号,点同步 —— 这个项目的 BOM 就会从 PLM 读过来,写进我们的多维表。碰到拿不准的行,系统会停下来先问您,不会自己猜。',
          'Type a project number and press sync: this project’s BOM is read from PLM and written into our multitable. Where a row is uncertain the system stops and asks you rather than guessing.',
        ) }}
      </p>
    </header>

    <!-- The one input on this panel. The project number is the OPERATOR'S OWN text and the only
         business string on the surface; everything else the panel shows is a count or a status. -->
    <div class="sp-sync__form">
      <label class="sp-sync__field">
        <span class="sp-sync__label">{{ bi('项目号', 'Project number') }}</span>
        <input
          ref="projectNoEl"
          v-model="projectNo"
          type="text"
          class="sp-sync__input"
          data-testid="stock-prep-project-sync-project-no"
          :disabled="busy"
          :placeholder="bi('例如 P2026-001', 'e.g. P2026-001')"
          :aria-label="bi('要同步的项目号', 'The project number to sync')"
          @keyup.enter="onRun"
        />
      </label>
      <button
        v-if="canRun"
        type="button"
        class="sp-sync__run"
        data-testid="stock-prep-project-sync-run"
        :disabled="!canSubmit"
        @click="onRun"
      >
        {{ busy
          ? bi('正在同步…', 'Syncing…')
          : bi('同步这个项目(可以重复点,不会重复写)', 'Sync this project (safe to repeat — it never writes twice)') }}
      </button>
      <!-- R-11: a control the caller cannot exercise is ABSENT, and the reason is said in words. -->
      <p v-else class="sp-sync__hint" data-testid="stock-prep-project-sync-denied">
        {{ bi(
          '从 PLM 拉数据这件事要由平台管理员来做。您可以看这里的结果,同步请找平台管理员执行。',
          'Pulling data from PLM is a platform administrator’s job. You can read the results here; ask a platform administrator to run the sync.',
        ) }}
      </p>
    </div>

    <!-- The row-refresh explanation. It appears only when a row's 刷新 armed this panel, because
         otherwise it is an answer to a question nobody asked. -->
    <p v-if="armedNote" class="sp-sync__armed" data-testid="stock-prep-project-sync-armed" role="status">
      {{ bi(
        '这一行的项目号系统没有保存 —— 表里只留内部编号,不存项目号这类业务值。请在上面填上项目号再同步;同一个项目号再同步一次不会重复写。',
        'The system does not store this row’s project number — the table keeps an internal handle only, never a business value like a project number. Type the number above and sync; syncing the same number again writes nothing twice.',
      ) }}
    </p>

    <!-- 「导进去了吗?」 — one sentence, before any step is read. -->
    <p v-if="report" class="sp-sync__verdict" data-testid="stock-prep-project-sync-verdict" :data-verdict="report.verdict">
      <strong>{{ verdictText }}</strong>
      <span v-if="verdictNext" class="sp-sync__verdict-next">{{ verdictNext }}</span>
      <span class="sp-sync__token">
        OK {{ report.okCount }} · SKIP {{ report.skipCount }} · FAIL {{ report.failCount }}
      </span>
    </p>

    <!-- What the plan found, as a sentence rather than five chips. -->
    <p v-if="report && report.planned" class="sp-sync__counts" data-testid="stock-prep-project-sync-counts">
      {{ countsSentence }}
    </p>

    <!-- Where to go next. Both are navigation inside this same workbench; neither is a new route. -->
    <div v-if="report" class="sp-sync__next">
      <button
        v-if="report.imported || report.verdict === 'already_up_to_date'"
        type="button"
        class="sp-sync__link"
        data-testid="stock-prep-project-sync-open-multitable"
        @click="emit('open-multitable')"
      >
        {{ bi('到多维表看数据', 'Open the multitable and look at the data') }}
      </button>
      <button
        v-if="report.pendingConfirmCount > 0"
        type="button"
        class="sp-sync__link"
        data-testid="stock-prep-project-sync-open-queue"
        @click="emit('navigate-stage', 'confirmation-queue')"
      >
        {{ bi('去「确认队列」处理', 'Go to the confirmation queue') }}
        ({{ report.queuedDecisionCount > 0 ? report.queuedDecisionCount : report.pendingConfirmCount }})
      </button>
      <button
        v-if="report.steps.some((step) => step.id === 'archive' && step.status === 'ok')"
        type="button"
        class="sp-sync__link"
        data-testid="stock-prep-project-sync-open-diff"
        @click="emit('navigate-stage', 'bom-snapshot-diff')"
      >
        {{ bi('看这次和上一次的差异', 'See what changed since last time') }}
      </button>
    </div>

    <!-- The four steps. A SKIP is rendered with the same weight as an OK, and its reason is never
         dropped — hiding it is how the outstanding work goes unnoticed. -->
    <ol class="sp-sync__steps">
      <li
        v-for="row in stepRows"
        :key="row.descriptor.id"
        class="sp-sync__step"
        data-testid="stock-prep-project-sync-step"
        :data-step="row.descriptor.id"
        :data-status="row.status"
      >
        <span class="sp-sync__status" :class="`sp-sync__status--${row.status}`">{{ statusLabel(row.status) }}</span>
        <span class="sp-sync__step-name">{{ bi(row.descriptor.zh, row.descriptor.en) }}</span>
        <template v-if="row.result">
          <small class="sp-sync__reason" data-testid="stock-prep-project-sync-step-reason">{{ reasonText(row.result) }}</small>
          <small v-if="reasonNext(row.result)" class="sp-sync__next-line" data-testid="stock-prep-project-sync-step-next">
            {{ reasonNext(row.result) }}
          </small>
        </template>
        <small v-else class="sp-sync__hint">{{ bi('还没走到这一步', 'Not reached yet') }}</small>
      </li>
    </ol>

    <StockPrepTechnicalDetails v-if="report" testid="stock-prep-project-sync-tech">
      <dl>
        <dt>{{ bi('每一步走的路由、结果码与计数', 'The route, outcome code and counts of each step') }}</dt>
        <dd>
          <ul>
            <li v-for="row in stepRows" :key="row.descriptor.id">
              <code>{{ row.descriptor.id }}</code>
              <code data-testid="stock-prep-project-sync-step-code">{{ row.status.toUpperCase() }}</code>
              <code v-if="row.result">{{ row.result.reason }}</code>
              <div><code>{{ row.descriptor.route }}</code></div>
              <span
                v-for="(value, key) in (row.result ? row.result.detail : {})"
                :key="key"
                class="sp-sync__detail"
                data-testid="stock-prep-project-sync-step-detail"
              >{{ key }}={{ value }}</span>
            </li>
          </ul>
        </dd>
        <dt>{{ bi('这个面板能做什么、不能做什么', 'What this panel can and cannot do') }}</dt>
        <dd>
          {{ bi(
            '只驱动四条已有路由,没有新增任何写入权限:dry-run(read)、reconcile(admin)、apply(write)、mvp-persist(admin,受部署开关控制)。不向 ERP/K3 写入,不新建物料,不提供 SQL 入口。',
            'Drives four EXISTING routes and adds no new write authority: dry-run (read), reconcile (admin), apply (write), mvp-persist (admin, behind a deployment flag). No ERP/K3 write, no material creation, no SQL entry point.',
          ) }}
        </dd>
      </dl>
    </StockPrepTechnicalDetails>
  </section>
</template>

<script setup lang="ts">
// 项目接入 — the owner's spec, made into a control.
//
//   「PLM系统接通后,在页面哪里可点击项目号,然后该项目号里的bom就自动导入到我们的多维表中」
//
// The answer to 「在页面哪里」 is: here, at the top of 项目工作台 — the tab that already answers
// "which projects are in, and how far along are they". Putting the entry on the same screen as the
// already-synced list is what makes the row-level 刷新 mean anything: the input it points at is two
// inches above the row. A separate first tab would have made the operator switch tabs to see the
// result of what they just did.
//
// NO NEW WRITE AUTHORITY. Every call is an existing route with its existing gate; see projectSync.ts.
// The run control renders only for a platform admin because the widest gate among the four is
// platform admin, and R-11 forbids showing a control that would 403.
//
// VALUES-FREE, with ONE deliberate exception: the project number the operator typed. It is their own
// text, echoed back into their own input, and it never comes from a response — the projects read
// route deliberately never serves it. Everything else on this panel is a count, a closed status
// token, an HTTP status or a reason code.
import { computed, nextTick, ref, watch } from 'vue'
import { useLocale } from '../../../composables/useLocale'
import { useAuth } from '../../../composables/useAuth'
import type { IntegrationScope } from '../../../services/integration/workbench'
import StockPrepTechnicalDetails from './StockPrepTechnicalDetails.vue'
import {
  STOCK_PREPARATION_PROJECT_SYNC_STEPS,
  createStockPreparationProjectSyncApi,
  runStockPreparationProjectSync,
  type StockPreparationProjectSyncApi,
  type StockPreparationProjectSyncReport,
  type StockPreparationProjectSyncStepResult,
  type StockPreparationProjectSyncStepStatus,
} from '../../../services/integration/stockPreparation/projectSync'
import { canRunStockPrepProjectSync } from '../../../services/integration/stockPreparation/workbenchAccess'
import {
  stockPrepStepOutcomeText,
  stockPrepSyncReasonPlain,
  stockPrepSyncVerdictPlain,
} from '../../../services/integration/stockPreparation/plainLanguage'

const props = withDefaults(
  defineProps<{
    scope?: IntegrationScope
    /**
     * Bumped by the parent when a row's 刷新 is pressed. A COUNTER rather than a boolean so pressing
     * refresh twice re-focuses the input both times.
     */
    armedAt?: number
    /**
     * Test seam ONLY: an injected API double. Production always builds its own from `scope`, so a
     * component mounted without this prop cannot be pointed at a different endpoint.
     */
    api?: StockPreparationProjectSyncApi | null
  }>(),
  { scope: () => ({}), armedAt: 0, api: null },
)

const emit = defineEmits<{
  /** Reuses the shell's ONE tab-nav surface (the same event the dashboard's stepper emits). */
  (e: 'navigate-stage', viewKey: string): void
  /** "Open the multitable" — the parent owns routing; this panel composes no route. */
  (e: 'open-multitable'): void
  /** Fired after a run settles so the parent can re-read the project overview. */
  (e: 'synced'): void
}>()

const { locale } = useLocale()
const auth = useAuth()

function bi(zh: string, en: string): string {
  return locale.value === 'zh-CN' ? zh : en
}

const canRun = computed(() => canRunStockPrepProjectSync((permission) => auth.hasPermission(permission)))

const projectNo = ref('')
const busy = ref(false)
const armedNote = ref(false)
const results = ref<StockPreparationProjectSyncStepResult[]>([])
const report = ref<StockPreparationProjectSyncReport | null>(null)
const projectNoEl = ref<HTMLInputElement | null>(null)

const canSubmit = computed(() => canRun.value && !busy.value && projectNo.value.trim().length > 0)

// A row's 刷新 arms this panel: it explains why the number has to be typed and puts the cursor in the
// field. It deliberately does NOT run anything — the panel cannot know which project a values-free
// row is, and guessing would sync the wrong project.
watch(() => props.armedAt, async (next, previous) => {
  if (typeof next !== 'number' || next === previous || next === 0) return
  armedNote.value = true
  await nextTick()
  projectNoEl.value?.focus()
})

async function onRun(): Promise<void> {
  if (!canSubmit.value) return
  const target = projectNo.value.trim()
  results.value = []
  report.value = null
  busy.value = true
  try {
    const api = props.api ?? createStockPreparationProjectSyncApi(props.scope)
    report.value = await runStockPreparationProjectSync(api, target, (step) => {
      // Render each step AS IT LANDS: a run that stops at the plan must still show the plan's counts.
      results.value = [...results.value, step]
    })
    armedNote.value = false
    emit('synced')
  } finally {
    busy.value = false
  }
}

/** Every planned step, with its result once it has one. Steps not reached are still listed. */
const stepRows = computed(() => STOCK_PREPARATION_PROJECT_SYNC_STEPS.map((descriptor) => {
  const found = results.value.find((entry) => entry.id === descriptor.id) ?? null
  return {
    descriptor,
    result: found,
    status: (found ? found.status : 'pending') as StockPreparationProjectSyncStepStatus,
  }
}))

function statusLabel(status: StockPreparationProjectSyncStepStatus): string {
  const text = stockPrepStepOutcomeText(status)
  return bi(text.zh, text.en)
}

function reasonText(result: StockPreparationProjectSyncStepResult): string {
  const plain = stockPrepSyncReasonPlain(result.reason)
  // Fails soft, like every other lookup in plainLanguage.ts: a reason added later renders as its own
  // code rather than blanking the line.
  return plain ? bi(plain.zh, plain.en) : result.reason
}

function reasonNext(result: StockPreparationProjectSyncStepResult): string {
  const plain = stockPrepSyncReasonPlain(result.reason)
  if (!plain) return ''
  return bi(plain.zhNext ?? '', plain.enNext ?? '')
}

const verdictText = computed<string>(() => {
  const plain = report.value ? stockPrepSyncVerdictPlain(report.value.verdict) : null
  return plain ? bi(plain.zh, plain.en) : ''
})

const verdictNext = computed<string>(() => {
  const plain = report.value ? stockPrepSyncVerdictPlain(report.value.verdict) : null
  if (!plain) return ''
  return bi(plain.zhNext ?? '', plain.enNext ?? '')
})

/**
 * The plan's five numbers as ONE sentence. The clauses that are zero are dropped — "新增 0 行,更新 0
 * 行,跳过 12 行" makes a reader hunt for the number that matters.
 */
const countsSentence = computed<string>(() => {
  const planned = report.value?.planned
  if (!planned) return ''
  const parts: string[] = []
  if (planned.add > 0) parts.push(bi(`新增 ${planned.add} 行`, `${planned.add} rows added`))
  if (planned.update > 0) parts.push(bi(`更新 ${planned.update} 行`, `${planned.update} rows updated`))
  if (planned.skip > 0) parts.push(bi(`${planned.skip} 行已经是最新的`, `${planned.skip} rows already current`))
  if (planned.inactive > 0) parts.push(bi(`${planned.inactive} 行在源头没有了`, `${planned.inactive} rows gone from the source`))
  if (planned.manualConfirm > 0) {
    parts.push(bi(`${planned.manualConfirm} 行需要人工确认`, `${planned.manualConfirm} rows need a person to confirm`))
  }
  if (parts.length === 0) return bi('这次试算没有需要改动的行。', 'The plan found nothing to change.')
  return bi(`这次试算:${parts.join('、')}。`, `This plan: ${parts.join(', ')}.`)
})
</script>

<style scoped>
.sp-sync {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-3);
  margin: 0 0 var(--ms-space-4);
  padding: var(--ms-space-4);
  border: 1px solid var(--ms-border-light);
  border-radius: 8px;
  background: var(--ms-bg-card);
}

.sp-sync__head {
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-1);
}

.sp-sync__title {
  margin: 0;
  font-size: var(--ms-font-size-section-title);
  color: var(--ms-text-1);
}

.sp-sync__lede {
  margin: 0;
  color: var(--ms-text-2);
  line-height: 1.6;
}

.sp-sync__form {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: var(--ms-space-3);
}

.sp-sync__field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 220px;
}

.sp-sync__label {
  color: var(--ms-text-3);
  font-size: 12px;
}

.sp-sync__input {
  border: 1px solid var(--ms-border-light);
  border-radius: 6px;
  background: var(--ms-bg-page);
  padding: 6px 10px;
  color: var(--ms-text-1);
  font: inherit;
}

.sp-sync__input:focus-visible {
  outline: 2px solid var(--ms-color-primary);
  outline-offset: 1px;
}

.sp-sync__run {
  border: 1px solid var(--ms-color-primary);
  border-radius: 6px;
  background: var(--ms-color-primary);
  padding: 6px 14px;
  color: #fff;
  font: inherit;
  font-weight: var(--ms-font-weight-title);
  cursor: pointer;
}

.sp-sync__run:disabled {
  opacity: 0.5;
  cursor: default;
}

.sp-sync__run:focus-visible {
  outline: 2px solid var(--ms-color-primary);
  outline-offset: 2px;
}

.sp-sync__hint,
.sp-sync__armed {
  margin: 0;
  color: var(--ms-text-3);
  font-size: 13px;
  line-height: 1.6;
}

.sp-sync__armed {
  padding: var(--ms-space-2) var(--ms-space-3);
  border: 1px solid var(--ms-border-light);
  border-radius: 6px;
  background: var(--ms-bg-page);
  color: var(--ms-text-2);
}

.sp-sync__verdict {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--ms-space-2);
  margin: 0;
  color: var(--ms-text-1);
  line-height: 1.6;
}

.sp-sync__verdict-next,
.sp-sync__counts {
  margin: 0;
  color: var(--ms-text-2);
  font-size: 13px;
  line-height: 1.6;
}

.sp-sync__token {
  color: var(--ms-text-3);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.sp-sync__next {
  display: flex;
  flex-wrap: wrap;
  gap: var(--ms-space-2);
}

.sp-sync__link {
  border: 1px solid var(--ms-border-light);
  border-radius: 6px;
  background: transparent;
  padding: 4px 12px;
  color: var(--ms-color-primary);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}

.sp-sync__link:hover {
  background: var(--el-fill-color-light);
}

.sp-sync__link:focus-visible {
  outline: 2px solid var(--ms-color-primary);
  outline-offset: 1px;
}

.sp-sync__steps {
  margin: 0;
  padding: 0 0 0 var(--ms-space-4);
  display: flex;
  flex-direction: column;
  gap: var(--ms-space-2);
}

.sp-sync__step {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--ms-space-2);
  line-height: 1.6;
}

.sp-sync__status {
  display: inline-flex;
  align-items: center;
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--el-fill-color-light);
  color: var(--ms-text-2);
  font-size: 12px;
  font-weight: var(--ms-font-weight-title);
}

.sp-sync__status--ok {
  color: var(--ms-color-success, #2f9e44);
}

.sp-sync__status--skip {
  color: var(--ms-color-warning, #b8860b);
}

.sp-sync__status--fail {
  color: var(--ms-color-danger, #c92a2a);
}

.sp-sync__step-name {
  color: var(--ms-text-1);
}

.sp-sync__reason,
.sp-sync__next-line {
  color: var(--ms-text-2);
  font-size: 13px;
}

.sp-sync__next-line {
  color: var(--ms-text-3);
}

.sp-sync__detail {
  color: var(--ms-text-3);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
</style>
