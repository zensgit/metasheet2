<!--
  W4-1 wizard shell (Wave 4 onboarding design-lock 2026-07-21, RATIFIED §3/§6/§7/§9 W4-1):
  seven-step setup-readiness navigation. Pure display component — props in
  (tr + derived step rows + values-free summary + viewer role), emits out
  (`select-section` for canonical section deep links, `reload`). It fetches nothing,
  writes nothing, and holds no wizard state (readiness is recomputed by the parent on
  every entry — OD-W4-7: no persistent wizard state machine).

  Red lines carried by this template (each has a negative spec):
  - R2: every remediation is either a `select-section` emit (parent routes through
    `selectAdminSection`, the canonical query-form section switch) or a canonical
    path/query href (step① platform-admin link → base-aware /admin/users: the href
    carries the Vite/router BASE_URL so sub-path deploys stay operable, and clicks
    SPA-navigate through an optionally injected router). ZERO hash-form navigation
    (`href="#..."`) anywhere.
  - L210 预览入口: every step row shows a preview entry — ①-⑥ jump to the in-wizard ⑦
    card (the single page renders ⑦ inline; the full preview derivation is the W4-2
    slice per §9), ⑦ is the preview surface itself. No navigation involved (no href).
  - §3① role contract: the step① remediation branches on `viewerIsPlatformAdmin`
    (same client signal family as UserManagementView.vue's `adminAllowed` =
    useAuth().hasAdminAccess()); a delegated attendance:admin NEVER sees the
    /admin/users entry (it would 403) — they get contact-your-platform-admin copy.
  - §4.5(iii): step⑥'s remediation is 「查看投递历史」 — never 「配置接收范围」-style
    copy, and `unsupported` never renders as 「未配置」/「去配置」.
  - §3.2/charter L232: `unknown` renders as 「未知，去核查」, never as complete;
    load errors render fail-closed.
  - §3⑦/R4: step⑦ is preview-only; the manual activation checklist ALWAYS lists ④
    and ⑥'s three signals, offers no confirm/activate action, and never implies
    anything is already enabled (no 「已启用」/"enabled" completion claims).
