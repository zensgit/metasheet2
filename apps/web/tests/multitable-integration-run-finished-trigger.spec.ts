/**
 * R-69 1c — rule-editor support for the integration.run_finished trigger and its alert template (dry run only,
 * default OFF; R-69 is OPEN).
 *
 *   A. The client vocabulary is the server's, read from its SOURCE TEXT: statuses, the default alert set (skipped
 *      alerts, held quiet), the record-less action allowlist.
 *   B. The client save mirror refuses what the server's validateIntegrationRunFinishedTriggerConfig refuses.
 *   C. The alert template reads ONLY `run.*` (the closed, values-free event).
 *   D. The editor offers the trigger for a NEW rule only while the session feature integrationAutomationRunEvent is
 *      on; a loaded rule stays listed; the payload carries the closed job + statuses and never a binding.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, reactive } from 'vue'
import ElementPlus from 'element-plus'

import MetaAutomationRuleEditor from '../src/multitable/components/MetaAutomationRuleEditor.vue'
import type { AutomationRule } from '../src/multitable/types'
import {
  INTEGRATION_RUN_FINISHED_ALERT_TEMPLATE,
  INTEGRATION_RUN_FINISHED_ALLOWED_ACTION_TYPES,
  INTEGRATION_RUN_FINISHED_DEFAULT_STATUSES,
  INTEGRATION_RUN_FINISHED_STATUS_OPTIONS,
  integrationRunFinishedConfigError,
  integrationRunFinishedTemplateVariables,
  isIntegrationRunFinishedTriggerSelectable,
  normalizeIntegrationRunFinishedTriggerConfig,
} from '../src/multitable/integrationRunFinishedAuthoring'
import { useLocale } from '../src/composables/useLocale'
import { epOptions } from './helpers/epControls'

let runEventFlag = false
vi.mock('../src/stores/featureFlags', () => ({
  useFeatureFlags: () => ({
    hasFeature: (feature: string) => (feature === 'integrationAutomationRunEvent' ? runEventFlag : false),
  }),
}))

const REPO = resolve(__dirname, '../../..')
const read = (rel: string) => readFileSync(resolve(REPO, rel), 'utf8').replace(/\r\n/g, '\n')
const TENANT_SENTINEL = 'tenant-sentinel-r69'

function flushPromises() {
  return new Promise<void>((done) => setTimeout(done, 0)).then(() => nextTick())
}

function literalsIn(src: string, anchor: string): string[] {
  const start = src.indexOf(anchor)
  if (start < 0) throw new Error(`anchor missing: ${anchor}`)
  const end = src.indexOf(')', start)
  return [...src.slice(start, end).matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
}

// ── A. vocabulary parity with the server source ───────────────────────────────────────────────────────────

describe('integration.run_finished vocabulary = the server\'s', () => {
  const triggers = read('packages/core-backend/src/multitable/automation-triggers.ts')
  const service = read('packages/core-backend/src/multitable/automation-service.ts')

  it('statuses and the default alert set (skipped alerts, held quiet)', () => {
    expect([...INTEGRATION_RUN_FINISHED_STATUS_OPTIONS]).toEqual(literalsIn(triggers, 'export const INTEGRATION_RUN_FINISHED_STATUSES = Object.freeze(['))
    expect([...INTEGRATION_RUN_FINISHED_DEFAULT_STATUSES]).toEqual(literalsIn(triggers, 'export const INTEGRATION_RUN_FINISHED_DEFAULT_STATUSES = Object.freeze(['))
    expect(INTEGRATION_RUN_FINISHED_DEFAULT_STATUSES).toContain('skipped')
    expect(INTEGRATION_RUN_FINISHED_DEFAULT_STATUSES).not.toContain('held')
  })

  it('the record-less action allowlist is the server\'s side-effect set', () => {
    const start = service.indexOf('const APPROVAL_COMPLETED_SIDE_EFFECT_ACTION_TYPES')
    const block = service.slice(start, service.indexOf('])', start))
    const server = [...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
    expect([...INTEGRATION_RUN_FINISHED_ALLOWED_ACTION_TYPES].sort()).toEqual(server.sort())
    expect(INTEGRATION_RUN_FINISHED_ALLOWED_ACTION_TYPES.has('run_integration_job')).toBe(false)
    expect(INTEGRATION_RUN_FINISHED_ALLOWED_ACTION_TYPES.has('update_record')).toBe(false)
  })
})

// ── B. the save mirror ───────────────────────────────────────────────────────────────────────────────────

describe('integration.run_finished client save mirror', () => {
  it.each([
    [{ job: { kind: 'stock_prep_pull' } }, true],
    [{ job: { kind: 'stock_prep_pull', actionId: 'plm.stock-preparation.pull-bom.v1' }, statuses: ['held', 'failed'] }, true],
    [{ job: { kind: 'pipeline', pipelineId: 'pipe_1' } }, true],
    [{ job: { kind: 'pipeline' } }, false],
    [{ job: { kind: 'pipeline', pipelineId: 'https://x/y' } }, false],
    [{ job: { kind: 'stock_prep_pull', pipelineId: 'p' } }, false],
    [{ job: { kind: 'apply' } }, false],
    [{ job: { kind: 'stock_prep_pull', tenantId: 't' } }, false],
    [{ job: { kind: 'stock_prep_pull' }, extra: 1 }, false],
    [{ job: { kind: 'stock_prep_pull' }, statuses: [] }, false],
    [{ job: { kind: 'stock_prep_pull' }, statuses: ['failed', 'failed'] }, false],
    [{ job: { kind: 'stock_prep_pull' }, statuses: ['exploded'] }, false],
  ])('%j accepted=%s (the same cases the server test pins)', (config, accepted) => {
    expect(integrationRunFinishedConfigError(config, false) === '').toBe(accepted)
  })

  it('normalize keeps the closed job + statuses and drops a client binding', () => {
    expect(normalizeIntegrationRunFinishedTriggerConfig({ job: { kind: 'pipeline', pipelineId: ' pipe_1 ', actionId: 'x' }, statuses: ['failed', 'held'], binding: { tenantId: TENANT_SENTINEL } }))
      .toEqual({ job: { kind: 'pipeline', pipelineId: 'pipe_1' }, statuses: ['failed', 'held'] })
    expect(normalizeIntegrationRunFinishedTriggerConfig({ job: { kind: 'stock_prep_pull', actionId: '' } })).toEqual({ job: { kind: 'stock_prep_pull' } })
  })

  it('offered only while the switch is on; a loaded rule of this type stays listed', () => {
    expect(isIntegrationRunFinishedTriggerSelectable(false, 'record.created')).toBe(false)
    expect(isIntegrationRunFinishedTriggerSelectable(true, 'record.created')).toBe(true)
    expect(isIntegrationRunFinishedTriggerSelectable(false, 'integration.run_finished')).toBe(true)
  })
})

// ── C. the alert template ────────────────────────────────────────────────────────────────────────────────

describe('integration.run_finished alert template (ADR §4.3)', () => {
  it('is a DingTalk group message whose variables are ONLY run.*', () => {
    expect(INTEGRATION_RUN_FINISHED_ALERT_TEMPLATE.actionType).toBe('send_dingtalk_group_message')
    const vars = integrationRunFinishedTemplateVariables()
    expect(vars.length).toBeGreaterThan(5)
    for (const name of vars) expect(name.startsWith('run.')).toBe(true)
    for (const required of ['run.status', 'run.reason', 'run.errorClass', 'run.counts.read', 'run.counts.failed', 'run.durationMs', 'run.attempts']) {
      expect(vars).toContain(required)
    }
    expect(vars.some((name) => /tenant|scope|binding|record|actor/i.test(name))).toBe(false)
  })
})

// ── D. the rule editor ───────────────────────────────────────────────────────────────────────────────────

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

function runFinishedRule(overrides: Partial<AutomationRule> = {}): AutomationRule {
  return {
    id: 'rule_rf',
    sheetId: 'sheet_1',
    name: 'Run alerts',
    triggerType: 'integration.run_finished',
    triggerConfig: { job: { kind: 'stock_prep_pull' }, statuses: ['failed', 'skipped'], binding: { principalId: 'creator', tenantId: TENANT_SENTINEL } },
    actionType: 'send_notification',
    actionConfig: {},
    enabled: true,
    actions: [{ type: 'send_notification', config: { userIds: ['u1'], message: '{{run.status}}' } }],
    ...overrides,
  } as AutomationRule
}

function mountEditor(props: Record<string, unknown>) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const app = createApp({ render: () => h(MetaAutomationRuleEditor, reactive({ visible: true, sheetId: 'sheet_1', fields, client: client(), ...props })) })
  app.use(ElementPlus)
  app.mount(container)
  return { container, app }
}

function triggerOptions(container: HTMLElement): string[] {
  return epOptions(container.querySelector('[data-field="triggerType"]')?.closest('.el-select') ?? container.querySelector('.el-select')).map((opt) => opt.value)
}

function blockKeys(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-action="save-block-reason"]')].map((el) => el.getAttribute('data-reason-key') ?? '')
}

describe('rule editor: integration.run_finished trigger item', () => {
  beforeEach(() => {
    runEventFlag = false
    useLocale().setLocale('en')
  })
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('switch OFF: not offered for a new rule', async () => {
    const { container } = mountEditor({ rule: null })
    await flushPromises()
    expect(triggerOptions(container)).not.toContain('integration.run_finished')
    expect(triggerOptions(container)).toContain('approval.task_created')
  })

  it('switch ON: offered', async () => {
    runEventFlag = true
    const { container } = mountEditor({ rule: null })
    await flushPromises()
    expect(triggerOptions(container)).toContain('integration.run_finished')
  })

  it('a loaded rule stays listed with the switch OFF, shows its statuses, and never shows the stamped binding', async () => {
    const { container } = mountEditor({ rule: runFinishedRule() })
    await flushPromises()
    expect(triggerOptions(container)).toContain('integration.run_finished')
    const statuses = [...container.querySelectorAll('[data-field="runFinishedStatuses"] input[type="checkbox"]')] as HTMLInputElement[]
    expect(statuses.length).toBe(7)
    expect(statuses.filter((box) => box.checked).map((box) => box.value).sort()).toEqual(['failed', 'skipped'])
    expect(container.textContent).not.toContain(TENANT_SENTINEL)
    expect(blockKeys(container)).toEqual([])
  })

  it('save sends the closed job + statuses and never a binding', async () => {
    const onSave = vi.fn()
    const { container } = mountEditor({ rule: runFinishedRule(), onSave })
    await flushPromises()
    ;(container.querySelector('[data-action="save"]') as HTMLButtonElement).click()
    await flushPromises()
    const payload = onSave.mock.calls[0]?.[0] as AutomationRule
    expect(payload.triggerType).toBe('integration.run_finished')
    expect(payload.triggerConfig).toEqual({ job: { kind: 'stock_prep_pull' }, statuses: ['failed', 'skipped'] })
    expect(JSON.stringify(payload)).not.toContain('binding')
    expect(JSON.stringify(payload)).not.toContain(TENANT_SENTINEL)
  })

  it('a record-writing action on the trigger blocks save (the server would answer 400)', async () => {
    const { container } = mountEditor({ rule: runFinishedRule({ actionType: 'update_record', actions: [{ type: 'update_record', config: { fields: {} } }] }) })
    await flushPromises()
    expect(blockKeys(container)).toContain('integrationRunFinished')
  })

  it('the alert-template button fills a DingTalk group message with run.* templates', async () => {
    const onSave = vi.fn()
    const { container } = mountEditor({ rule: runFinishedRule(), onSave })
    await flushPromises()
    ;(container.querySelector('[data-action="applyRunFinishedAlertTemplate"]') as HTMLButtonElement).click()
    await flushPromises()
    const titles = [...container.querySelectorAll('[data-field="dingtalkTitleTemplate"] input, input[data-field="dingtalkTitleTemplate"]')] as HTMLInputElement[]
    expect(titles.map((el) => el.value)).toContain(INTEGRATION_RUN_FINISHED_ALERT_TEMPLATE.titleTemplate)
  })
})
