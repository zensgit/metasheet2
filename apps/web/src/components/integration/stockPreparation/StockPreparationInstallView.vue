<template>
  <div class="stock-prep-install" data-testid="stock-prep-install">
    <p class="stock-prep-install__intro" data-testid="stock-prep-install-intro">
      {{ bi(
        '安装 = 预检(查)+ 建表(补)+ 验收(验)。本页把清单里的默认值摆出来给您确认,再按自举脚本的顺序把该建的建起来 —— 全程是选择题,没有填空题。',
        'Install = preflight (inspect) + bootstrap (provision) + acceptance (verify). This page lays out the manifest\'s defaults for you to confirm, then provisions what it can in the bootstrap script\'s order. Every question here has a default answer; none is a blank.',
      ) }}
    </p>
    <p class="stock-prep-install__intro stock-prep-install__intro--muted" data-testid="stock-prep-install-edit-note">
      {{ bi(
        '显示名(表名、字段名)与选项集属于客户词汇,可后续由管理员在多维表中调整 —— 系统没有任何一处按显示名寻址,改名零影响。本页不提供改名入口。',
        'Display names (tables, fields) and option sets are the customer\'s vocabulary and are adjusted later by an admin in the multitable itself — nothing in the system addresses anything by display name, so renaming has no effect. This page offers no rename control.',
      ) }}
    </p>

    <p v-if="errorStatus !== null" class="stock-prep-install__error" data-testid="stock-prep-install-error">
      {{ bi('读取失败,HTTP ', 'Read failed, HTTP ') }}{{ errorStatus }}
    </p>

    <!-- ===================================================================
         §14 DEFAULTS FOR CONFIRMATION — rendered FROM the served manifest.
         Nothing below is typed here: an id this page restated would be an id
         a deployment could disagree with, which is the incident the manifest
         line exists to close.
         =================================================================== -->
    <section v-if="defaults" class="stock-prep-install__card" data-testid="stock-prep-install-defaults">
      <h3 class="stock-prep-install__h3">
        {{ bi('默认配置(请确认)', 'Defaults for confirmation') }}
      </h3>
      <p class="stock-prep-install__app" data-testid="stock-prep-install-app">
        <strong>{{ defaults.displayName }}</strong>
        <code>{{ defaults.appId }}</code>
        <span v-if="defaults.version">v{{ defaults.version }}</span>
      </p>
      <p v-if="defaults.valueStatement" class="stock-prep-install__value" data-testid="stock-prep-install-value-statement">
        {{ defaults.valueStatement }}
      </p>

      <h4 class="stock-prep-install__h4">{{ bi('受管表', 'Managed tables') }}</h4>
      <table class="stock-prep-install__table">
        <thead>
          <tr>
            <th>{{ bi('显示名', 'Display name') }}</th>
            <th>{{ bi('表标识 objectId', 'objectId') }}</th>
            <th>{{ bi('列数', 'Columns') }}</th>
            <th>{{ bi('建表调用', 'Ensure') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="object in defaults.objects" :key="object.id" data-testid="stock-prep-install-object-row">
            <td>
              <span data-testid="stock-prep-install-object-name">{{ object.zhName }}</span>
              <em class="stock-prep-install__tag">{{ postureLabel(object.namePosture) }}</em>
            </td>
            <td>
              <code v-if="object.objectId" data-testid="stock-prep-install-object-id">{{ object.objectId }}</code>
              <code v-else-if="object.objectIdNamespace" data-testid="stock-prep-install-object-namespace">
                {{ object.objectIdNamespace }}*
              </code>
              <em class="stock-prep-install__tag stock-prep-install__tag--locked">
                {{ postureLabel(object.objectIdPosture) }}
              </em>
              <small v-if="object.objectIdSource" class="stock-prep-install__hint">
                {{ bi('来源:', 'from: ') }}{{ object.objectIdSource }}
              </small>
            </td>
            <td>{{ object.columnCount ?? '—' }}</td>
            <td><code>{{ object.ensurePath || '—' }}</code></td>
          </tr>
        </tbody>
      </table>

      <h4 class="stock-prep-install__h4">{{ bi('权限码', 'Permission codes') }}</h4>
      <p class="stock-prep-install__codes" data-testid="stock-prep-install-permissions">
        <code v-for="code in defaults.permissions.codes" :key="code">{{ code }}</code>
        <em class="stock-prep-install__tag stock-prep-install__tag--locked">
          {{ postureLabel(defaults.permissions.posture) }}
        </em>
      </p>
      <p class="stock-prep-install__hint" data-testid="stock-prep-install-permission-holders">
        {{ defaults.permissions.automaticHolders.length === 0
          ? bi('零自动持有:安装只把这三个码种子化,持有者为零。没有任何既有 scope 会自动变成备料 scope。',
               'Zero automatic holders: installing seeds the three codes and grants them to nobody. No existing scope silently becomes a stock-prep scope.')
          : defaults.permissions.automaticHolders.join(', ') }}
      </p>

      <h4 class="stock-prep-install__h4">{{ bi('配置面(部署期数据)', 'Config surfaces (deployment data)') }}</h4>
      <ul class="stock-prep-install__list">
        <li
          v-for="surface in defaults.configSurfaces"
          :key="surface.id"
          data-testid="stock-prep-install-config-surface"
        >
          <strong>{{ surface.name }}</strong>
          <em class="stock-prep-install__tag stock-prep-install__tag--data">
            {{ bi('部署期数据 · 永不入库', 'deployment data · never stored') }}
          </em>
          <span v-for="envVar in surface.envVars" :key="envVar" class="stock-prep-install__envvar">
            <code>{{ envVar }}</code>
          </span>
          <small class="stock-prep-install__hint">{{ surface.note }}</small>
        </li>
      </ul>

      <h4 class="stock-prep-install__h4">{{ bi('围栏姿态', 'Fence posture') }}</h4>
      <p class="stock-prep-install__hint" data-testid="stock-prep-install-no-switch">
        {{ bi(
          '只展示,无开关 —— 安装器不得武装其中任何一项。未设 / 关闭就是正确姿态,不是故障。',
          'Displayed, never switched — no installer may arm any of these. Unset / closed IS the correct posture, not a fault.',
        ) }}
        <span data-testid="stock-prep-install-installer-may-modify">
          installerMayModify={{ defaults.posture.installerMayModify }}
        </span>
      </p>
      <ul class="stock-prep-install__list">
        <li
          v-for="entry in defaults.posture.entries"
          :key="entry.id"
          data-testid="stock-prep-install-posture-entry"
        >
          <code>{{ entry.id }}</code>
          <em class="stock-prep-install__tag stock-prep-install__tag--locked">{{ entry.expectedState }}</em>
          <code v-if="entry.envVar" class="stock-prep-install__envvar">{{ entry.envVar }}</code>
          <small class="stock-prep-install__hint">{{ entry.what }}</small>
        </li>
      </ul>

      <h4 class="stock-prep-install__h4">{{ bi('验收判据', 'Acceptance criteria') }}</h4>
      <ul class="stock-prep-install__list" data-testid="stock-prep-install-acceptance">
        <li v-for="criterion in defaults.acceptance.criteria" :key="criterion.id">
          <code>{{ criterion.id }}</code>
          <small class="stock-prep-install__hint">{{ criterion.statement }}</small>
        </li>
      </ul>
      <p v-if="defaults.acceptance.script" class="stock-prep-install__hint">
        {{ bi('由此脚本判定:', 'Verified by: ') }}<code>{{ defaults.acceptance.script }}</code>
      </p>
    </section>

    <!-- ===================================================================
         PREFLIGHT — 查. Read tier, provisions nothing; every blocker prints
         the route's own paste-able fix line.
         =================================================================== -->
    <section class="stock-prep-install__card" data-testid="stock-prep-install-preflight">
      <h3 class="stock-prep-install__h3">{{ bi('部署预检', 'Deployment preflight') }}</h3>
      <button
        type="button"
        data-testid="stock-prep-install-preflight-run"
        :disabled="busy"
        @click="loadPreflight"
      >
        {{ bi('运行预检', 'Run preflight') }}
      </button>

      <template v-if="preflight">
        <p class="stock-prep-install__ready" data-testid="stock-prep-install-preflight-result">
          {{ preflight.ready
            ? bi('就绪:没有阻断项。', 'Ready: no blockers.')
            : bi('未就绪,阻断项 ', 'Not ready, blockers: ') + preflight.blockers.length }}
        </p>

        <!-- The env is POLLUTED and the server withheld what is in it. A count, never the content:
             the whole point of the server-side filter is that a non-namespace allowlist entry has no
             path to this page, so the page can only ever say how many there were. -->
        <p
          v-if="pollutedAllowlistCount > 0"
          class="stock-prep-install__hint"
          data-testid="stock-prep-install-allowlist-polluted"
        >
          {{ bi(
            '沙箱写允许清单里有 ' + pollutedAllowlistCount + ' 项不在沙箱命名空间内,已由服务端扣下,不在本页显示 —— 请到部署机上检查该 env。',
            pollutedAllowlistCount + ' entr(y/ies) in the sandbox write allowlist sit outside the sandbox namespace. The server withheld them and this page never receives them — check that env on the deployment machine.',
          ) }}
        </p>

        <ul class="stock-prep-install__list">
          <li
            v-for="blocker in preflight.blockers"
            :key="blocker.code"
            data-testid="stock-prep-install-blocker"
          >
            <code>{{ blocker.code }}</code>
            <small class="stock-prep-install__hint">{{ blocker.what }}</small>
            <!-- VERBATIM. The operator copies this line; rewriting it would be rewriting the fix. -->
            <pre v-if="blocker.fix" class="stock-prep-install__run" data-testid="stock-prep-install-blocker-fix"><code>{{ blocker.fix.run }}</code></pre>
          </li>
        </ul>

        <h4 class="stock-prep-install__h4">{{ bi('围栏姿态(服务端读数)', 'Fence posture (server reading)') }}</h4>
        <ul class="stock-prep-install__list">
          <li
            v-for="fence in postureRows"
            :key="fence.id"
            data-testid="stock-prep-install-preflight-posture"
          >
            <code>{{ fence.id }}</code>
            <em class="stock-prep-install__tag stock-prep-install__tag--locked">{{ fence.state }}</em>
            <code v-if="fence.envVar" class="stock-prep-install__envvar">{{ fence.envVar }}</code>
          </li>
        </ul>
      </template>
    </section>

    <!-- ===================================================================
         INSTALL RUN — 补. Existing routes, existing gates, bootstrap order.
         =================================================================== -->
    <section class="stock-prep-install__card" data-testid="stock-prep-install-run-panel">
      <h3 class="stock-prep-install__h3">{{ bi('安装 / 体检', 'Install / health run') }}</h3>

      <button
        v-if="canRun"
        type="button"
        data-testid="stock-prep-install-run"
        :disabled="busy"
        @click="startInstall"
      >
        {{ bi('开始安装(幂等,可重复运行)', 'Start install (idempotent, re-runnable)') }}
      </button>
      <p v-else class="stock-prep-install__hint" data-testid="stock-prep-install-run-denied">
        {{ bi(
          '建表与装列属平台管理员档(受管表创建 = 改结构)。您可以看默认值与预检结果,运行由平台管理员执行。',
          'Provisioning managed tables and installing pack columns is the platform-admin tier (creating a managed table is a schema change). You can read the defaults and the preflight; a platform admin runs it.',
        ) }}
      </p>

      <ol class="stock-prep-install__steps">
        <li
          v-for="row in stepRows"
          :key="row.descriptor.id"
          class="stock-prep-install__step"
          data-testid="stock-prep-install-step"
          :data-step="row.descriptor.id"
          :data-status="row.status"
        >
          <span class="stock-prep-install__status" :class="`stock-prep-install__status--${row.status}`">
            {{ statusLabel(row.status) }}
          </span>
          <span class="stock-prep-install__step-name">{{ bi(row.descriptor.zh, row.descriptor.en) }}</span>

          <!-- A HELD step is human work outstanding, not a broken install. Its reason is rendered
               with the same weight as an OK line — hiding it is how the outstanding work goes
               unnoticed until acceptance mysteriously 409s. -->
          <small
            v-if="row.result"
            class="stock-prep-install__hint"
            data-testid="stock-prep-install-step-reason"
          >{{ reasonText(row) }}</small>
          <small v-else class="stock-prep-install__hint">{{ routesOf(row.descriptor) }}</small>

          <span
            v-for="(value, key) in (row.result ? row.result.detail : {})"
            :key="key"
            class="stock-prep-install__detail"
            data-testid="stock-prep-install-step-detail"
          >{{ key }}={{ value }}</span>

          <pre
            v-for="fix in (row.result ? row.result.fixes : [])"
            :key="fix"
            class="stock-prep-install__run"
            data-testid="stock-prep-install-step-fix"
          ><code>{{ fix }}</code></pre>
        </li>
      </ol>

      <p v-if="report" class="stock-prep-install__summary" data-testid="stock-prep-install-summary">
        {{ bi('完成 ', 'completed ') }}{{ report.completedSteps }}/{{ report.totalSteps }}
        · OK {{ report.okCount }}
        · SKIP {{ report.skipCount }}
        · FAIL {{ report.failCount }}
        · {{ report.pass ? bi('无失败', 'no failure') : bi('停在 ', 'stopped at ') + report.failedStepId }}
      </p>
    </section>
  </div>
</template>

<script setup lang="ts">
// BOM备料 安装页 — the page a customer admin opens to see the app's defaults, confirm them, and
// watch the system create and verify what it can.
//
// THREE DISCIPLINES, all inherited rather than invented here:
//
//  1. §14 (multitable-application-model-20260830.md) — "安装页展示默认配置,由客户确认". Names are
//     shown (adjusted later in the multitable), objectIds and permission codes are shown and NOT
//     editable, config surfaces are marked deployment data, and the four fences are shown WITH NO
//     SWITCH. Every value comes from the served manifest; this file restates none of them.
//  2. THE BOOTSTRAP'S STEP ORDER (scripts/ops/stock-prep-acceptance-bootstrap.mjs STEP_PLAN),
//     imported as data from installRun.ts — including the load-bearing placement of the confirmation
//     queue BEFORE acceptance.
//  3. R-11 — a control the caller cannot exercise is ABSENT. The install run drives four
//     platform-admin routes, so its button renders only for a platform admin; a `stock-prep:admin`
//     holder gets the defaults, the preflight and the fixes, and is told who runs it.
//
// VALUES-FREE. The page renders manifest constants, ids, counts, blocker codes, closed reason codes
// and the preflight's own paste-able fix lines. No customer business value and no credential can
// reach it: the manifest is a committed file that names env VARS, and the preflight is the server's
// own values-free evidence.
import { computed, onMounted, ref } from 'vue'
import { useLocale } from '../../../composables/useLocale'
import { useAuth } from '../../../composables/useAuth'
import type { IntegrationScope } from '../../../services/integration/workbench'
import {
  buildStockPreparationInstallDefaults,
  readStockPreparationAppManifest,
  readStockPreparationPreflight,
  StockPreparationInstallReadError,
  type StockPreparationInstallDefaults,
  type StockPreparationConfirmationPosture,
  type StockPreparationPreflight,
} from '../../../services/integration/stockPreparation/installPlan'
import {
  STOCK_PREPARATION_INSTALL_STEPS,
  createStockPreparationInstallApi,
  runStockPreparationInstall,
  type StockPreparationInstallReason,
  type StockPreparationInstallRunReport,
  type StockPreparationInstallStepDescriptor,
  type StockPreparationInstallStepResult,
  type StockPreparationInstallStepStatus,
} from '../../../services/integration/stockPreparation/installRun'
import { canRunStockPrepInstall } from '../../../services/integration/stockPreparation/workbenchAccess'

const props = defineProps<{ scope: IntegrationScope }>()

const { locale } = useLocale()
const auth = useAuth()

function bi(zh: string, en: string): string {
  return locale.value === 'zh-CN' ? zh : en
}

const canRun = computed(() => canRunStockPrepInstall((permission) => auth.hasPermission(permission)))

const busy = ref(false)
const errorStatus = ref<number | null>(null)
const defaults = ref<StockPreparationInstallDefaults | null>(null)
const preflight = ref<StockPreparationPreflight | null>(null)
const results = ref<StockPreparationInstallStepResult[]>([])
const report = ref<StockPreparationInstallRunReport | null>(null)

/** Only an HTTP status reaches state — a server message could carry a value. */
function recordError(error: unknown): void {
  errorStatus.value = error instanceof StockPreparationInstallReadError ? error.status : 0
}

async function run(task: () => Promise<void>): Promise<void> {
  busy.value = true
  errorStatus.value = null
  try {
    await task()
  } catch (error) {
    recordError(error)
  } finally {
    busy.value = false
  }
}

async function loadDefaults(): Promise<void> {
  await run(async () => {
    defaults.value = buildStockPreparationInstallDefaults(await readStockPreparationAppManifest())
  })
}

async function loadPreflight(): Promise<void> {
  await run(async () => {
    preflight.value = await readStockPreparationPreflight(props.scope)
  })
}

async function startInstall(): Promise<void> {
  results.value = []
  report.value = null
  await run(async () => {
    const api = createStockPreparationInstallApi(props.scope)
    report.value = await runStockPreparationInstall(api, (step) => {
      // Render each step AS IT LANDS: a run that stops on step 2 must still show step 1's outcome.
      results.value = [...results.value, step]
    })
    // The run's own preflight reads are the freshest reading, so mirror the final one into the panel.
    await loadPreflight()
  })
}

onMounted(() => { void loadDefaults() })

/**
 * How many configured sandbox write-allowlist entries the SERVER withheld for sitting outside the
 * sandbox objectId namespace. A count is all that exists on this side — the entries themselves never
 * leave the plugin, which is the point of the filter in stock-preparation-preflight.cjs.
 */
const pollutedAllowlistCount = computed(() => {
  const dropped = preflight.value?.checks?.sandboxWriteAuthorization?.droppedNonNamespaceEntries
  return typeof dropped === 'number' && Number.isFinite(dropped) && dropped > 0 ? dropped : 0
})

/** The observed fence states from the preflight, as rows. */
const postureRows = computed(() => {
  const posture = preflight.value?.posture
  if (!posture || typeof posture !== 'object') return []
  return Object.keys(posture).map((id) => ({
    id,
    state: posture[id]?.state ?? '—',
    envVar: posture[id]?.envVar ?? null,
  }))
})

/** Every planned step, with its result once it has one. Pending steps are still listed. */
const stepRows = computed(() => STOCK_PREPARATION_INSTALL_STEPS.map((descriptor) => {
  const result = results.value.find((entry) => entry.id === descriptor.id) ?? null
  return {
    descriptor,
    result,
    status: (result ? result.status : 'pending') as StockPreparationInstallStepStatus,
  }
}))

function routesOf(descriptor: StockPreparationInstallStepDescriptor): string {
  return descriptor.routes.join(' · ')
}

function statusLabel(status: StockPreparationInstallStepStatus): string {
  if (status === 'ok') return 'OK'
  if (status === 'skip') return 'SKIP'
  if (status === 'fail') return 'FAIL'
  return bi('待运行', 'pending')
}

function postureLabel(posture: StockPreparationConfirmationPosture): string {
  if (posture === 'confirm') return bi('可确认', 'confirm')
  if (posture === 'no-switch') return bi('无开关', 'no switch')
  return bi('不可改', 'read-only')
}

/** The closed reason vocabulary -> prose. The only place a reason code becomes a sentence. */
const REASON_TEXT: Record<StockPreparationInstallReason, [string, string]> = {
  PREFLIGHT_READY: ['预检就绪:零阻断。', 'Preflight ready: zero blockers.'],
  PREFLIGHT_ROUTE_ABSENT: [
    '该部署早于预检路由,跳过而非失败(旧,不是坏)。',
    'This deployment predates the preflight route — skipped, not failed (old, not broken).',
  ],
  PREFLIGHT_BLOCKERS_PROVISIONED_BELOW: [
    '阻断项都是建表调用,由下面的「受管表建表」补齐;修复行已列在下方,原样可粘。',
    'Every blocker is an ensure call that the managed-tables step below makes; the paste-able fix lines are listed here verbatim.',
  ],
  PREFLIGHT_BLOCKERS_DEPLOYMENT_DATA: [
    '有阻断项需要部署机上的 env / 数据文件,安装页没有也不应有 env 输入框 —— 按下方修复行处理后重跑。',
    'A blocker needs env / a data file on the deployment machine. This page has no env field and must never grow one — apply the fix lines below and re-run.',
  ],
  PREFLIGHT_READ_FAILED: ['预检读取失败。', 'The preflight read failed.'],
  LEDGER_ENSURE_FAILED: ['确认账本建表失败(该路由是平台管理员档)。', 'Provisioning the confirmation ledger failed (that route is platform-admin).'],
  PACK_CATALOG_READ_FAILED: ['客户包目录读取失败。', 'Reading the customer-pack catalog failed.'],
  PACK_CATALOG_EMPTY: [
    '客户包未配置(目录为空,fail-closed)。沙箱表的 objectId 只能来自客户包声明的 targetObjectId,不得自拟 —— 这是人工待办,不是安装故障。',
    'No customer pack is configured (empty catalog, fail-closed). The sandbox objectId may only come from a pack\'s declared targetObjectId and must never be invented — human work outstanding, not a broken install.',
  ],
  PACK_CATALOG_AMBIGUOUS: [
    '目录里不止一个客户包;本页不替管理员选装哪一个,用自举脚本按 MS_PACK_ID 指定。',
    'The catalog holds more than one customer pack; this page does not choose for you — name one with MS_PACK_ID in the bootstrap script.',
  ],
  SANDBOX_ENSURE_FAILED: [
    '沙箱目标表建表被拒(objectId 必须落在 plm_stock_preparation_sandbox 命名空间内)。',
    'The sandbox target ensure was refused (the objectId must sit inside the plm_stock_preparation_sandbox namespace).',
  ],
  MANAGED_TABLES_READY: ['受管表就位(幂等,重复运行是空操作)。', 'Managed tables in place (idempotent; a re-run is a no-op).'],
  PACK_DRY_RUN_FAILED: ['客户包 dry-run 失败。', 'The customer-pack dry-run failed.'],
  PACK_DRY_RUN_CONFLICTS: [
    '这些字段已带别人的归属戳,安装器拒绝覆盖 —— 先看冲突,再决定。',
    'These fields already carry a different ownership stamp and the installer refuses to overwrite one — review the conflict first.',
  ],
  PACK_INSTALL_FAILED: ['客户包装列失败。', 'The customer-pack install failed.'],
  PACK_INSTALL_NOT_IDEMPOTENT: [
    '第二次安装又建了列 —— 安装本应幂等,这是缺陷,不是配置问题。',
    'The second install created fields again — install is supposed to be idempotent, so this is a defect, not a configuration problem.',
  ],
  PACK_INSTALLED: ['客户包已装列,第二次运行是空操作(幂等已验证)。', 'Pack columns installed; the second run was a no-op (idempotence verified).'],
  MALFORMED_RESPONSE: [
    '收到 2xx,但内容不是本接口的应答体 —— 多半是网关/登录页替服务器答了。这一步按失败处理:报「表已建好」而表并不存在,比报失败更糟。',
    'A 2xx arrived carrying something that is not this API\'s envelope — usually a gateway or a sign-in page answering in the server\'s place. Treated as a failure: reporting a table that does not exist is worse than reporting a failure.',
  ],
  HELD_FOR_OPERATOR: ['', ''],
  RECHECK_READY: ['复检就绪:零阻断。', 'Recheck ready: zero blockers.'],
  RECHECK_STILL_BLOCKED: [
    '复检仍有阻断项 —— 剩下的是人工待办,修复行如下。',
    'The recheck still reports blockers — what remains is human work; the fix lines follow.',
  ],
}

function reasonText(row: { descriptor: StockPreparationInstallStepDescriptor; result: StockPreparationInstallStepResult | null }): string {
  if (!row.result) return ''
  if (row.result.reason === 'HELD_FOR_OPERATOR') {
    return bi(row.descriptor.heldZh || '', row.descriptor.heldEn || '')
  }
  const [zh, en] = REASON_TEXT[row.result.reason]
  return bi(zh, en)
}

defineExpose({ loadDefaults, loadPreflight, startInstall })
</script>

<style scoped>
.stock-prep-install__intro {
  margin: 0 0 var(--ms-space-3);
  color: var(--ms-text-2);
  font-size: 13px;
  line-height: 1.6;
}

.stock-prep-install__intro--muted {
  color: var(--ms-text-3);
}

.stock-prep-install__error {
  margin: 0 0 var(--ms-space-3);
  color: var(--el-color-danger, #c45656);
  font-size: 13px;
}

.stock-prep-install__card {
  margin-bottom: var(--ms-space-4);
  padding: var(--ms-space-3);
  border: 1px solid var(--ms-border-light);
  border-radius: 8px;
  background: var(--ms-bg-page);
}

.stock-prep-install__h3 {
  margin: 0 0 var(--ms-space-2);
  font-size: var(--ms-font-size-section-title);
  color: var(--ms-text-1);
}

.stock-prep-install__h4 {
  margin: var(--ms-space-3) 0 var(--ms-space-2);
  font-size: 13px;
  color: var(--ms-text-1);
}

.stock-prep-install__app {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--ms-space-2);
  margin: 0 0 var(--ms-space-2);
}

.stock-prep-install__value {
  margin: 0 0 var(--ms-space-2);
  color: var(--ms-text-2);
  font-size: 13px;
  line-height: 1.6;
}

.stock-prep-install__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.stock-prep-install__table th,
.stock-prep-install__table td {
  padding: var(--ms-space-2);
  border-bottom: 1px solid var(--ms-border-light);
  text-align: left;
  vertical-align: top;
}

.stock-prep-install__list {
  margin: 0;
  padding-left: var(--ms-space-4);
  font-size: 13px;
  line-height: 1.7;
}

.stock-prep-install__codes {
  display: flex;
  flex-wrap: wrap;
  gap: var(--ms-space-2);
  margin: 0 0 var(--ms-space-2);
}

.stock-prep-install__hint {
  display: block;
  color: var(--ms-text-3);
  font-size: 12px;
  line-height: 1.6;
}

.stock-prep-install__tag {
  display: inline-flex;
  align-items: center;
  margin-left: var(--ms-space-2);
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--el-fill-color-light);
  color: var(--ms-text-3);
  font-size: 11px;
  font-style: normal;
}

.stock-prep-install__tag--locked {
  color: var(--ms-text-2);
}

.stock-prep-install__tag--data {
  color: var(--ms-text-2);
}

.stock-prep-install__envvar {
  margin-left: var(--ms-space-2);
  font-size: 12px;
}

.stock-prep-install__run {
  margin: 4px 0 0;
  padding: var(--ms-space-2);
  overflow-x: auto;
  border-radius: 6px;
  background: var(--el-fill-color-light);
  font-size: 12px;
}

.stock-prep-install__ready {
  margin: var(--ms-space-2) 0;
  font-size: 13px;
  color: var(--ms-text-2);
}

.stock-prep-install__steps {
  margin: var(--ms-space-3) 0 0;
  padding-left: var(--ms-space-4);
}

.stock-prep-install__step {
  margin-bottom: var(--ms-space-2);
  font-size: 13px;
}

.stock-prep-install__status {
  display: inline-block;
  min-width: 56px;
  font-weight: var(--ms-font-weight-title);
}

.stock-prep-install__status--ok {
  color: var(--el-color-success, #529b2e);
}

.stock-prep-install__status--skip {
  color: var(--el-color-warning, #b88230);
}

.stock-prep-install__status--fail {
  color: var(--el-color-danger, #c45656);
}

.stock-prep-install__status--pending {
  color: var(--ms-text-3);
}

.stock-prep-install__step-name {
  margin-right: var(--ms-space-2);
  color: var(--ms-text-1);
}

.stock-prep-install__detail {
  display: inline-block;
  margin-right: var(--ms-space-2);
  color: var(--ms-text-3);
  font-size: 12px;
}

.stock-prep-install__summary {
  margin: var(--ms-space-3) 0 0;
  font-size: 13px;
  color: var(--ms-text-2);
}
</style>
