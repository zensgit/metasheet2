<template>
  <section class="stock-prep-gs" data-testid="stock-prep-getting-started">
    <h3 class="stock-prep-gs__title">
      {{ bi('开始使用', 'Getting started') }}
      <!-- 进度 N/6 (wireframe B). `done` only — 未检查/看不到/需要别人做 are not progress. -->
      <span class="stock-prep-gs__progress" data-testid="stock-prep-getting-started-progress">
        {{ bi('进度', 'Progress') }} {{ progress.done }}/{{ progress.total }}
      </span>
    </h3>
    <p class="stock-prep-gs__intro" data-testid="stock-prep-getting-started-intro">
      {{ bi(
        '第一次接入,按顺序走完这六步,一线就能开始用了。整个过程不会碰您 ERP/K3 里的数据。任何一步都能点开看 —— 这是一张地图,不是一道闸机。',
        'First time setting up: work through these six steps in order and the floor can start using it. None of this touches your ERP/K3 data. Any step can be opened at any time — this is a map, not a gate.',
      ) }}
    </p>

    <!-- THE SIX-STEP MAP. Every badge is DERIVED (gettingStarted.ts) from data this page already has
         via props — nothing here fetches. It renders on the FIRST tick, before any button anywhere on
         this page has been pressed: `steps` computes off whatever the parent already holds (all null
         on first mount, which the derivation reads as 「未检查」 / 「? 看不到」 / 「需要别人做」,
         never as a blank and never as 「没完成」). -->
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
        <!-- WHY the badge reads what it reads, from the same envelope the badge came from. Absent
             when no evidence exists — a row says less rather than inventing a reason. -->
        <small
          v-if="evidenceOf(key)"
          class="stock-prep-gs__evidence"
          data-testid="stock-prep-getting-started-step-evidence"
        >{{ bi(evidenceOf(key)!.zh, evidenceOf(key)!.en) }}</small>
      </li>
    </ol>

    <!-- ① 接一条只读连接 — off-page by construction; the one thing this page can do is link out. -->
    <p v-if="steps['source-connect'] !== 'done'" class="stock-prep-gs__hint" data-testid="stock-prep-getting-started-step-source-connect">
      {{ bi('还没登记连接?', 'No connection registered yet?') }}
      <a href="/data-sources" data-testid="stock-prep-getting-started-link-data-sources">{{ bi('去外接数据源页 ↗', 'Go to the data-sources page ↗') }}</a>
    </p>

    <!-- ④ 建表 + 装列 — the one step this page actually DRIVES. Blockers split by fix.kind (I-8/I-9):
         an `http` blocker's next-step sentence points at THE card's own 「开始安装」 and carries the
         "重复点是安全的" reassurance; an `env` blocker gets no fix path at all — only a copy-for-ops
         line, because no input on this page can supply deployment-machine data (G6 restated for
         buttons: a control the page cannot back is absent, not disabled).

         ONE PRIMARY PER SCREEN (G1). Wireframe B puts a single ★[开始安装] at the FOOT of this card
         and gives the http rows a sentence, not a button of their own. An earlier cut put a fix
         button on every http row as well, which meant one action rendered up to three times on one
         screen — the exact "两卡长得像" confusion I-11 exists to prevent, reproduced within a card. -->
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

            <!-- http: the idempotency reassurance, next to the card's own 「开始安装」 further down
                 (I-7/I-8). Suppressed for a caller who cannot see that button: a reassurance about
                 pressing a control the reader does not have is worse than silence. -->
            <span v-if="blockerKind(blocker) === 'http'" class="stock-prep-gs__blocker-action">
              <small
                v-if="props.canRunInstall"
                class="stock-prep-gs__hint"
                data-testid="stock-prep-getting-started-blocker-safe-note"
              >{{ bi('用下面的「开始安装」补齐;重复点是安全的。', 'Use “Start install” below to supply it — pressing it again is safe.') }}</small>
            </span>

            <!-- env: NO "立即修复" button — this page has no field for deployment-machine data and
                 must never grow one (STOCK_PREP_BLOCKER_PLAIN's own discipline). Copy only. -->
            <span v-else class="stock-prep-gs__blocker-action">
              <button
                type="button"
                class="stock-prep-gs__button"
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
        <template v-if="props.canRunInstall">
          <button
            type="button"
            class="stock-prep-gs__button"
            :class="{ 'stock-prep-gs__button--primary': !showCompletion }"
            data-testid="stock-prep-getting-started-run-install"
            :disabled="props.busy"
            @click="emit('run-install')"
          >{{ bi('开始安装', 'Start install') }}</button>
        </template>
        <button
          type="button"
          class="stock-prep-gs__button"
          data-testid="stock-prep-getting-started-check-preflight"
          :disabled="props.busy"
          @click="emit('run-preflight-check')"
        >{{ bi('只检查,先不装', 'Check only, do not install') }}</button>
        <small v-if="props.canRunInstall" class="stock-prep-gs__hint">
          {{ bi('这会把该建的都建一遍。已经建好的不会重复建,重复点是安全的。', 'This creates everything that still needs creating. What already exists is not created twice — running it again is safe.') }}
        </small>
      </div>
      <div v-if="!props.canRunInstall" class="stock-prep-gs__hint" data-testid="stock-prep-getting-started-install-held">
        <p>{{ bi('这一步不归您做。建表要平台管理员来做,您这边能做的是把要做的事说清楚交出去:', 'This is not your step — creating tables is a platform administrator’s job. What you can do is hand it off with the details already spelled out:') }}</p>
        <button
          type="button"
          class="stock-prep-gs__button"
          :class="{ 'stock-prep-gs__button--primary': !showCompletion }"
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
          <!-- B2 wants a sentence beside EVERY code. A manifest that grows a code this table has no
               words for still gets one, rather than a bare token nobody can act on. -->
          <span v-if="permissionPlain(code)">{{ bi(permissionPlain(code)!.zh, permissionPlain(code)!.en) }}</span>
          <span v-else>{{ bi('这条权限的说明本页还没有;请在角色管理里按这个代码查。', 'This page has no wording for this code yet — look it up by the code in Role Management.') }}</span>
        </li>
      </ul>
      <p class="stock-prep-gs__hint">
        <!-- The two codes BY NAME (B2's own sentence). An earlier cut said 「查看和填写两项都要」,
             which is a third name for the same two things the list directly above calls
             `stock-prep:read` and `stock-prep:operate`. -->
        {{ bi('一线要能干活,stock-prep:read 和 stock-prep:operate 两个都要,少一个就只能看不能做。', 'For the floor to do the work, both stock-prep:read and stock-prep:operate are needed — missing either leaves them able to look but not act.') }}
      </p>
      <!-- Native anchors, deliberately: these leave the workbench for two platform routes, and a
           full page load is the honest thing for a destination this SPA route does not own. They are
           also what keeps this component mountable in a bare `createApp` host with no router
           installed (F3: the stock-prep specs mount exactly that way). -->
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
        class="stock-prep-gs__button"
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
        class="stock-prep-gs__button"
        data-testid="stock-prep-getting-started-go-project-board"
        @click="emit('navigate-stage', 'project-board')"
      >{{ bi('去项目备料页试一遍', 'Go try it on the project board') }}</button>
      <!-- Line B3's closing ⓘ, which BOTH source drafts dropped. The project board reads through the
           operator (per-factory) value plane, and a platform administrator with no factory of their
           own is refused there — so this button can genuinely land its most likely presser on a page
           they cannot use. Said up front rather than discovered as an unexplained refusal. -->
      <p class="stock-prep-gs__hint" data-testid="stock-prep-getting-started-first-run-tenancy">
        {{ bi(
          '提示:如果您这个账号没有归属到某一家工厂,这个项目页您自己可能打不开(它按工厂取数)。这不影响一线使用 —— 让一线的同事试这一步就行。',
          'Note: if your account does not belong to any one factory, this project page may not open for you (it reads per factory). That does not affect the floor — have a colleague on the floor run this step instead.',
        ) }}
      </p>
    </section>

    <!-- THE NINE-STEP INSTALL PLAN, as ONE LINE plus the part the page below does not say.
         (design §6.1 acceptance #5, design 流程3「向导只给一行摘要 + 链接」.)

         The install panel further down this same page ALREADY renders all nine steps with their live
         status — re-rendering the same nine rows here made one plan look like two, from the same
         data, with the same statuses. What that panel does NOT render before a run is WHY the five
         non-driven steps will report SKIP: it shows only 「尚未运行」. So this section keeps exactly
         that missing half — the held explanations, unprompted, before any button is pressed — and
         hands the status half to the one panel that owns it.

         Every sentence is the text `STOCK_PREPARATION_INSTALL_STEPS` already carries (installRun.ts);
         nothing here re-authors it, so the two surfaces cannot disagree. -->
    <section class="stock-prep-gs__card" data-testid="stock-prep-getting-started-plan">
      <h4 class="stock-prep-gs__h4">{{ bi('安装一共九步', 'The install plan is nine steps') }}</h4>
      <p class="stock-prep-gs__hint" data-testid="stock-prep-getting-started-plan-summary">
        {{ bi(
          `其中 ${drivenCount} 步「开始安装」会自己跑完;剩下 ${heldCount} 步系统不会替您做,会记成「跳过」—— 跳过不等于失败。每一步的实时状态在本页下方「开始安装 / 再体检一次」那一段里逐条列着。`,
          `${drivenCount} of them run themselves when you press Start install; the other ${heldCount} are not something the system does for you and will be recorded as SKIP — a skip is not a failure. Live per-step status is listed further down this page, under “Install, or run a health check”.`,
        ) }}
      </p>
      <h5 class="stock-prep-gs__h5">{{ bi('要人来做的那几步,以及为什么', 'The steps that need a person, and why') }}</h5>
      <ul class="stock-prep-gs__plan">
        <li
          v-for="row in heldPlanRows"
          :key="row.id"
          class="stock-prep-gs__plan-row"
          data-testid="stock-prep-getting-started-plan-held-step"
          :data-step="row.id"
        >
          <span>{{ bi(row.zh, row.en) }}</span>
          <small class="stock-prep-gs__hint" data-testid="stock-prep-getting-started-plan-held">
            {{ bi(row.heldZh || '', row.heldEn || '') }}
          </small>
        </li>
      </ul>
    </section>

    <!-- THE HAND-OFF CARD — appears once the install run itself reports pass.
         WHAT `pass` ACTUALLY MEANS, and what this card is therefore allowed to say.
         `installRun.ts` computes `pass = failed === null` and says so in its own words: "A run that
         is all SKIP still passes — held is not broken". Five of the nine steps are `driven: false`
         and can only ever SKIP in this wave. So `pass === true` means EXACTLY 「该建的都建好了,没有
         失败」 — it does not mean a project was pulled, and it certainly does not mean the two
         script-judged acceptance criteria hold. An earlier cut of this card led with 「装好了,而且
         真的跑通了一次」 while the map two screens up still read 「⑥ 拿一个项目跑一遍 ⚑ 需要别人做」:
         one page, two answers, and the confident one was the false one (design line 244「向导不冒充
         它们」, G4). The heading below now says only what `pass` supports, and names the count of what
         is still outstanding. -->
    <section v-if="showCompletion" class="stock-prep-gs__card stock-prep-gs__card--complete" data-testid="stock-prep-getting-started-complete">
      <h4 class="stock-prep-gs__h4" data-testid="stock-prep-getting-started-complete-verdict">
        {{ bi(
          `该建的都建好了,没有失败。还有 ${outstandingSteps} 步要人来做 —— 上面每条写了是什么。`,
          `Everything that needed creating is created, with no failures. ${outstandingSteps} step(s) still need a person — each one is spelled out above.`,
        ) }}
      </h4>
      <p class="stock-prep-gs__hint">
        <!-- 「落在哪个 tab」 IS A FACT ABOUT THE SHELL, not a wish: `landsOnStockPrepProjectBoard`
             sends a read+operate holder to the project board, and the confirmation queue is where a
             read-only account lands. This card is copied into a customer group chat, so it names
             neither — it names the address and what to do there. -->
        {{ bi(
          '接下来把它交给一线:把下面这个地址发给他们,让他们用自己的账号打开。',
          'Next, hand it to the floor: send them the address below and have them open it with their own account.',
        ) }}
      </p>
      <div class="stock-prep-gs__actions">
        <button type="button" class="stock-prep-gs__button stock-prep-gs__button--primary" data-testid="stock-prep-getting-started-copy-handoff" @click="copyHandoffMessage">
          {{ handoffCopyLabel === 'copy' ? bi('复制一段发群里', 'Copy a message for the group chat') : bi('已复制', 'Copied') }}
        </button>
        <button type="button" class="stock-prep-gs__button" data-testid="stock-prep-getting-started-copy-link" @click="copyWorkbenchLink">
          {{ linkCopyLabel === 'copy' ? bi('复制链接', 'Copy link') : bi('已复制', 'Copied') }}
        </button>
      </div>
      <p class="stock-prep-gs__hint">
        {{ bi(
          '还没做的:拿一个项目实际跑一遍(第⑥步,本页不替您跑)。正式验收的两条(数据真的写进去了 / 再同步一次不重复写)由随版本发布的脚本判定,不在本页点按钮完成。',
          'Not done yet: actually running one project through it (step ⑥ — this page does not run it for you). The two formal acceptance criteria (the data really landed / syncing again writes nothing twice) are judged by the release script, not by a button here.',
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
import { computed, onBeforeUnmount, ref } from 'vue'
import { useLocale } from '../../../composables/useLocale'
import { copyTextToClipboard } from '../../../views/plm/plmClipboard'
import type { StockPreparationInstallDefaults, StockPreparationPreflight, StockPreparationPreflightBlocker } from '../../../services/integration/stockPreparation/installPlan'
import type { StockPreparationInstallRunReport } from '../../../services/integration/stockPreparation/installRun'
import { STOCK_PREPARATION_INSTALL_STEPS } from '../../../services/integration/stockPreparation/installRun'
import type { StockPrepSourcePreflight } from '../../../services/integration/stockPreparation/sourcePreflight'
import {
  STOCK_PREP_GETTING_STARTED_BADGE,
  STOCK_PREP_GETTING_STARTED_STEP_LABEL,
  STOCK_PREP_GETTING_STARTED_STEP_ORDER,
  stockPrepBlockerNeedsDeploymentData,
  stockPrepGettingStartedEvidence,
  stockPrepGettingStartedProgress,
  stockPrepGettingStartedSteps,
  type StockPrepGettingStartedBinding,
  type StockPrepGettingStartedStepKey,
} from '../../../services/integration/stockPreparation/gettingStarted'
import {
  stockPrepBlockerPlain,
  stockPrepPermissionPlain,
} from '../../../services/integration/stockPreparation/plainLanguage'

const props = defineProps<{
  defaults: StockPreparationInstallDefaults | null
  preflight: StockPreparationPreflight | null
  /** The DEPLOYMENT-PREFLIGHT read's own status slot — not the page-wide error banner's. */
  preflightErrorStatus: number | null
  sourcePreflight: StockPrepSourcePreflight | null
  sourcePreflightErrorStatus: number | null
  /** The source-binding panel's server answer, `null` when this page has none (→「? 看不到」). */
  binding: StockPrepGettingStartedBinding | null
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

const derivationInput = computed(() => ({
  preflight: props.preflight,
  preflightErrorStatus: props.preflightErrorStatus,
  sourcePreflight: props.sourcePreflight,
  sourcePreflightErrorStatus: props.sourcePreflightErrorStatus,
  binding: props.binding,
}))

const steps = computed(() => stockPrepGettingStartedSteps(derivationInput.value))
const progress = computed(() => stockPrepGettingStartedProgress(steps.value))

function badgeOf(key: StockPrepGettingStartedStepKey) {
  return STOCK_PREP_GETTING_STARTED_BADGE[steps.value[key]]
}

function evidenceOf(key: StockPrepGettingStartedStepKey) {
  return stockPrepGettingStartedEvidence(key, derivationInput.value)
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

/**
 * The five `driven: false` steps and the four driven ones, straight off the shared descriptor table.
 * Counted rather than typed, so a step that changes sides in `installRun.ts` changes here with it.
 */
const heldPlanRows = computed(() => STOCK_PREPARATION_INSTALL_STEPS.filter((descriptor) => !descriptor.driven))
const heldCount = computed(() => heldPlanRows.value.length)
const drivenCount = computed(() => STOCK_PREPARATION_INSTALL_STEPS.length - heldPlanRows.value.length)

/**
 * How many steps still need a person AFTER a passing run. A run's SKIPs are exactly those steps, so
 * the report's own count is used when there is one; before/without a report the structural count is
 * the honest answer. This is the number the hand-off card quotes instead of claiming a trial run.
 */
const outstandingSteps = computed(() => (
  typeof props.report?.skipCount === 'number' && props.report.skipCount > 0 ? props.report.skipCount : heldCount.value
))

const showCompletion = computed(() => props.report?.pass === true)

// ---------------------------------------------------------------------------
// Copy buttons — every payload below is authored/constant text plus, at most, a clamped blocker
// CODE. Nothing interpolates a server message, a project number or a material value (values-free).
// ---------------------------------------------------------------------------

type CopyLabelState = 'copy' | 'copied'

/** Every timer this component schedules, cancelled on unmount (#3365「卸载即作废」). */
const copyResetTimers = new Set<ReturnType<typeof setTimeout>>()
onBeforeUnmount(() => {
  for (const timer of copyResetTimers) clearTimeout(timer)
  copyResetTimers.clear()
})

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
      if (timer) {
        clearTimeout(timer)
        copyResetTimers.delete(timer)
      }
      timer = setTimeout(() => {
        state.value = 'copy'
        if (timer) copyResetTimers.delete(timer)
      }, 3000)
      copyResetTimers.add(timer)
    }
  }
  return { state, run }
}

const blockerCopy = makeCopyState()
const blockerCopyLabel = blockerCopy.state
/**
 * I-9: an `env` blocker's payload carries the route's OWN `fix.run` line VERBATIM. That line is the
 * thing the person on the deployment machine actually executes, and rewriting it is rewriting the
 * fix — the same discipline the disclosure further down this page already applies to it. It is a
 * server-authored deployment instruction (an env var name and a path shape), never response data
 * about a customer's rows, so it stays values-free.
 */
function copyBlockerForOps(blocker: StockPreparationPreflightBlocker): void {
  const plain = blockerPlain(blocker.code)
  const sentence = plain ? bi(plain.zhNext || plain.zh, plain.enNext || plain.en) : blocker.what
  const run = blocker.fix?.run
  void blockerCopy.run(run ? `${blocker.code} — ${sentence}\n${run}` : `${blocker.code} — ${sentence}`)
}

const installTodoCopy = makeCopyState()
const installTodoCopyLabel = installTodoCopy.state
/**
 * 线框 F's hand-off payload. It names WHICH blockers are outstanding (by code + the committed
 * sentence for that code), because "第 4 步卡住了" alone makes the recipient re-run the check the
 * sender just ran. Codes and committed prose only — never `blocker.what`, which is server text.
 */
function copyInstallTodo(): void {
  const lines = preflightBlockers.value.map((blocker) => {
    const plain = blockerPlain(blocker.code)
    return plain ? `· ${blocker.code} — ${bi(plain.zh, plain.en)}` : `· ${blocker.code}`
  })
  const head = bi(
    '备料工作台第 4 步(建表 + 装列)还没过。请平台管理员打开备料工作台 →「安装 / 体检」→ 最上面的「开始使用」→ 第④步 → 点「开始安装」。重复运行是安全的。',
    'Stock-prep step 4 (create tables and install columns) has not passed. Please have a platform administrator open the stock-preparation workbench → "Install / Health" → "Getting started" at the top → step ④ → press "Start install". Running it again is safe.',
  )
  const detail = lines.length > 0
    ? `\n${bi('还差这些:', 'Outstanding:')}\n${lines.join('\n')}`
    : ''
  void installTodoCopy.run(`${head}${detail}`)
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
/**
 * THE ONE PAYLOAD THAT LEAVES THIS SYSTEM. It gets pasted into a customer group chat, so every
 * sentence has to survive being read by someone who cannot check it against the page.
 * It therefore does NOT name a landing tab — which tab a person lands on depends on their own
 * permissions (`landsOnStockPrepProjectBoard`: read+operate → 项目备料页; read-only → 确认队列), and
 * an earlier cut asserted 「进去直接是确认队列」 for everyone, which is wrong for exactly the audience
 * this message is addressed to. It also does not claim the deployment "装好了" — this component
 * cannot know that a project has ever run through it.
 */
function copyHandoffMessage(): void {
  void handoffCopy.run(bi(
    '备料工作台可以用了:用自己的账号打开 /stock-prep。用法:找到您的项目 → 从 PLM 拉进来 → 有拿不准的就逐条拿主意 → 回来再同步一次 → 导出 Excel。打不开或看不到项目,说明权限还没配到您头上,找管理员。',
    'The stock-prep workbench is ready to use: open /stock-prep with your own account. How to use it: find your project → pull it in from PLM → decide anything the system is unsure about → sync once more → export to Excel. If it will not open, or shows no projects, your account has not been granted access yet — ask an administrator.',
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
.stock-prep-gs__glyph--info { color: var(--ms-color-info); }
.stock-prep-gs__glyph--warning { color: var(--ms-color-warning); }
.stock-prep-gs__glyph--danger { color: var(--ms-color-danger); }
.stock-prep-gs__glyph--muted { color: var(--ms-text-3); }

.stock-prep-gs__badge {
  font-size: 12px;
  color: var(--ms-text-3);
}

.stock-prep-gs__badge--success { color: var(--ms-color-success); }
.stock-prep-gs__badge--info { color: var(--ms-color-info); }
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

/* G1 —— 每屏一个主操作位. Exactly ONE filled `--ms-color-primary` button exists per rendering of this
   wizard: 「开始安装」 when the reader can run it, otherwise 「复制一份待办给平台管理员」, which is
   that reader's one real action. Everything else is a plain bordered button or a text link.
   (The four per-step run-status colours that used to sit here went with the duplicated nine-step
   list: status is rendered once, by the install panel further down this page.) */
.stock-prep-gs__button {
  padding: 4px 12px;
  border: 1px solid var(--ms-border);
  border-radius: 4px;
  background: var(--ms-bg-card);
  color: var(--ms-text-1);
  cursor: pointer;
}

.stock-prep-gs__button:disabled {
  color: var(--ms-text-3);
  cursor: not-allowed;
}

.stock-prep-gs__button--primary {
  border-color: var(--ms-color-primary);
  background: var(--ms-color-primary);
  color: #fff;
}

.stock-prep-gs__progress {
  margin-left: var(--ms-space-2);
  font-size: 13px;
  font-weight: normal;
  color: var(--ms-text-2);
}

.stock-prep-gs__evidence {
  color: var(--ms-text-2);
}

.stock-prep-gs__h5 {
  margin: var(--ms-space-2) 0 var(--ms-space-1);
  font-size: 13px;
  color: var(--ms-text-2);
}
</style>