-->
<template>
  <div
    ref="rootRef"
    class="setup-readiness"
    data-attendance-setup-readiness
    role="region"
    aria-labelledby="attendance-setup-readiness-title"
  >
    <div class="setup-readiness__header">
      <div class="setup-readiness__header-copy">
        <span class="setup-readiness__eyebrow">{{ tr('First-time setup', '首次启用') }}</span>
        <h4 id="attendance-setup-readiness-title">{{ tr('Setup readiness (seven steps)', '启用准备（七步向导）') }}</h4>
        <p class="setup-readiness__intro">
          {{ tr(
            'Read-only readiness for the seven setup steps. All configuration happens in its own admin section — this wizard never writes or activates anything.',
            '只读展示七个启用步骤的就绪状态。所有配置仍在各自管理区块完成——本向导不会写入或启用任何配置。',
          ) }}
        </p>
      </div>
      <div class="setup-readiness__header-actions">
        <span
          v-if="gatingSummaryLabel"
          class="setup-readiness__progress"
          data-setup-gating-progress
        >
          {{ gatingSummaryLabel }}
        </span>
        <button
          class="setup-readiness__reload"
          type="button"
          data-setup-reload
          :disabled="loadState === 'loading'"
          @click="emit('reload')"
        >
          {{ loadState === 'loading' ? tr('Loading...', '加载中...') : tr('Reload', '重新加载') }}
        </button>
      </div>
    </div>

    <div
      v-if="loadState === 'loading' && steps.length === 0"
      class="setup-readiness__empty"
      data-setup-loading
    >
      {{ tr('Loading readiness...', '正在加载就绪状态...') }}
    </div>
    <div
      v-else-if="loadState === 'error'"
      class="setup-readiness__empty setup-readiness__empty--error"
      data-setup-load-error
    >
      <strong>{{ tr('Readiness unknown — verify', '就绪状态未知，去核查') }}</strong>
      <p>
        {{ tr(
          'Loading setup readiness failed. Unknown status is never treated as complete; reload to re-check.',
          '就绪状态加载失败。未知状态不会被视为已完成；请重新加载核查。',
        ) }}
      </p>
    </div>
    <div
      v-else-if="steps.length === 0"
      class="setup-readiness__empty"
      data-setup-idle
    >
      {{ tr('Readiness has not been loaded yet.', '尚未加载就绪状态。') }}
    </div>

    <ol v-else class="setup-readiness__steps" data-setup-steps>
      <li
        v-for="(step, index) in steps"
        :key="step.stepId"
        class="setup-readiness__step"
        :data-setup-step="step.stepId"
      >
        <div class="setup-readiness__step-index" aria-hidden="true">{{ index + 1 }}</div>
        <div class="setup-readiness__step-body">
          <div class="setup-readiness__step-head">
            <strong class="setup-readiness__step-title">{{ stepTitle(step.stepId) }}</strong>
            <span
              class="setup-readiness__status"
              :class="`setup-readiness__status--${statusTone(step.status)}`"
              :data-setup-step-status="step.status"
            >
              {{ statusLabel(step.status) }}
            </span>
            <span class="setup-readiness__scope" :data-setup-step-scope="step.scope">
              {{ step.scope === 'deployment' ? tr('Deployment-wide', '部署级') : tr('This org', '本组织') }}
            </span>
          </div>

          <p class="setup-readiness__reason" data-setup-step-reason>{{ reasonLabel(step.reason) }}</p>

          <div class="setup-readiness__meta">
            <span data-setup-step-impact>
              {{ impactLabel(step) }}
            </span>
            <span data-setup-step-effective-time>
              {{ tr('Planned effect', '计划生效') }}: {{ effectiveTimeLabel(step.effectiveTime) }}
            </span>
            <span v-if="detailLabel(step.stepId)" data-setup-step-detail>
              {{ detailLabel(step.stepId) }}
            </span>
            <!-- L210 预览入口 — in-wizard jump to the ⑦ card (no href, R2); ⑦ is the preview itself. -->
            <button
              v-if="step.stepId !== 'preview'"
              class="setup-readiness__preview-entry"
              type="button"
              data-setup-step-preview-entry="jump"
              @click="jumpToPreviewStep"
            >
              {{ tr('Preview entry: step 7 (this page)', '预览入口：⑦ 影响范围（本页）') }}
            </button>
            <span v-else data-setup-step-preview-entry="self">
              {{ tr('Preview entry: this step (read-only preview)', '预览入口：本步（只读预览）') }}
            </span>
          </div>

          <!-- ⑥ three unmerged notify signals (§3⑥ P2-2: 不得合并) -->
          <ul
            v-if="step.notifySignals"
            class="setup-readiness__notify"
            data-setup-notify-signals
          >
            <li data-setup-notify-runtime>
              {{ tr('Delivery runtime (deployment)', '投递运行期（部署级）') }}:
              {{ deliveryRuntimeLabel(step.notifySignals.deliveryRuntime) }}
            </li>
            <li data-setup-notify-binding>
              {{ tr('Recipient binding (this org)', '收件人绑定（本组织）') }}:
              {{ recipientBindingLabel(step.notifySignals.orgRecipientBinding) }}
            </li>
            <li data-setup-notify-scope>
              {{ tr('Recipient scope (per-org / per-recipient)', '接收范围（按组织/按收件人）') }}:
              {{ tr('not supported in this version — no action available', '当前版本不支持，无可用操作') }}
            </li>
          </ul>

          <!-- 修复动作 (L210) — canonical navigation only (R2) -->
          <div class="setup-readiness__actions">
            <template v-if="step.stepId === 'attendance-admin-user-access'">
              <a
                v-if="viewerIsPlatformAdmin"
                class="setup-readiness__action setup-readiness__action--link"
                data-setup-remedy="user-access-admin-link"
                :href="adminUsersHref"
                @click="openAdminUsers"
              >
                {{ tr('Open user management to create members', '前往用户管理创建人员') }}
              </a>
              <span
                v-else
                class="setup-readiness__contact"
                data-setup-remedy="user-access-contact-admin"
              >
                {{ tr(
                  'Members are maintained by a platform administrator. Contact your platform administrator to create or sync people.',
                  '组织成员由平台管理员维护——请联系平台管理员创建或同步人员。',
                ) }}
              </span>
            </template>
            <button
              v-else-if="remedySection(step.stepId)"
              class="setup-readiness__action"
              type="button"
              :data-setup-remedy="step.stepId"
              @click="emit('select-section', remedySection(step.stepId)!)"
            >
              {{ remedyLabel(step.stepId) }}
            </button>
          </div>

          <!-- ⑦ manual canonical activation checklist (§3⑦: ④⑥ always listed; never implies enabled) -->
          <div
            v-if="step.stepId === 'preview' && summary"
            class="setup-readiness__checklist"
            data-setup-checklist
          >
            <strong>{{ tr('Manual activation checklist', '人工启用清单') }}</strong>
            <p class="setup-readiness__checklist-note">
              {{ tr(
                'A real person must confirm or complete each item in its own admin section. This wizard performs no activation.',
                '以下事项需真人在对应管理区块确认或完成；本向导不执行任何启用动作。',
              ) }}
            </p>
            <ul>
              <li data-setup-checklist-item="punch-policy">
                <span>{{ tr('Punch method policy (deployment)', '打卡方式策略（部署级）') }}: {{ punchPolicyChecklistLabel(summary.punchPolicyPosture) }}</span>
                <button
                  class="setup-readiness__action setup-readiness__action--inline"
                  type="button"
                  data-setup-checklist-remedy="punch-policy"
                  @click="emit('select-section', 'attendance-admin-settings')"
                >
                  {{ tr('Review in Settings', '前往设置人工确认') }}
                </button>
              </li>
              <li data-setup-checklist-item="delivery-runtime">
                <span>{{ tr('Notification delivery runtime (deployment)', '通知投递运行期（部署级）') }}: {{ deliveryRuntimeLabel(summary.notify.deliveryRuntime) }}</span>
              </li>
              <li data-setup-checklist-item="recipient-binding">
                <span>{{ tr('Recipient binding (this org)', '收件人绑定（本组织）') }}: {{ recipientBindingLabel(summary.notify.orgRecipientBinding) }}</span>
                <button
                  class="setup-readiness__action setup-readiness__action--inline"
                  type="button"
                  data-setup-checklist-remedy="delivery-history"
                  @click="emit('select-section', 'attendance-admin-notification-deliveries')"
                >
                  {{ tr('View delivery history', '查看投递历史') }}
                </button>
              </li>
              <li data-setup-checklist-item="recipient-scope">
                <span>{{ tr('Recipient scope (per-org / per-recipient)', '接收范围（按组织/按收件人）') }}: {{ tr('not supported in this version — no action available', '当前版本不支持，无可用操作') }}</span>
              </li>
            </ul>
          </div>

          <!-- §6.3 / charter §4.6: four-category contextual help, values-free -->
          <details class="setup-readiness__help" data-setup-help>
            <summary>{{ tr('Help for this step', '本步帮助') }}</summary>
            <dl>
              <dt>{{ tr('When this applies', '适用于什么场景') }}</dt>
              <dd>{{ helpFor(step.stepId).scenario }}</dd>
              <dt>{{ tr('Who is affected after saving, and when', '保存后影响谁、何时生效') }}</dt>
              <dd>{{ helpFor(step.stepId).impact }}</dd>
              <dt>{{ tr('Common failures and recovery', '常见失败与如何恢复') }}</dt>
              <dd>{{ helpFor(step.stepId).recovery }}</dd>
              <dt>{{ tr('Where to see the basis / audit records', '查看计算依据/审计记录') }}</dt>
              <dd>{{ helpFor(step.stepId).audit }}</dd>
            </dl>
          </details>
        </div>
      </li>
    </ol>
  </div>
