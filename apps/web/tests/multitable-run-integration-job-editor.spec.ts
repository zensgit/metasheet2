/**
 * R-69 1b-iii — rule-editor support for run_integration_job (dry run only, default OFF; R-69 is OPEN).
 *
 *   A. The step-result vocabulary is I3's, byte for byte: every outcome / reason literal the executor
 *      (packages/core-backend/src/multitable/automation-executor.ts) and the plugin port
 *      (plugins/plugin-integration-core/lib/integration-run-port.cjs) write is read from their SOURCE TEXT and must
 *      have a label here; every labelled code must exist there. A drift on either side goes red.
 *   B. The step-result view is values-free (no scopeKey / tenant id, no runId, no raw JSON).
 *   C. The editor offers the action only while the server switch is on (session feature
 *      integrationAutomationRunAction) and the trigger is schedule.cron; a loaded one stays listed; the payload is
 *      the dry-run shape without binding; the save mirror blocks what the server would refuse.
 *      R-69 I6d: EXACTLY ONE project per rule (the server's rule-sheet guard, register R-90) — label, hint and save
 *      block; a loaded rule that lists several is shown whole and cannot be saved. The payload carries the action
 *      list AND its first action mirrored into the legacy pair — the wire shape the core-backend service tests
 *      (tests/unit/automation-run-integration-job-editor-save-path.test.ts) drive through the real save.
 * The server/client save-validator byte parity itself lives in core-backend
 * (tests/unit/automation-run-integration-job-web-parity.test.ts), where both validators are imported live.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, reactive } from 'vue'
import ElementPlus from 'element-plus'

import MetaAutomationRuleEditor from '../src/multitable/components/MetaAutomationRuleEditor.vue'
import MetaAutomationLogViewer from '../src/multitable/components/MetaAutomationLogViewer.vue'
import type { AutomationExecution, AutomationRule } from '../src/multitable/types'
import {
  RUN_INTEGRATION_JOB_EDITOR_MAX_PROJECTS,
  RUN_INTEGRATION_JOB_MAX_PROJECTS,
  RUN_INTEGRATION_JOB_REASON_LABELS,
  RUN_INTEGRATION_JOB_STEP_OUTCOMES,
  checkRunIntegrationJobRuleSheetProjects,
  runIntegrationJobStepView,
} from '../src/multitable/runIntegrationJobAuthoring'
import { buildAutomationLogSupportPacket } from '../src/multitable/utils/automation-log-support-packet'
import { BRANCH_AUTHORABLE_ACTION_TYPES, CONDITION_BRANCH_AUTHORABLE_ACTION_TYPES } from '../src/multitable/utils/conditionBranchAuthoring'
import { useLocale } from '../src/composables/useLocale'
import { epOptions } from './helpers/epControls'

let runActionFlag = false
vi.mock('../src/stores/featureFlags', () => ({
  useFeatureFlags: () => ({
    hasFeature: (feature: string) => (feature === 'integrationAutomationRunAction' ? runActionFlag : false),
  }),
}))

const REPO = resolve(__dirname, '../../..')
const read = (rel: string) => readFileSync(resolve(REPO, rel), 'utf8').replace(/\r\n/g, '\n')

function flushPromises() {
  return new Promise<void>((done) => setTimeout(done, 0)).then(() => nextTick())
}

// ── A. Vocabulary, read from I3's source ────────────────────────────────────────────────────────────────

function between(src: string, start: string, end: string): string {
  const s = src.indexOf(start)
  const e = src.indexOf(end, s + 1)
  if (s < 0 || e < 0) throw new Error(`source anchor missing: ${start} … ${end}`)
  return src.slice(s, e)
}

/** Literals in a call line, minus comparands (`=== 'x'`): positional args and both arms of a ternary. */
function literalsOf(line: string): string[] {
  return [...line.matchAll(/(?<!=== )'([a-z_]+)'/g)].map((m) => m[1])
}

