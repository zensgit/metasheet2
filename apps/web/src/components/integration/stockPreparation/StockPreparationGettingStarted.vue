<template>
  <section class="stock-prep-gs" data-testid="stock-prep-getting-started">
    <h3 class="stock-prep-gs__title">{{ bi('开始使用', 'Getting started') }}</h3>
    <p class="stock-prep-gs__intro" data-testid="stock-prep-getting-started-intro">
      {{ bi(
        '第一次接入,按顺序走完这六步,一线就能开始用了。整个过程不会碰您 ERP/K3 里的数据。任何一步都能点开看 —— 这是一张地图,不是一道闸机。',
        'First time setting up: work through these six steps in order and the floor can start using it. None of this touches your ERP/K3 data. Any step can be opened at any time — this is a map, not a gate.',
      ) }}
    </p>

    <!-- THE SIX-STEP MAP. Every badge is DERIVED (gettingStarted.ts) from data this page already has
         via props — nothing here fetches. It renders on the FIRST tick, before any button anywhere on
         this page has been pressed: `steps` computes off whatever the parent already holds (null on
         first mount, which the derivation reads as `not_started` / `held`, never as a blank). -->
    <ol class="stock-prep-gs__map" data-testid="stock-prep-getting-started-map" role="list">
      <li
        v-for="key in stepOrder"
        :key="key"
        class="stock-prep-gs__step"
        data-testid="stock-prep-getting-started-step"
        :data-step="key"
        :data-badge="steps[key]"
      >
        <span class="stock-prep-gs__glyph" :class="`stock-prep-gs__glyph--${badgeOf(key).tone}`">{{ badgeOf(key).glyph }}</span>
        <span class="stock-prep-gs__step-label">{{ bi(stepLabel(key).zh, stepLabel(key).en) }}</span>
        <span
          class="stock-prep-gs__badge"
          :class="`stock-prep-gs__badge--${badgeOf(key).tone}`"
          data-testid="stock-prep-getting-started-step-badge"
        >{{ bi(badgeOf(key).zh, badgeOf(key).en) }}</span>
      </li>
    </ol>

    <!-- ① 接一条只读连接 — off-page by construction; the one thing this page can do is link out. -->
    <p v-if="steps['source-connect'] !== 'done'" class="stock-prep-gs__hint" data-testid="stock-prep-getting-started-step-source-connect">
      {{ bi('还没登记连接?', 'No connection registered yet?') }}
      <a href="/data-sources" data-testid="stock-prep-getting-started-link-data-sources">{{ bi('去外接数据源页 ↗', 'Go to the data-sources page ↗') }}</a>
    </p>

    <!-- ④ 建表 + 装列 — the one step this page actually DRIVES. Blockers split by fix.kind (I-8/I-9):
         an `http` blocker gets a button (the same idempotent install run) and the "重复点是安全的"
         reassurance; an `env` blocker gets no button at all — only a copy-for-ops line, because no
         input on this page can supply deployment-machine data (G6 restated for buttons: a control the
         page cannot back is absent, not disabled). -->
    <section class="stock-prep-gs__card" data-testid="stock-prep-getting-started-step-install">
      <h4 class="stock-prep-gs__h4">{{ bi('④ 建表 + 装列', '④ Create tables and install columns') }}</h4>

      <template v-if="props.preflight && !props.preflight.ready">
        <ul class="stock-prep-gs__list">
          <li
            v-for="blocker in preflightBlockers"
            :key="blocker.code"
            class="stock-prep-gs__blocker"
            data-testid="stock-prep-getting-started-blocker"
            :data-fix-kind="blockerKind(blocker)"
          >
            <strong v-if="blockerPlain(blocker.code)">{{ bi(blockerPlain(blocker.code)!.zh, blockerPlain(blocker.code)!.en) }}</strong>
            <strong v-else>{{ blocker.what }}</strong>
            <small v-if="blockerPlain(blocker.code)" class="stock-prep-gs__hint">
              {{ bi(blockerPlain(blocker.code)!.zhNext || '', blockerPlain(blocker.code)!.enNext || '') }}
            </small>
            <code class="stock-prep-gs__token">{{ blocker.code }}</code>

            <!-- http: a button, plus the idempotency reassurance right beside it (I-7/I-8). -->
            <span v-if="blockerKind(blocker) === 'http'" class="stock-prep-gs__blocker-action">
              <button
                v-if="props.canRunInstall"
                type="button"
                data-testid="stock-prep-getting-started-blocker-fix"
                :disabled="props.busy"
                @click="emit('run-install')"
              >{{ bi('开始安装', 'Start install') }}</button>
              <small class="stock-prep-gs__hint">{{ bi('重复点是安全的。', 'Pressing this again is safe.') }}</small>
            </span>

            <!-- env: NO "立即修复" button — this page has no field for deployment-machine data and
                 must never grow one (STOCK_PREP_BLOCKER_PLAIN's own discipline). Copy only. -->
            <span v-else class="stock-prep-gs__blocker-action">
              <button
                type="button"
                data-testid="stock-prep-getting-started-blocker-copy"
                @click="copyBlockerForOps(blocker)"
              >{{ blockerCopyLabel === 'copy' ? bi('复制这条给运维', 'Copy this for ops') : bi('已复制', 'Copied') }}</button>
            </span>
          </li>
        </ul>
      </template>
      <p v-else-if="props.preflight && props.preflight.ready" class="stock-prep-gs__hint" data-testid="stock-prep-getting-started-install-ready">
        {{ bi('都齐了,可以安装。', 'Everything is in place — ready to install.') }}
      </p>
      <p v-else class="stock-prep-gs__hint" data-testid="stock-prep-getting-started-install-not-started">
        {{ bi('还没检查过。', 'Not checked yet.') }}
      </p>

      <!-- The run controls. "只检查" is a READ (stock-prep:read tier — the same route the ungated
           preflight-check button below this wizard already exposes to a workbench admin), so it is
           NEVER gated here either — R-11 the other direction: a control the caller CAN exercise must
           not be hidden. "开始安装" stays platform-admin only (R-11), and neither is ever gated on
           blocker CONTENT, so ledger-not-ready (or any other http blocker) never locks it (G5). -->
      <div class="stock-prep-gs__actions">
        <button
          type="button"
          data-testid="stock-prep-getting-started-check-preflight"
          :disabled="props.busy"
          @click="emit('run-preflight-check')"
        >{{ bi('只检查,先不装', 'Check only, do not install') }}</button>
        <template v-if="props.canRunInstall">
          <button
            type="button"
            data-testid="stock-prep-getting-started-run-install"
            :disabled="props.busy"
            @click="emit('run-install')"
          >{{ bi('开始安装', 'Start install') }}</button>
          <small class="stock-prep-gs__hint">
            {{ bi('这会把该建的都建一遍。已经建好的不会重复建,重复点是安全的。', 'This creates everything that still needs creating. What already exists is not created twice — running it again is safe.') }}
          </small>
        </template>
      </div>
      <div v-if="!props.canRunInstall" class="stock-prep-gs__hint" data-testid="stock-prep-getting-started-install-held">
        <p>{{ bi('这一步不归您做。建表要平台管理员来做,您这边能做的是把要做的事说清楚交出去:', 'This is not your step — creating tables is a platform administrator’s job. What you can do is hand it off with the details already spelled out:') }}</p>
        <button
          type="button"
          data-testid="stock-prep-getting-started-copy-todo-install"
          @click="copyInstallTodo"
        >{{ installTodoCopyLabel === 'copy' ? bi('复制一份待办给平台管理员', 'Copy a to-do for a platform administrator') : bi('已复制', 'Copied') }}</button>
      </div>
    </section>

    <!-- ⑤ 谁能用 — STATIC in P0 (line B2 / design §6.1's own scope cut). No live role check, so
         nothing here can ever render a 403 or a user identity: the three permission codes are the
         same authored table the install page's own §14 defaults panel already renders. -->
    <section class="stock-prep-gs__card" data-testid="stock-prep-getting-started-step-grant-access">
      <h4 class="stock-prep-gs__h4">{{ bi('⑤ 谁能用', '⑤ Who can use it') }}</h4>
      <p class="stock-prep-gs__hint">
        {{ bi(
          '装好之后,系统不会自动给任何人权限。要让一线能打开这个页面,得先把下面的权限挂到一个角色上,再把人放进那个角色。',
          'Once installed, nobody gets any permission automatically. For the floor to open this page, these permissions have to be attached to a role, and people placed in that role.',
        ) }}
      </p>
      <ul class="stock-prep-gs__list stock-prep-gs__list--plain" data-testid="stock-prep-getting-started-permission-list">
        <li v-for="code in accessCodes" :key="code" data-testid="stock-prep-getting-started-permission-row">
          <code class="stock-prep-gs__token">{{ code }}</code>
          <span v-if="permissionPlain(code)">{{ bi(permissionPlain(code)!.zh, permissionPlain(code)!.en) }}</span>
        </li>
      </ul>
      <p class="stock-prep-gs__hint">
        {{ bi('一线要能干活,查看和填写两项都要,少一个就只能看不能做。', 'For the floor to do the work, both the view and the enter-data codes are needed — missing either leaves them able to look but not act.') }}
      </p>
      <div class="stock-prep-gs__actions">
        <a href="/admin/roles" data-testid="stock-prep-getting-started-link-roles">{{ bi('去配角色 ↗', 'Go configure roles ↗') }}</a>
        <a href="/admin/users" data-testid="stock-prep-getting-started-link-users">{{ bi('去把人放进角色 ↗', 'Go add people to the role ↗') }}</a>
      </div>
      <p class="stock-prep-gs__hint" data-testid="stock-prep-getting-started-access-fallback">
        {{ bi(
          '这两个页面需要平台管理员权限;打不开就用下面这个把事交出去。',
          'Both pages need platform-administrator rights; if they will not open, hand the work off with the button below instead.',
        ) }}
      </p>
      <button
        type="button"
        data-testid="stock-prep-getting-started-copy-todo-access"
        @click="copyAccessTodo"
      >{{ accessTodoCopyLabel === 'copy' ? bi('复制一份待办给平台管理员', 'Copy a to-do for a platform administrator') : bi('已复制', 'Copied') }}</button>
    </section>

    <!-- ⑥ 拿一个项目跑一遍 — held in P0 (no embedded project-sync panel yet). The link is NEVER
         conditioned on the source verdict: a `no-go` reading does not lock this step (G5) because
         nothing here reads `sourcePreflight.verdict` at all. -->
    <section class="stock-prep-gs__card" data-testid="stock-prep-getting-started-step-first-run">
      <h4 class="stock-prep-gs__h4">{{ bi('⑥ 拿一个项目跑一遍', '⑥ Run one project through it') }}</h4>
      <p class="stock-prep-gs__hint">
        {{ bi(
          '正式验收由随版本发布的脚本判定,不在本页点按钮完成。这一步是浏览器里的一次试算:找一个项目,从 PLM 拉一遍,看结果对不对。',
          'Formal acceptance is judged by the script that ships with the release, not by a button here. This step is a trial run in the browser: pick a project, pull it from PLM, and see whether the result looks right.',
        ) }}
      </p>
      <button
        type="button"
        data-testid="stock-prep-getting-started-go-project-board"
        @click="emit('navigate-stage', 'project-board')"
      >{{ bi('去项目备料页试一遍', 'Go try it on the project board') }}</button>
    </section>

    <!-- THE NINE-STEP INSTALL PLAN — rendered BEFORE any button anywhere on this page is pressed
         (design §6.1 acceptance #5). Every held step's explanation is the SAME text
         `STOCK_PREPARATION_INSTALL_STEPS` already carries (installRun.ts) — nothing here re-authors
         it, so the two surfaces can never disagree about why a step is held. -->
    <section class="stock-prep-gs__card" data-testid="stock-prep-getting-started-plan">
      <h4 class="stock-prep-gs__h4">{{ bi('九步安装计划', 'The nine-step install plan') }}</h4>
      <ol class="stock-prep-gs__plan">
        <li
          v-for="row in planRows"
          :key="row.descriptor.id"
          class="stock-prep-gs__plan-row"
          data-testid="stock-prep-getting-started-plan-step"
          :data-step="row.descriptor.id"
          :data-status="row.status"
        >
          <span class="stock-prep-gs__status" :class="`stock-prep-gs__status--${row.status}`">{{ statusLabel(row.status) }}</span>
          <span>{{ bi(row.descriptor.zh, row.descriptor.en) }}</span>
          <small v-if="!row.descriptor.driven" class="stock-prep-gs__hint" data-testid="stock-prep-getting-started-plan-held">
            {{ bi(row.descriptor.heldZh || '', row.descriptor.heldEn || '') }}
          </small>
        </li>
      </ol>
    </section>

    <!-- THE COMPLETION / HAND-OFF CARD — appears once the run itself reports pass. It does not claim
         the two script-judged acceptance criteria; it says who judges them (line B3). -->
    <section v-if="showCompletion" class="stock-prep-gs__card stock-prep-gs__card--complete" data-testid="stock-prep-getting-started-complete">
      <h4 class="stock-prep-gs__h4">{{ bi('装好了,而且真的跑通了一次。', 'Installed, and it ran through once.') }}</h4>
      <p class="stock-prep-gs__hint">
        {{ bi(
          '接下来把它交给一线:让他们打开备料工作台,进来直接落在确认队列。',
          'Next, hand it to the floor: they open the stock-preparation workbench and land on the confirmation queue.',
        ) }}
      </p>
      <div class="stock-prep-gs__actions">
        <button type="button" data-testid="stock-prep-getting-started-copy-link" @click="copyWorkbenchLink">
          {{ linkCopyLabel === 'copy' ? bi('复制链接', 'Copy link') : bi('已复制', 'Copied') }}
        </button>
        <button type="button" data-testid="stock-prep-getting-started-copy-handoff" @click="copyHandoffMessage">
          {{ handoffCopyLabel === 'copy' ? bi('复制这三句发群里', 'Copy these three lines for the group chat') : bi('已复制', 'Copied') }}
        </button>
      </div>
      <p class="stock-prep-gs__hint">
        {{ bi(
          '正式验收的两条(数据真的写进去了 / 再同步一次不重复写)由随版本发布的脚本判定,不在本页点按钮完成。',
          'The two formal acceptance criteria (the data really landed / syncing again writes nothing twice) are judged by the release script, not by a button here.',
        ) }}
      </p>
    </section>
  </section>
</template>

<script setup lang="ts">
// BOM备料 接入向导「开始使用」(P0-4) — a二级视图寄生在既有 install tab 顶部,零 tab 结构改动。
//
// PURELY PRESENTATIONAL. This component issues NO fetch of its own — every prop below is state
// `StockPreparationInstallView.vue` already owns and already loads through its EXISTING calls
// (manifest, deployment preflight, source preflight, the install run). That is what makes "在没点任何
// 按钮之前就渲染" true for free: the parent's initial state (preflight=null, sourcePreflight=null,
// report=null) IS the wizard's "nothing run yet" rendering, and the parent's existing buttons driving
// this component's emits is what keeps D6 (source preflight never auto-runs) true without this file
// having to know the rule.
//
// STEPPER IS A MAP, NOT A GATE (G5). No button here is ever disabled by another step's state — see
// the two design-mandated cases: a `no-go` source verdict never disables ⑥'s link (nothing here reads
// the verdict for that link at all), and an outstanding `STOCK_PREP_CONFIRMATION_LEDGER_NOT_READY`
// blocker (an `http`-kind blocker) never disables ④'s "开始安装" button (its `:disabled` is
// `busy` alone).
import { computed, ref } from 'vue'
import { useLocale } from '../../../composables/useLocale'
import { copyTextToClipboard } from '../../../views/plm/plmClipboard'
import type { StockPreparationInstallDefaults, StockPreparationPreflight, StockPreparationPreflightBlocker } from '../../../services/integration/stockPreparation/installPlan'
import type { StockPreparationInstallRunReport } from '../../../services/integration/stockPreparation/installRun'
import { STOCK_PREPARATION_INSTALL_STEPS, type StockPreparationInstallStepStatus } from '../../../services/integration/stockPreparation/installRun'
import type { StockPrepSourcePreflight } from '../../../services/integration/stockPreparation/sourcePreflight'
import {
  STOCK_PREP_GETTING_STARTED_BADGE,
  STOCK_PREP_GETTING_STARTED_STEP_LABEL,
  STOCK_PREP_GETTING_STARTED_STEP_ORDER,
  stockPrepBlockerNeedsDeploymentData,
  stockPrepGettingStartedSteps,
  type StockPrepGettingStartedStepKey,
} from '../../../services/integration/stockPreparation/gettingStarted'
import {
  stockPrepBlockerPlain,
  stockPrepPermissionPlain,
  stockPrepStepOutcomeText,
} from '../../../services/integration/stockPreparation/plainLanguage'

const props = defineProps<{
  defaults: StockPreparationInstallDefaults | null
  preflight: StockPreparationPreflight | null
  preflightErrorStatus: number | null
  sourcePreflight: StockPrepSourcePreflight | null
  sourcePreflightErrorStatus: number | null
  report: StockPreparationInstallRunReport | null
  canRunInstall: boolean
  busy: boolean
}>()

const emit = defineEmits<{
  (event: 'run-preflight-check'): void
  (event: 'run-install'): void
  (event: 'navigate-stage', viewKey: string): void
}>()

const { locale } = useLocale()

function bi(zh: string, en: string): string {
  return locale.value === 'zh-CN' ? zh : en
}

const stepOrder = STOCK_PREP_GETTING_STARTED_STEP_ORDER

function stepLabel(key: StockPrepGettingStartedStepKey) {
  return STOCK_PREP_GETTING_STARTED_STEP_LABEL[key]
}

const steps = computed(() => stockPrepGettingStartedSteps({
  preflight: props.preflight,
  preflightErrorStatus: props.preflightErrorStatus,
  sourcePreflight: props.sourcePreflight,
  sourcePreflightErrorStatus: props.sourcePreflightErrorStatus,
}))

function badgeOf(key: StockPrepGettingStartedStepKey) {
  return STOCK_PREP_GETTING_STARTED_BADGE[steps.value[key]]
}

const preflightBlockers = computed<StockPreparationPreflightBlocker[]>(() =>
  Array.isArray(props.preflight?.blockers) ? (props.preflight!.blockers as StockPreparationPreflightBlocker[]) : [])

function blockerKind(blocker: StockPreparationPreflightBlocker): 'http' | 'env' {
  return stockPrepBlockerNeedsDeploymentData(blocker) ? 'env' : 'http'
}

const blockerPlain = stockPrepBlockerPlain
const permissionPlain = stockPrepPermissionPlain

/** The three permission codes §14's own defaults panel already lists — restated here, not retyped. */
const accessCodes = computed<string[]>(() => {
  const fromManifest = props.defaults?.permissions.codes
  return Array.isArray(fromManifest) && fromManifest.length > 0
    ? fromManifest
    : ['stock-prep:read', 'stock-prep:operate', 'stock-prep:admin']
})

function statusLabel(status: StockPreparationInstallStepStatus): string {
  const outcome = stockPrepStepOutcomeText(status)
  return bi(outcome.zh, outcome.en)
}

const planRows = computed(() => STOCK_PREPARATION_INSTALL_STEPS.map((descriptor) => {
  const result = props.report?.steps.find((entry) => entry.id === descriptor.id) ?? null
  return {
    descriptor,
    status: (result ? result.status : 'pending') as StockPreparationInstallStepStatus,
  }
}))

const showCompletion = computed(() => props.report?.pass === true)

// ---------------------------------------------------------------------------
// Copy buttons — every payload below is authored/constant text plus, at most, a clamped blocker
// CODE. Nothing interpolates a server message, a project number or a material value (values-free).
// ---------------------------------------------------------------------------

type CopyLabelState = 'copy' | 'copied'

function makeCopyState() {
  const state = ref<CopyLabelState>('copy')
  let timer: ReturnType<typeof setTimeout> | null = null
  async function run(text: string): Promise<void> {
    // `copyTextToClipboard`'s own fallback path calls `document.execCommand`, which some hosts (and
    // this project's jsdom test environment) do not implement at all rather than answering `false` —
    // caught here so an environment without ANY copy mechanism degrades to "nothing happened" instead
    // of an unhandled rejection out of a fire-and-forget click handler.
    let ok = false
    try {
      ok = await copyTextToClipboard(text)
    } catch {
      ok = false
    }
    if (ok) {
      state.value = 'copied'
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => { state.value = 'copy' }, 3000)
    }
  }
  return { state, run }
}

const blockerCopy = makeCopyState()
const blockerCopyLabel = blockerCopy.state
function copyBlockerForOps(blocker: StockPreparationPreflightBlocker): void {
  const plain = blockerPlain(blocker.code)
  const sentence = plain ? bi(plain.zhNext || plain.zh, plain.enNext || plain.en) : blocker.what
  void blockerCopy.run(`${blocker.code} — ${sentence}`)
}

const installTodoCopy = makeCopyState()
const installTodoCopyLabel = installTodoCopy.state
function copyInstallTodo(): void {
  void installTodoCopy.run(bi(
    '备料工作台第 4 步卡住了:请打开备料工作台 →「安装 / 体检」→ 第④步 → 点「开始安装」。重复运行是安全的。',
    'Stock-prep step 4 is stuck: please open the stock-preparation workbench → "Install / Health" → step 4 → press "Start install". Running it again is safe.',
  ))
}

const accessTodoCopy = makeCopyState()
const accessTodoCopyLabel = accessTodoCopy.state
function copyAccessTodo(): void {
  void accessTodoCopy.run(bi(
    '请帮备料工作台配一下权限:创建或确认一个角色同时持有 stock-prep:read 与 stock-prep:operate,再把要用它的人放进这个角色。角色在「角色管理」配,人在「用户管理」放。',
    'Please set up permissions for the stock-prep workbench: create or confirm one role that holds both stock-prep:read and stock-prep:operate, then add the people who need it to that role. Roles are configured under Role Management; people are added under User Management.',
  ))
}

const linkCopy = makeCopyState()
const linkCopyLabel = linkCopy.state
function copyWorkbenchLink(): void {
  void linkCopy.run(`${window.location.origin}/stock-prep`)
}

const handoffCopy = makeCopyState()
const handoffCopyLabel = handoffCopy.state
function copyHandoffMessage(): void {
  void handoffCopy.run(bi(
    '备料工作台装好了:打开 /stock-prep,进去直接是确认队列。用法:找到项目 → 从 PLM 拉进来 → 有拿不准的就逐条拿主意 → 回来再同步一次 → 导出 Excel。',
    'The stock-prep workbench is installed: open /stock-prep and you land on the confirmation queue. How to use it: find your project → pull it from PLM → decide anything the system is unsure about → sync once more → export to Excel.',
  ))
}
</script>

<style scoped>
.stock-prep-gs {
  margin: 0 0 var(--ms-space-4);
  padding: var(--ms-space-3);
  border: 1px solid var(--ms-border-light);
  border-radius: 8px;
  background: var(--ms-bg-card);
}

.stock-prep-gs__title {
  margin: 0 0 var(--ms-space-2);
  font-size: var(--ms-font-size-section-title);
  color: var(--ms-text-1);
}

.stock-prep-gs__intro {
  margin: 0 0 var(--ms-space-3);
  color: var(--ms-text-2);
  line-height: 1.6;
}

.stock-prep-gs__map {
  display: flex;
  flex-wrap: wrap;
  gap: var(--ms-space-2);
  margin: 0 0 var(--ms-space-3);
  padding: 0;
  list-style: none;
}

.stock-prep-gs__step {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border: 1px solid var(--ms-border-light);
  border-radius: 999px;
  font-size: 13px;
}

.stock-prep-gs__glyph--success { color: var(--ms-color-success); }
.stock-prep-gs__glyph--primary { color: var(--ms-color-primary); }
.stock-prep-gs__glyph--warning { color: var(--ms-color-warning); }
.stock-prep-gs__glyph--danger { color: var(--ms-color-danger); }
.stock-prep-gs__glyph--muted { color: var(--ms-text-3); }

.stock-prep-gs__badge {
  font-size: 12px;
  color: var(--ms-text-3);
}

.stock-prep-gs__badge--success { color: var(--ms-color-success); }
.stock-prep-gs__badge--primary { color: var(--ms-color-primary); }
.stock-prep-gs__badge--warning { color: var(--ms-color-warning); }
.stock-prep-gs__badge--danger { color: var(--ms-color-danger); }

.stock-prep-gs__card {
  margin: 0 0 var(--ms-space-3);
  padding: var(--ms-space-3);
  border: 1px solid var(--ms-border-light);
  border-radius: 8px;
  background: var(--ms-bg-page);
}

.stock-prep-gs__card--complete {
  border-color: var(--ms-color-success);
}

.stock-prep-gs__h4 {
  margin: 0 0 var(--ms-space-2);
  font-size: 14px;
  color: var(--ms-text-1);
}

.stock-prep-gs__hint {
  margin: 4px 0;
  color: var(--ms-text-2);
  font-size: 13px;
  line-height: 1.6;
}

.stock-prep-gs__list {
  margin: 0;
  padding-left: var(--ms-space-4);
}

.stock-prep-gs__list--plain {
  list-style: none;
  padding-left: 0;
}

.stock-prep-gs__blocker {
  margin-bottom: var(--ms-space-2);
}

.stock-prep-gs__blocker-action {
  display: block;
  margin-top: 4px;
}

.stock-prep-gs__token {
  margin-left: 6px;
  font-size: 12px;
  color: var(--ms-text-3);
}

.stock-prep-gs__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--ms-space-2);
  align-items: center;
  margin-top: var(--ms-space-2);
}

.stock-prep-gs__plan {
  margin: 0;
  padding-left: var(--ms-space-4);
}

.stock-prep-gs__plan-row {
  margin-bottom: 4px;
  font-size: 13px;
}

.stock-prep-gs__status {
  display: inline-block;
  min-width: 3.5em;
  font-weight: var(--ms-font-weight-title);
}

.stock-prep-gs__status--ok { color: var(--ms-color-success); }
.stock-prep-gs__status--skip { color: var(--ms-color-warning); }
.stock-prep-gs__status--fail { color: var(--ms-color-danger); }
.stock-prep-gs__status--pending { color: var(--ms-text-3); }
</style>