</template>

<script setup lang="ts">
import { computed, inject, ref } from 'vue'
import { routerKey } from 'vue-router'
import type {
  AttendanceSetupReadinessDeliveryRuntime,
  AttendanceSetupReadinessEffectiveTime,
  AttendanceSetupReadinessOrgRecipientBinding,
  AttendanceSetupReadinessReasonKey,
  AttendanceSetupReadinessResponse,
  AttendanceSetupReadinessStatus,
  AttendanceSetupReadinessStepResult,
  AttendanceSetupStepId,
  AttendancePunchPolicyPosture,
} from './attendanceSetupReadiness'
import {
  ATTENDANCE_SETUP_ADMIN_USERS_ROUTE_PATH,
  resolveAttendanceSetupAdminUsersHref,
  type AttendanceSetupReadinessLoadState,
} from './useAttendanceSetupReadiness'

type TranslateFn = (en: string, zh: string) => string

const props = defineProps<{
  tr: TranslateFn
  steps: AttendanceSetupReadinessStepResult[]
  summary: AttendanceSetupReadinessResponse | null
  loadState: AttendanceSetupReadinessLoadState
  viewerIsPlatformAdmin: boolean
}>()

const emit = defineEmits<{
  'select-section': [id: string]
  reload: []
}>()

const tr = props.tr

const rootRef = ref<HTMLElement | null>(null)

/** §3①/R2: the platform-admin deep link must stay operable under a `VITE_BASE_PATH` sub-path
 *  deploy (the router history base IS `BASE_URL` — main.ts `createWebHistory(import.meta.env.BASE_URL)`),
 *  so the anchor href carries the base. The router is injected OPTIONALLY (null default): the shell
 *  stays a pure display component mountable without vue-router (specs/harness), falling back to
 *  plain-anchor navigation; when the host app has a router, clicks SPA-navigate (no full reload). */
const router = inject(routerKey, null)
const adminUsersHref = computed(() => resolveAttendanceSetupAdminUsersHref(import.meta.env.BASE_URL))

function openAdminUsers(event: MouseEvent): void {
  if (!router) return // no router in host → default anchor navigation (href is still base-aware)
  event.preventDefault()
  void router.push(ATTENDANCE_SETUP_ADMIN_USERS_ROUTE_PATH)
}