function executorVocabulary(): { outcomes: Set<string>; reasons: Set<string> } {
  const src = read('packages/core-backend/src/multitable/automation-executor.ts')
  const vocab = between(src, 'const RUN_INTEGRATION_JOB_OUTCOME_SEVERITY', '\n}\n')
  const outcomes = new Set([...vocab.matchAll(/^\s+(\w+): \d+,?$/gm)].map((m) => m[1]))
  const classify = between(src, 'function classifyIntegrationRunSettlement', '\nfunction whenAborted')
  const region = between(src, '// ── R-69 1b-ii: run_integration_job (design baseline', 'private async executeCreateRecord')
  const reasons = new Set<string>()
  for (const line of region.split('\n')) {
    const step = /runIntegrationJobStep\('(\w+)', '(\w+)', '(\w+)'/.exec(line)
    if (step) { outcomes.add(step[2]); reasons.add(step[3]); continue }
    const unitCall = /\bunit\('(\w+)', (.*)$/.exec(line)
    if (unitCall) {
      outcomes.add(unitCall[1])
      for (const literal of literalsOf(unitCall[2])) reasons.add(literal)
    }
  }
  // `reason: abortedBy` / `reason: abortCause` are the abort causes; `reason: 'aborted'` is classify's own.
  const abortCause = /readonly abortCause: '(\w+)' \| '(\w+)'/.exec(src)
  if (!abortCause) throw new Error('abortCause union not found')
  reasons.add(abortCause[1]); reasons.add(abortCause[2])
  for (const m of classify.matchAll(/reason: '(\w+)'/g)) reasons.add(m[1])
  return { outcomes, reasons }
}

function portVocabulary(): Set<string> {
  const src = read('plugins/plugin-integration-core/lib/integration-run-port.cjs')
  const reasons = new Set<string>()
  const held = /HELD_DRY_RUN_STATUSES = new Set\(\[([^\]]+)\]\)/.exec(src)
  if (!held) throw new Error('HELD_DRY_RUN_STATUSES not found')
  for (const m of held[1].matchAll(/'(\w+)'/g)) reasons.add(m[1])
  for (const m of src.matchAll(/\['STOCK_PREPARATION_\w+', '(\w+)'\]/g)) reasons.add(m[1])
  for (const m of src.matchAll(/reason: '(\w+)'/g)) reasons.add(m[1])
  return reasons
}

describe('run_integration_job step vocabulary = I3 output.outcome / output.reason, byte for byte', () => {
  const executor = executorVocabulary()
  const port = portVocabulary()
  const sourceReasons = new Set([...executor.reasons, ...port])

  it('anti-vacuous: the scan finds the codes the brief names', () => {
    for (const code of ['timeout_unsettled', 'lease_lost', 'busy', 'principal_unauthorized', 'action_disabled', 'inflight_lease', 'terminal_write_unconfirmed']) {
      expect(executor.reasons.has(code), code).toBe(true)
    }
    for (const code of ['manual_confirm_required', 'project_absent', 'ready']) expect(port.has(code), code).toBe(true)
    expect(executor.outcomes.has('outcome_unknown')).toBe(true)
    expect(executor.outcomes.has('held')).toBe(true)
  })

  it('the outcome set equals the executor\'s RunIntegrationJobOutcome severity keys', () => {
    expect([...RUN_INTEGRATION_JOB_STEP_OUTCOMES].sort()).toEqual([...executor.outcomes].sort())
  })

  it('every reason the executor or the port writes has a label (no raw code shown for a closed reason)', () => {
    const missing = [...sourceReasons].filter((code) => !Object.prototype.hasOwnProperty.call(RUN_INTEGRATION_JOB_REASON_LABELS, code))
    expect(missing).toEqual([])
  })

  it('every labelled reason exists in I3\'s source (no invented codes)', () => {
    const invented = Object.keys(RUN_INTEGRATION_JOB_REASON_LABELS).filter((code) => !sourceReasons.has(code))
    expect(invented).toEqual([])
  })
})

// ── B. Values-free step view ───────────────────────────────────────────────────────────────────────────

const TENANT_SENTINEL = 'tenant-sentinel-not-a-host'
const RUN_ID_SENTINEL = 'run-id-sentinel-zz'

function stepOutput(outcome: string, reason: string, units: Array<Record<string, unknown>> = []) {
  return {
    outcome,
    reason,
    units: units.map((unit) => ({ scopeKey: `stock_prep_pull:${TENANT_SENTINEL}:${unit.projectNo ?? 'P-1'}`, confirmed: false, durationMs: 5, ...unit })),
    durationMs: 9,
  }
}

describe('values-free step-result view', () => {
  it.each([
    ['outcome_unknown', 'timeout_unsettled', 'Outcome unknown (timed out and not yet settled)', '结果未知（超时且尚未结束）'],
    ['outcome_unknown', 'lease_lost', 'Outcome unknown (the job lease was lost)', '结果未知（任务租约已丢失）'],
    ['skipped', 'busy', 'Skipped (another job holds this project)', '已跳过（同一项目正被另一任务占用）'],
    ['held', 'manual_confirm_required', 'Held for a person (manual confirmation required)', '待人工处理（需人工确认）'],
    ['skipped', 'principal_unauthorized', 'Skipped (the bound principal is not authorized)', '已跳过（绑定的身份无权运行）'],
    ['skipped', 'action_disabled', 'Skipped (the action switch is off)', '已跳过（动作开关未开启）'],
    ['failed', 'STOCK_PREP_REFRESH_RECOVERY_PENDING', 'Failed (STOCK_PREP_REFRESH_RECOVERY_PENDING)', '失败（STOCK_PREP_REFRESH_RECOVERY_PENDING）'],
  ])('%s(%s)', (outcome, reason, en, zh) => {
    expect(runIntegrationJobStepView({ outcome, reason }, false)?.text).toBe(en)
    expect(runIntegrationJobStepView({ outcome, reason }, true)?.text).toBe(zh)
  })

  it('never renders scopeKey (tenant id), runId or a non-class reason; counts are integers only', () => {
    const view = runIntegrationJobStepView(stepOutput('outcome_unknown', 'timeout_unsettled', [
      { projectNo: 'P-1', outcome: 'succeeded', reason: 'ready', confirmed: true, summary: { status: 'succeeded', runId: RUN_ID_SENTINEL, counts: { read: 12, failed: 0, bad: 1.5 } } },
      { projectNo: 'P-2', outcome: 'outcome_unknown', reason: 'timeout_unsettled', cause: 'timeout' },
      { projectNo: 'P-3', outcome: 'failed', reason: 'has spaces <b>' },
    ]), false)!
    const text = JSON.stringify(view)
    expect(text).not.toContain(TENANT_SENTINEL)
    expect(text).not.toContain(RUN_ID_SENTINEL)
    expect(text).not.toContain('<b>')
    expect(view.units.map((unit) => [unit.projectNo, unit.text, unit.counts])).toEqual([
      ['P-1', 'Succeeded (dry run) (dry run ready)', 'read 12 · failed 0'],
      ['P-2', 'Outcome unknown (timed out and not yet settled)', ''],
      ['P-3', 'Failed (other)', ''],
    ])
  })

  it('the run log shows sentences only: no raw output JSON, no English error line, no tenant id', async () => {
    useLocale().setLocale('zh-CN')
    const execution: AutomationExecution = {
      id: 'exec-rij', ruleId: 'rule-rij', status: 'failed', triggeredBy: 'schedule',
      triggeredAt: '2026-11-06T00:00:00Z', duration: 20,
      steps: [{
        actionType: 'run_integration_job',
        status: 'failed',
        durationMs: 20,
        error: 'run_integration_job outcome_unknown (timeout_unsettled)',
        output: stepOutput('outcome_unknown', 'timeout_unsettled', [
          { projectNo: 'P-1', outcome: 'skipped', reason: 'busy' },
          { projectNo: 'P-2', outcome: 'outcome_unknown', reason: 'timeout_unsettled', cause: 'timeout' },
        ]),
      }],
    }
    const client = {
      getAutomationLogs: vi.fn(async () => [execution]),
      getAutomationStats: vi.fn(async () => ({ total: 1, success: 0, failed: 1, skipped: 0, avgDuration: 20 })),
    }
    const container = document.createElement('div')
    document.body.appendChild(container)
    const app = createApp({ render: () => h(MetaAutomationLogViewer, { visible: true, sheetId: 's', ruleId: 'rule-rij', client }) })
    app.mount(container)
    await flushPromises()
    ;(container.querySelector('[data-log-id="exec-rij"]') as HTMLElement).click()
    await flushPromises()
    expect(container.querySelector('[data-field="step-reason"]')?.textContent?.trim()).toBe('结果未知（超时且尚未结束）')
    expect([...container.querySelectorAll('[data-field="step-unit"]')].map((li) => li.textContent?.trim())).toEqual([
      'P-1: 已跳过（同一项目正被另一任务占用）',
      'P-2: 结果未知（超时且尚未结束）',
    ])
    expect(container.querySelector('[data-field="step-output"]')).toBeNull()
    expect(container.querySelector('[data-field="step-error"]')).toBeNull()
    expect(container.textContent).not.toContain(TENANT_SENTINEL)
    expect(container.textContent).not.toContain('scopeKey')
    app.unmount()
    container.remove()
    // The support packet carries the same values-free sentence, never the raw output.
    const packet = JSON.stringify(buildAutomationLogSupportPacket(execution, '2026-11-06T00:00:00Z'))
    expect(packet).not.toContain(TENANT_SENTINEL)
    expect(packet).toContain('Outcome unknown (timed out and not yet settled)')
  })
})

// ── C. Rule editor ─────────────────────────────────────────────────────────────────────────────────────

const fields = [{ id: 'fld_name', name: 'Name', type: 'string' }]

function client() {
  return {
    listDingTalkGroups: vi.fn(async () => []),
    listApprovalTemplates: vi.fn(async () => ({ data: [], total: 0 })),
    listSheets: vi.fn(async () => ({ sheets: [] })),
    listFields: vi.fn(async () => ({ fields })),
    listFormShareCandidates: vi.fn(async () => ({ items: [], total: 0, limit: 8, query: '' })),
  }
}

function cronRule(overrides: Partial<AutomationRule> = {}): AutomationRule {
  return {
    id: 'rule_rij',
    sheetId: 'sheet_1',
    name: 'Nightly pull',
    triggerType: 'schedule.cron',
    triggerConfig: { cron: '0 6 * * *', timezone: 'Asia/Shanghai' },
    actionType: 'send_notification',
    actionConfig: {},
    enabled: true,
    actions: [{ type: 'send_notification', config: { userIds: ['u1'], message: 'ok' } }],
    ...overrides,
  }
}

function rijRule(config: Record<string, unknown>, overrides: Partial<AutomationRule> = {}): AutomationRule {
  return cronRule({ actionType: 'run_integration_job', actionConfig: config, actions: [{ type: 'run_integration_job', config }], ...overrides })
}

// R-69 I6d: a saveable rule lists exactly one project (the project its sheet is registered to).
const STORED_CONFIG = {
  job: { kind: 'stock_prep_pull', projectNos: ['P-001'], applyMode: 'dry_run_only' },
  timeoutMs: 20 * 60_000,
  binding: { principalId: 'creator-sentinel', tenantId: TENANT_SENTINEL },
}
/** A rule stored before the one-project rule: it lists two. The editor shows both and cannot save it as it is. */
const STORED_TWO_PROJECTS = { ...STORED_CONFIG, job: { ...STORED_CONFIG.job, projectNos: ['P-001', 'P-002'] } }
const projectsTextOf = (container: HTMLElement) =>
  (container.querySelector('[data-field="rijProjectNosText"] textarea, textarea[data-field="rijProjectNosText"]') as HTMLTextAreaElement).value
const blockTextOf = (container: HTMLElement, key: string) =>
  container.querySelector(`[data-action="save-block-reason"][data-reason-key="${key}"]`)?.textContent?.trim() ?? ''

function mountEditor(props: Record<string, unknown>) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp({ render: () => h(MetaAutomationRuleEditor, reactive({ visible: true, sheetId: 'sheet_1', fields, client: client(), ...props })) })
  app.use(ElementPlus)
  app.mount(container)
  return { container, app }
}