/** L210 预览入口 for steps ①-⑥: an in-wizard jump to the ⑦ preview card (rendered inline on this
 *  single page; the full preview derivation is the W4-2 slice, §9). Not a navigation — no href,
 *  no hash (R2). `scrollIntoView` is optional-called for non-browser mounts (jsdom). */
function jumpToPreviewStep(): void {
  const target = rootRef.value?.querySelector<HTMLElement>('[data-setup-step="preview"]')
  target?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
}

/** Charter §4.5 L202-208 step names, verbatim (⑦ per lock §3: preview-only wording). */
function stepTitle(stepId: AttendanceSetupStepId): string {
  switch (stepId) {
    case 'attendance-admin-user-access':
      return tr('1. Sync or create organization members', '① 同步或创建组织人员')
    case 'attendance-admin-groups':
      return tr('2. Create attendance groups and pick members', '② 创建考勤组并选择人员')
    case 'attendance-admin-shifts':
      return tr('3. Choose the shift system and shift templates', '③ 选择班制与班次模板')
    case 'attendance-admin-settings':
      return tr('4. Configure allowed punch methods', '④ 配置允许的打卡方式')
    case 'attendance-admin-approval-flows':
      return tr('5. Link approval flows', '⑤ 关联审批流程')
    case 'attendance-admin-notification-deliveries':
      return tr('6. Configure notification channels and recipient scope', '⑥ 配置通知渠道与接收范围')
    case 'preview':
      return tr('7. Preview impact scope (preview-ready)', '⑦ 预览影响范围（preview-ready）')
  }
}

/** Seven-value domain rendering (§3.2). `unknown` is fail-closed 「未知，去核查」 (charter L232);
 *  `unsupported` is 「当前版本不支持」 — NEVER 「未配置」/「去配置」 (§4.5(iii)). */
function statusLabel(status: AttendanceSetupReadinessStatus): string {
  switch (status) {
    case 'ready':
      return tr('Done', '已完成')
    case 'missing':
      return tr('Incomplete', '未完成')
    case 'forbidden':
      return tr('No permission', '无权限查看')
    case 'unknown':
      return tr('Unknown — verify', '未知，去核查')
    case 'manual_review_required':
      return tr('Needs manual confirmation', '需人工确认')
    case 'unsupported':
      return tr('Not supported in this version', '当前版本不支持')
    case 'db_not_ready':
      return tr('Database not ready', '数据库未就绪')
  }
}

function statusTone(status: AttendanceSetupReadinessStatus): string {
  switch (status) {
    case 'ready':
      return 'success'
    case 'missing':
    case 'manual_review_required':
      return 'warning'
    case 'forbidden':
    case 'db_not_ready':
      return 'danger'
    case 'unknown':
    case 'unsupported':
      return 'info'
  }
}

/** Values-free reason copy — reason keys only, never raw values (§4.2). */
function reasonLabel(reason: AttendanceSetupReadinessReasonKey): string {
  switch (reason) {
    case 'ready':
      return tr('This step is complete.', '本步已完成。')
    case 'org_active_member_count_zero':
      return tr('The organization has no active members yet.', '组织暂无有效成员。')
    case 'group_or_membership_missing':
      return tr('Missing attendance groups, or no group has members yet.', '缺少考勤组，或考勤组暂无成员。')
    case 'shift_count_zero':
      return tr('No shifts exist yet.', '暂无班次。')
    case 'scheduled_shift_group_without_rotation_rules':
      return tr('Scheduled-shift groups exist but no active rotation rules.', '存在排班制考勤组，但没有启用的轮班规则。')
    case 'punch_policy_default':
      return tr('Pending confirmation: the platform default punch policy is in use.', '待确认：当前使用平台默认打卡策略。')
    case 'punch_policy_customized':
      return tr('The punch policy has been customized.', '打卡策略已自定义。')
    case 'punch_policy_unknown':
      return tr('The punch policy state could not be determined.', '打卡策略状态无法确定。')
    case 'approval_flow_count_zero':
      return tr('No active approval flows yet.', '暂无启用的审批流。')
    case 'recipient_scope_unsupported':
      return tr(
        'Per-org / per-recipient recipient scope is not supported in this version; delivery history is read-only.',
        '按组织/按收件人接收范围在当前版本不支持；投递历史为只读。',
      )
    case 'preview_ready':
      return tr('Steps 1/2/3/5 are all complete — the read-only impact preview is available.', '①②③⑤ 均已完成，可进行只读影响范围预览。')
    case 'preview_blocked_by_prior_step':
      return tr('A required prior step (1/2/3/5) is not complete yet.', '前序必备步骤（①②③⑤）存在未完成项。')
    case 'forbidden':
      return tr('You do not have permission to view this readiness surface.', '无权限查看该就绪面。')
    case 'db_not_ready':
      return tr('Attendance tables are not ready in this deployment.', '本部署的考勤数据表尚未就绪。')
  }
}