function actionTypeOptions(container: HTMLElement): string[] {
  const select = container.querySelector('[data-action-index="0"] .meta-rule-editor__action-header .el-select')
  return select ? epOptions(select).map((opt) => opt.value) : []
}

function blockKeys(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-action="save-block-reason"]')].map((el) => el.getAttribute('data-reason-key') ?? '')
}

function setTextarea(container: HTMLElement, selector: string, value: string) {
  const el = container.querySelector(`${selector} textarea, ${selector} input, textarea${selector}, input${selector}`) as HTMLTextAreaElement | HTMLInputElement
  el.value = value
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('rule editor: run_integration_job item', () => {
  beforeEach(() => {
    runActionFlag = false
    useLocale().setLocale('en')
  })
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('switch OFF: not offered for a new selection, even on a cron rule', async () => {
    const { container } = mountEditor({ rule: cronRule() })
    await flushPromises()
    expect(actionTypeOptions(container)).not.toContain('run_integration_job')
  })

  it('switch ON + schedule.cron: offered', async () => {
    runActionFlag = true
    const { container } = mountEditor({ rule: cronRule() })
    await flushPromises()
    expect(actionTypeOptions(container)).toContain('run_integration_job')
  })

  it('switch ON + a non-cron trigger: not offered', async () => {
    runActionFlag = true
    const { container } = mountEditor({ rule: cronRule({ triggerType: 'record.created', triggerConfig: {} }) })
    await flushPromises()
    expect(actionTypeOptions(container)).not.toContain('run_integration_job')
  })

  it('never offered inside a branch (top-level only, as the server requires)', () => {
    expect(BRANCH_AUTHORABLE_ACTION_TYPES as readonly string[]).not.toContain('run_integration_job')
    expect(CONDITION_BRANCH_AUTHORABLE_ACTION_TYPES as readonly string[]).not.toContain('run_integration_job')
  })

  it('a loaded action stays listed with the switch OFF, and shows only the dry-run mode and the closed kind set', async () => {
    const { container } = mountEditor({ rule: rijRule(STORED_CONFIG) })
    await flushPromises()
    expect(actionTypeOptions(container)).toContain('run_integration_job')
    const cfg = container.querySelector('[data-action-config="run_integration_job"]') as HTMLElement
    expect(cfg).not.toBeNull()
    expect(cfg.querySelector('[data-field="rijApplyMode"]')?.getAttribute('data-value')).toBe('dry_run_only')
    expect(cfg.textContent).not.toContain('apply_when_ready')
    const kinds = epOptions(cfg.querySelector('[data-field="rijKind"]')!.closest('.el-select') ?? cfg.querySelector('.el-select'))
    expect(kinds.map((k) => [k.value, k.disabled])).toEqual([['stock_prep_pull', false], ['pipeline', true]])
    expect(projectsTextOf(container)).toBe('P-001')
    expect(container.textContent).not.toContain(TENANT_SENTINEL)
  })

  it('save sends the dry-run shape without binding — the action list AND its first action mirrored into the pair — and the trigger keeps its timezone', async () => {
    runActionFlag = true
    const onSave = vi.fn()
    const { container } = mountEditor({ rule: rijRule(STORED_CONFIG), onSave })
    await flushPromises()
    expect(blockKeys(container)).toEqual([])
    ;(container.querySelector('[data-action="save"]') as HTMLButtonElement).click()
    await flushPromises()
    const payload = onSave.mock.calls[0]?.[0] as AutomationRule
    const sentConfig = { job: { kind: 'stock_prep_pull', projectNos: ['P-001'], applyMode: 'dry_run_only' }, timeoutMs: 20 * 60_000 }
    expect(payload.actions).toEqual([{ type: 'run_integration_job', config: sentConfig }])
    // R-69 I6d: the wire shape the server's save gate must accept — the job travels in `actions[]` (what the
    // executor runs) and, as the first action, is mirrored into the legacy pair. Never the pair alone.
    expect(payload.actionType).toBe('run_integration_job')
    expect(payload.actionConfig).toEqual(sentConfig)
    expect(payload.executionMode ?? null).toBeNull()
    expect(JSON.stringify(payload)).not.toContain('binding')
    expect(payload.triggerConfig?.timezone).toBe('Asia/Shanghai')
  })

  // ── R-69 I6d: exactly one project per rule (the server's rule-sheet guard; register R-90) ───────────────────────
  it('the editor limit is ONE project — not the pure validator cap — and says so in the label and the hint', async () => {
    expect(RUN_INTEGRATION_JOB_EDITOR_MAX_PROJECTS).toBe(1)
    // the parity-pinned mirror cap is a different number; the editor does not author against it
    expect(RUN_INTEGRATION_JOB_MAX_PROJECTS).toBe(20)
    const two = { job: { kind: 'stock_prep_pull', projectNos: ['P-1', 'P-2'], applyMode: 'dry_run_only' } }
    expect(checkRunIntegrationJobRuleSheetProjects({ job: { ...two.job, projectNos: ['P-1'] } })).toBeNull()
    expect(checkRunIntegrationJobRuleSheetProjects(two)?.code).toBe('projects_not_single')
    runActionFlag = true
    const { container } = mountEditor({ rule: rijRule(STORED_CONFIG) })
    await flushPromises()
    const cfg = container.querySelector('[data-action-config="run_integration_job"]') as HTMLElement
    expect(cfg.querySelector('[data-field="rij-project-label"]')?.textContent).toContain('exactly one')
    expect(cfg.querySelector('[data-field="rij-single-project-hint"]')?.textContent).toContain('One rule pulls one project')
    expect(cfg.textContent).not.toContain('at most 20')
    useLocale().setLocale('zh-CN')
    await flushPromises()
    expect(cfg.querySelector('[data-field="rij-project-label"]')?.textContent).toContain('恰一个')
    expect(cfg.querySelector('[data-field="rij-single-project-hint"]')?.textContent).toContain('一条规则只拉取一个项目')
    expect(cfg.textContent).not.toContain('最多 20')
  })

  it('a loaded rule that lists TWO projects is shown whole (never truncated) and cannot be saved until one is left', async () => {
    runActionFlag = true
    const onSave = vi.fn()
    const { container } = mountEditor({ rule: rijRule(STORED_TWO_PROJECTS), onSave })
    await flushPromises()
    expect(projectsTextOf(container)).toBe('P-001\nP-002')
    expect(blockKeys(container)).toEqual(['runIntegrationJob:0'])
    expect(blockTextOf(container, 'runIntegrationJob:0')).toBe('Action 1 (run integration job): list exactly one project number: the project this sheet is registered to.')
    const save = container.querySelector('[data-action="save"]') as HTMLButtonElement
    expect(save.disabled).toBe(true)
    save.click()
    await flushPromises()
    expect(onSave).not.toHaveBeenCalled()
    // leaving one project clears the block, and that one project is what is sent
    setTextarea(container, '[data-field="rijProjectNosText"]', 'P-002')
    await flushPromises()
    expect(blockKeys(container)).toEqual([])
    save.click()
    await flushPromises()
    const payload = onSave.mock.calls[0]?.[0] as AutomationRule
    expect((payload.actions?.[0]?.config as { job: { projectNos: string[] } }).job.projectNos).toEqual(['P-002'])
  })

  it('switch OFF + a loaded action: listed, but save is blocked with a reason (the server would answer 403)', async () => {
    const off = mountEditor({ rule: rijRule(STORED_CONFIG) })
    await flushPromises()
    expect(blockKeys(off.container)).toEqual(['runIntegrationJobSwitch'])
    expect((off.container.querySelector('[data-action="save"]') as HTMLButtonElement).disabled).toBe(true)
    off.app.unmount()
    document.body.innerHTML = ''
    runActionFlag = true
    const on = mountEditor({ rule: rijRule(STORED_CONFIG) })
    await flushPromises()
    expect(blockKeys(on.container)).toEqual([])
  })

  it('a legacy cron rule without a timezone blocks save (the server would answer 400)', async () => {
    const { container } = mountEditor({ rule: rijRule(STORED_CONFIG, { triggerConfig: { cron: '0 6 * * *' } }) })
    await flushPromises()
    expect(blockKeys(container)).toContain('runIntegrationJobTrigger')
    expect((container.querySelector('[data-action="save"]') as HTMLButtonElement).disabled).toBe(true)
  })

  it('a non-cron trigger with the loaded action blocks save', async () => {
    const { container } = mountEditor({ rule: rijRule(STORED_CONFIG, { triggerType: 'schedule.interval', triggerConfig: { intervalMinutes: 5 } }) })
    await flushPromises()
    expect(blockKeys(container)).toContain('runIntegrationJobTrigger')
  })

  it.each([
    ['2 projects (one rule, one project)', '[data-field="rijProjectNosText"]', 'P-1\nP-2'],
    ['2 projects on one line', '[data-field="rijProjectNosText"]', 'P-1, P-2'],
    ['20 projects (the pure validator cap is not the editor limit)', '[data-field="rijProjectNosText"]', Array.from({ length: 20 }, (_, i) => `P-${i}`).join('\n')],
    ['21 projects', '[data-field="rijProjectNosText"]', Array.from({ length: 21 }, (_, i) => `P-${i}`).join('\n')],
    ['a repeated project', '[data-field="rijProjectNosText"]', 'P-1\nP-1'],
    ['no project', '[data-field="rijProjectNosText"]', ''],
    ['56 minutes', '[data-field="rijTimeoutMinutes"]', '56'],
    ['0 minutes', '[data-field="rijTimeoutMinutes"]', '0'],
  ])('the save mirror blocks %s', async (_name, selector, value) => {
    runActionFlag = true
    const { container } = mountEditor({ rule: rijRule(STORED_CONFIG) })
    await flushPromises()
    expect(blockKeys(container)).toEqual([])
    setTextarea(container, selector, value)
    await flushPromises()
    expect(blockKeys(container)).toContain('runIntegrationJob:0')
  })

  it('2, 20 and 21 projects all answer the SAME one-project line (never "at most 20"); one project of any number is accepted client-side', async () => {
    runActionFlag = true
    const { container } = mountEditor({ rule: rijRule(STORED_CONFIG) })
    await flushPromises()
    for (const count of [2, 20, 21]) {
      setTextarea(container, '[data-field="rijProjectNosText"]', Array.from({ length: count }, (_, i) => `P-${i}`).join('\n'))
      await flushPromises()
      expect(blockTextOf(container, 'runIntegrationJob:0'), `${count} projects`).toBe('Action 1 (run integration job): list exactly one project number: the project this sheet is registered to.')
    }
    setTextarea(container, '[data-field="rijProjectNosText"]', '')
    await flushPromises()
    expect(blockTextOf(container, 'runIntegrationJob:0')).toBe('Action 1 (run integration job): enter the project number (exactly one: the project this sheet is registered to).')
    // Which project the sheet is registered to is the server's answer (its rule-sheet guard): any single number passes here.
    setTextarea(container, '[data-field="rijProjectNosText"]', 'P-ANOTHER')
    await flushPromises()
    expect(blockKeys(container)).toEqual([])
  })

  it('55 minutes is accepted (the cap is inclusive)', async () => {
    runActionFlag = true
    const { container } = mountEditor({ rule: rijRule(STORED_CONFIG) })
    await flushPromises()
    setTextarea(container, '[data-field="rijTimeoutMinutes"]', '55')
    await flushPromises()
    expect(blockKeys(container)).toEqual([])
  })
})