/** §3.2 four-state effective-time contract: `scheduled` always shows its effectiveAt;
 *  `undeterminable` renders 「无法确定」 — never omitted, never guessed. */
function effectiveTimeLabel(effectiveTime: AttendanceSetupReadinessEffectiveTime | undefined): string {
  if (!effectiveTime) return tr('unknown', '未知')
  switch (effectiveTime.posture) {
    case 'immediate':
      return tr('immediate after saving', '保存后立即生效')
    case 'scheduled':
      return `${tr('scheduled', '定时生效')}: ${effectiveTime.effectiveAt ?? tr('unknown', '未知')}`
    case 'manual_activation':
      return tr('requires manual activation', '需人工启用')
    case 'undeterminable':
      return tr('cannot be determined', '无法确定')
  }
}

/** L210「影响人数」, scope-honest per step (values-free, counts only):
 *  - deployment-scoped ④/⑥: the affected population is the WHOLE deployment — no per-org count is
 *    shown (an org-scoped number under a 「部署级」 chip would understate the blast radius);
 *  - ⑦: derived from the ①/② counts (lock §3⑦ 影响人数=①②计数派生);
 *  - other org-scoped steps: the org-active-member count, labeled for what it IS
 *    (「本组织有效成员」), not presented as a per-step affected-set claim. */
function impactLabel(step: AttendanceSetupReadinessStepResult): string {
  if (step.scope === 'deployment') {
    return `${tr('Affected people', '影响人数')}: ${tr('the whole deployment (deployment-level setting)', '整个部署（部署级设置）')}`
  }
  const s = props.summary
  const members = s ? `${s.orgActiveMemberCount}` : tr('unknown', '未知')
  if (step.stepId === 'preview') {
    const groups = s ? `${s.groupsWithMembers}` : tr('unknown', '未知')
    return `${tr('Affected people (derived from step 1/2 counts)', '影响人数（①②计数派生）')}: ${tr('active org members', '本组织有效成员')} ${members} · ${tr('groups with members', '有成员的组')} ${groups}`
  }
  return `${tr('Affected people (active org members)', '影响人数（本组织有效成员）')}: ${members}`
}

/** Values-free per-step count details (missing-item context, counts only). */
function detailLabel(stepId: AttendanceSetupStepId): string {
  const s = props.summary
  if (!s) return ''
  switch (stepId) {
    case 'attendance-admin-groups':
      return `${tr('Groups', '考勤组')} ${s.groupCount} · ${tr('with members', '有成员的组')} ${s.groupsWithMembers}`
    case 'attendance-admin-shifts':
      return `${tr('Shifts', '班次')} ${s.shiftCount} · ${tr('scheduled-shift groups', '排班制组')} ${s.scheduledShiftGroupCount} · ${tr('active rotation rules', '启用轮班规则')} ${s.activeRotationRuleCount}`
    case 'attendance-admin-approval-flows':
      return `${tr('Active approval flows', '启用审批流')} ${s.approvalFlowCount}`
    default:
      return ''
  }
}

/** Canonical section targets for the per-step remediation (R2: parent routes them through
 *  `selectAdminSection`). Step① is role-branched in the template (never a section here —
 *  `attendance-admin-user-access` manages permissions, not membership, §3.3); ⑦ has none. */
function remedySection(stepId: AttendanceSetupStepId): string | null {
  switch (stepId) {
    case 'attendance-admin-groups':
      return 'attendance-admin-groups'
    case 'attendance-admin-shifts':
      return 'attendance-admin-shifts'
    case 'attendance-admin-settings':
      return 'attendance-admin-settings'
    case 'attendance-admin-approval-flows':
      return 'attendance-admin-approval-flows'
    case 'attendance-admin-notification-deliveries':
      return 'attendance-admin-notification-deliveries'
    default:
      return null
  }
}

/** §4.5(iii): step⑥'s label is 「查看投递历史」 — a read-only history surface. It must NEVER be
 *  「配置接收范围」-style copy (that capability does not exist; offering it would be a fake
 *  remediation). */
function remedyLabel(stepId: AttendanceSetupStepId): string {
  switch (stepId) {
    case 'attendance-admin-groups':
      return tr('Configure attendance groups', '去配置考勤组')
    case 'attendance-admin-shifts':
      return tr('Configure shifts', '去配置班次')
    case 'attendance-admin-settings':
      return tr('Review punch policy in Settings', '前往设置人工确认打卡策略')
    case 'attendance-admin-approval-flows':
      return tr('Configure approval flows', '去配置审批流')
    case 'attendance-admin-notification-deliveries':
      return tr('View delivery history', '查看投递历史')
    default:
      return ''
  }
}

function deliveryRuntimeLabel(runtime: AttendanceSetupReadinessDeliveryRuntime): string {
  switch (runtime) {
    case 'ready':
      return tr('runtime ready', '运行期就绪')
    case 'not_ready':
      return tr('not ready — the scheduler needs to be started by operations', '未就绪——需运维启用调度器')
    case 'unknown':
      return tr('unknown — verify (job registration cannot be proven)', '未知，去核查（无法证明投递作业已注册）')
  }
}

function recipientBindingLabel(binding: AttendanceSetupReadinessOrgRecipientBinding): string {
  return binding.hasAnyBoundRecipient
    ? `${tr('bound recipients', '已绑定收件人')}: ${binding.boundRecipientCount}`
    : tr('no bound recipients yet', '暂无收件人绑定')
}

/** ④ checklist wording — states a posture, never an activation result. */
function punchPolicyChecklistLabel(posture: AttendancePunchPolicyPosture): string {
  switch (posture) {
    case 'default':
      return tr('pending confirmation — platform default policy in use', '待确认——当前使用平台默认策略')
    case 'customized':
      return tr('customized — have a person verify it in Settings', '已自定义——仍需真人在设置面核对')
    case 'unknown':
      return tr('unknown — verify', '未知，去核查')
  }
}

interface SetupStepHelp {
  scenario: string
  impact: string
  recovery: string
  audit: string
}

/** §6.3 / charter §4.6: four fixed help categories per step, values-free (no customer identifiers,
 *  real users, tokens, hosts, log paths, or secrets — counts/enums/generic guidance only). */
function helpFor(stepId: AttendanceSetupStepId): SetupStepHelp {
  switch (stepId) {
    case 'attendance-admin-user-access':
      return {
        scenario: tr('The organization needs at least one active member before attendance can be set up; members come from platform user management or directory sync.', '启用考勤前组织需要至少一名有效成员；成员来自平台用户管理或目录同步。'),
        impact: tr('Created or synced members count toward this org immediately and become selectable in later steps.', '人员创建或同步后立即计入本组织有效成员，并可在后续步骤中选择。'),
        recovery: tr('A zero member count usually means people were not created, directory sync is not connected, or members were deactivated; fix in user management or directory sync, then reload.', '成员数为 0 通常是人员未创建、目录未联通或成员已停用；在用户管理或目录同步处理后重新加载本页。'),
        audit: tr('Member changes are visible in platform admin audit and the directory sync page.', '人员变更可在平台管理审计与目录同步页查看。'),
      }
    case 'attendance-admin-groups':
      return {
        scenario: tr('Attendance groups decide who participates in attendance and under which rules.', '考勤组决定哪些人参与考勤、按哪套规则计算。'),
        impact: tr('Group and membership changes take effect immediately for the members involved.', '考勤组与成员变更保存后对相关成员立即生效。'),
        recovery: tr('A group without members does not complete this step; add people in Group members.', '仅有考勤组但无成员不算完成；请在「分组成员」中补充人员。'),
        audit: tr('Group changes are recorded in the audit logs section.', '考勤组变更记录见「审计日志」区块。'),
      }
    case 'attendance-admin-shifts':
      return {
        scenario: tr('Fixed-shift, scheduled-shift, and free-time groups all need shifts; scheduled-shift groups also need active rotation rules.', '固定班、排班制与自由工时都需要班次；排班制考勤组还需要启用的轮班规则。'),
        impact: tr('Saved shifts are available immediately; rotation rules apply to scheduled-shift groups.', '班次保存后立即可用；轮班规则作用于排班制考勤组。'),
        recovery: tr('If scheduled-shift groups exist without active rotation rules, this step stays incomplete; add rules under Rotation Rules.', '存在排班制考勤组但无启用轮班规则时本步保持未完成；请在「轮班规则」中补充。'),
        audit: tr('Shift and rotation-rule changes are recorded in the audit logs section.', '班次与轮班规则变更记录见「审计日志」区块。'),
      }
    case 'attendance-admin-settings':
      return {
        scenario: tr('Punch method constraints (location, network, frequency) are a deployment-level policy.', '打卡方式约束（位置、网络、频率）是部署级策略。'),
        impact: tr('Saving settings affects the whole deployment; a person must confirm the policy — this wizard never confirms it for you.', '设置保存后对整个部署生效；策略需真人确认——本向导不会代为确认。'),
        recovery: tr('While the platform default policy is in use, this step shows needs-manual-confirmation; review and save in Settings.', '使用平台默认策略期间本步显示「需人工确认」；请在「设置」面核对并保存。'),
        audit: tr('Settings saves are recorded in the audit logs section.', '设置保存记录见「审计日志」区块。'),
      }
    case 'attendance-admin-approval-flows':
      return {
        scenario: tr('Makeup punch, leave, and overtime requests route through approval flows.', '补卡、请假、加班等申请需经审批流流转。'),
        impact: tr('Once an approval flow is active, new requests follow it.', '审批流启用后，新申请按该流程流转。'),
        recovery: tr('Without an active flow requests cannot route; create one under Approval Flows.', '无启用审批流时申请无法流转；请在「审批流」中创建。'),
        audit: tr('Flow changes and approval history are visible in their sections.', '审批流变更与审批记录见相应区块。'),
      }
    case 'attendance-admin-notification-deliveries':
      return {
        scenario: tr('Notification channel enablement is decided per deployment (each channel stays off unless operations turns it on); per-org recipient scope is not supported in this version.', '通知渠道按部署逐项启用（默认关闭，由运维逐个开启）；按组织接收范围在当前版本不支持。'),
        impact: tr('Delivery depends on the deployment runtime and on recipients being bound via the directory.', '投递依赖部署运行期与收件人目录绑定。'),
        recovery: tr('If the runtime is not ready or no recipient is bound, notifications will not deliver; this page only offers the read-only delivery history.', '运行期未就绪或无收件人绑定时通知不会送达；此处仅提供只读投递历史。'),
        audit: tr('The delivery-history section shows the real delivery state.', '「通知投递」区块展示真实投递状态。'),
      }
    case 'preview':
      return {
        scenario: tr('Preview-ready means steps 1/2/3/5 are all complete.', '预览就绪 = ①②③⑤ 全部完成。'),
        impact: tr('The preview is a read-only derivation — it writes nothing.', '预览为只读推演，不写入任何配置。'),
        recovery: tr('If a prior required step is incomplete, finish it first; steps 4/6 are advisory and appear on the manual checklist instead.', '前序必备步骤未完成时请先完成；④⑥ 为提示项，列入人工启用清单。'),
        audit: tr('Checklist items are completed by a person in their own admin sections, which keep their own audit records.', '清单事项由真人在对应管理区块完成，各区块自有审计记录。'),
      }
  }
}

/** Header progress chip: gating steps (①②③⑤) done vs total — advisory ④⑥ excluded (§3.2). */
const gatingSummaryLabel = computed(() => {
  if (props.steps.length === 0) return ''
  const gating = props.steps.filter((step) =>
    ['attendance-admin-user-access', 'attendance-admin-groups', 'attendance-admin-shifts', 'attendance-admin-approval-flows'].includes(step.stepId),
  )
  if (gating.length === 0) return ''
  const done = gating.filter((step) => step.status === 'ready').length
  return `${tr('Required steps ready', '必备步骤就绪')} ${done}/${gating.length}`
})
</script>

<style scoped>
.setup-readiness {
  display: grid;
  gap: var(--ms-space-4);
}

.setup-readiness__header {
  display: flex;
  justify-content: space-between;
  gap: var(--ms-space-4);
  align-items: flex-start;
  flex-wrap: wrap;
}

.setup-readiness__header-copy {
  min-width: 0;
  max-width: 640px;
}

.setup-readiness__eyebrow {
  display: block;
  margin-bottom: var(--ms-space-1);
  color: var(--ms-text-3);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.setup-readiness__header-copy h4 {
  margin: 0;
  color: var(--ms-text-1);
  font-size: var(--ms-font-size-section-title);
  font-weight: var(--ms-font-weight-title);
}

.setup-readiness__intro {
  margin: var(--ms-space-1) 0 0;
  color: var(--ms-text-2);
  font-size: 12px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.setup-readiness__header-actions {
  display: flex;
  align-items: center;
  gap: var(--ms-space-2);
  flex-wrap: wrap;
}

.setup-readiness__progress {
  padding: 4px 10px;
  border: 1px solid var(--ms-border-light);
  border-radius: 999px;
  background: var(--ms-bg-card);
  color: var(--ms-text-2);
  font-size: 12px;
  white-space: nowrap;
}

.setup-readiness__reload {
  padding: 6px 12px;
  border: 1px solid var(--ms-border);
  border-radius: var(--ms-radius-sm);
  background: var(--ms-bg-card);
  color: var(--ms-text-1);
  font-size: 12px;
  cursor: pointer;
}

.setup-readiness__reload:disabled {
  color: var(--ms-text-3);
  cursor: default;
}

.setup-readiness__empty {
  padding: var(--ms-space-5);
  border: 1px dashed var(--ms-border);
  border-radius: var(--ms-radius-md);
  color: var(--ms-text-2);
  font-size: 13px;
  text-align: center;
}

.setup-readiness__empty--error strong {
  display: block;
  margin-bottom: var(--ms-space-1);
  color: var(--ms-color-danger);
}

.setup-readiness__empty--error p {
  margin: 0;
  line-height: 1.5;
}

.setup-readiness__steps {
  display: grid;
  gap: var(--ms-space-3);
  margin: 0;
  padding: 0;
  list-style: none;
}

.setup-readiness__step {
  display: flex;
  gap: var(--ms-space-3);
  padding: var(--ms-space-4);
  border: 1px solid var(--ms-border-light);
  border-radius: var(--ms-radius-md);
  background: var(--ms-bg-card);
}

.setup-readiness__step-index {
  flex: none;
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  border-radius: 999px;
  background: var(--ms-bg-page);
  border: 1px solid var(--ms-border-light);
  color: var(--ms-text-2);
  font-size: 13px;
  font-weight: 600;
}

.setup-readiness__step-body {
  display: grid;
  gap: var(--ms-space-2);
  min-width: 0;
  flex: 1;
}

.setup-readiness__step-head {
  display: flex;
  align-items: center;
  gap: var(--ms-space-2);
  flex-wrap: wrap;
}

.setup-readiness__step-title {
  color: var(--ms-text-1);
  font-size: 13px;
  overflow-wrap: anywhere;
}

.setup-readiness__status {
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
  border: 1px solid var(--ms-border-light);
  color: var(--ms-text-2);
  background: var(--ms-bg-page);
}

.setup-readiness__status--success {
  color: var(--ms-color-success);
  border-color: var(--ms-color-success);
}

.setup-readiness__status--warning {
  color: var(--ms-color-warning);
  border-color: var(--ms-color-warning);
}

.setup-readiness__status--danger {
  color: var(--ms-color-danger);
  border-color: var(--ms-color-danger);
}

.setup-readiness__status--info {
  color: var(--ms-color-info);
  border-color: var(--ms-border);
}

.setup-readiness__scope {
  color: var(--ms-text-3);
  font-size: 11px;
  white-space: nowrap;
}

.setup-readiness__reason {
  margin: 0;
  color: var(--ms-text-2);
  font-size: 12px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.setup-readiness__meta {
  display: flex;
  gap: var(--ms-space-3);
  flex-wrap: wrap;
  color: var(--ms-text-3);
  font-size: 12px;
}

.setup-readiness__meta span {
  overflow-wrap: anywhere;
}

.setup-readiness__preview-entry {
  padding: 0;
  border: none;
  background: none;
  color: var(--ms-color-primary);
  font-size: 12px;
  cursor: pointer;
  text-align: left;
  overflow-wrap: anywhere;
}

.setup-readiness__notify {
  display: grid;
  gap: var(--ms-space-1);
  margin: 0;
  padding: var(--ms-space-2) var(--ms-space-3);
  border: 1px solid var(--ms-border-light);
  border-radius: var(--ms-radius-sm);
  background: var(--ms-bg-page);
  list-style: none;
  color: var(--ms-text-2);
  font-size: 12px;
  line-height: 1.5;
}

.setup-readiness__actions {
  display: flex;
  gap: var(--ms-space-2);
  flex-wrap: wrap;
  align-items: center;
}

.setup-readiness__action {
  padding: 5px 10px;
  border: 1px solid var(--ms-border);
  border-radius: var(--ms-radius-sm);
  background: var(--ms-bg-card);
  color: var(--ms-color-primary);
  font-size: 12px;
  cursor: pointer;
  text-decoration: none;
  display: inline-block;
}

.setup-readiness__action--inline {
  padding: 3px 8px;
  font-size: 11px;
}

.setup-readiness__contact {
  color: var(--ms-text-2);
  font-size: 12px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.setup-readiness__checklist {
  display: grid;
  gap: var(--ms-space-2);
  padding: var(--ms-space-3);
  border: 1px solid var(--ms-border-light);
  border-radius: var(--ms-radius-sm);
  background: var(--ms-bg-page);
  font-size: 12px;
  color: var(--ms-text-1);
}

.setup-readiness__checklist-note {
  margin: 0;
  color: var(--ms-text-2);
  line-height: 1.5;
}

.setup-readiness__checklist ul {
  display: grid;
  gap: var(--ms-space-2);
  margin: 0;
  padding-left: var(--ms-space-4);
}

.setup-readiness__checklist li {
  color: var(--ms-text-2);
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.setup-readiness__checklist li > span {
  margin-right: var(--ms-space-2);
}

.setup-readiness__help summary {
  color: var(--ms-text-3);
  font-size: 12px;
  cursor: pointer;
}

.setup-readiness__help dl {
  display: grid;
  gap: var(--ms-space-1);
  margin: var(--ms-space-2) 0 0;
  font-size: 12px;
  line-height: 1.5;
}

.setup-readiness__help dt {
  color: var(--ms-text-1);
  font-weight: 600;
}

.setup-readiness__help dd {
  margin: 0 0 var(--ms-space-1);
  color: var(--ms-text-2);
  overflow-wrap: anywhere;
}

@media (max-width: 640px) {
  .setup-readiness__step {
    flex-direction: column;
    gap: var(--ms-space-2);
  }

  .setup-readiness__header {
    flex-direction: column;
  }
}
</style>
