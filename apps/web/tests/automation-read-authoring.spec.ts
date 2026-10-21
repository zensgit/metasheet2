import { describe, expect, it, vi } from 'vitest'
import {
  AUTOMATION_READ_ACTION_TYPE as type,
  AUTOMATION_READ_OPERATION as operation,
  AUTOMATION_READ_TRIGGER_TYPES,
  automationReadAuthoringProblems,
  automationReadOwnerHint,
  buildAutomationReadConfig,
  containsAutomationReadAction,
  isAutomationReadConfig,
} from '../src/multitable/automationReadAuthoring'
import { summarizeAutomationAction } from '../src/multitable/automationActionSummary'

const config = { operation, allowManual: false }
const candidate = { actionType: type, actionConfig: config, actions: [{ type, config }], executionMode: null, triggerType: 'record.created' }

describe('fixed read-preview public authoring', () => {
  it('distinguishes saving from explicit owner activation and names the remaining automatic limits', () => {
    expect(automationReadOwnerHint(true)).toContain('保存或启用规则本身不会开启读取')
    expect(automationReadOwnerHint(true)).toContain('或授予数据源权限')
    expect(automationReadOwnerHint(true)).toContain('负责人独立授权手动预览')
    expect(automationReadOwnerHint(true)).toContain('record.created / record.updated（可明确确认已保存的支持条件）或无条件 schedule.cron / schedule.interval')
    expect(automationReadOwnerHint(true)).toContain('包括零字段或无实际值变化的更新')
    expect(automationReadOwnerHint(true)).toContain('定时配置在原规则编辑器，启用绑定当前保存版本')
    expect(automationReadOwnerHint(true)).toContain('普通测试运行不可执行')
    expect(automationReadOwnerHint(true)).toContain('schedule.date_field')
    expect(automationReadOwnerHint(true)).toContain('日期授权还须确认日期字段类型和 schema 版本')
    expect(automationReadOwnerHint(true)).toContain('每条到期记录分别消耗固定项目预算，项目不从记录推导')
    expect(automationReadOwnerHint(true)).toContain('其它记录类型及带条件的定时读取尚未接通')
    expect(automationReadOwnerHint(false)).toContain('Saving or enabling the rule does not start reads or grant source access')
    expect(automationReadOwnerHint(false)).toContain('owner must separately authorize manual preview')
    expect(automationReadOwnerHint(false)).toContain('explicit confirmation of supported saved conditions')
    expect(automationReadOwnerHint(false)).toContain('record.created / record.updated')
    expect(automationReadOwnerHint(false)).toContain('including zero-field or unchanged-value updates')
    expect(automationReadOwnerHint(false)).toContain('unconditional schedule.cron / schedule.interval')
    expect(automationReadOwnerHint(false)).toContain('Configure schedules in the original rule editor; activation binds the current saved revision')
    expect(automationReadOwnerHint(false)).toContain('Ordinary Test run cannot execute')
    expect(automationReadOwnerHint(false)).toContain('schedule.date_field')
    expect(automationReadOwnerHint(false)).toContain('Date activation also requires confirmation of the date field type and schema revision')
    expect(automationReadOwnerHint(false)).toContain('Each due record consumes a fixed-project allowance separately')
    expect(automationReadOwnerHint(false)).toContain('Other record types and conditional scheduled reads are not connected yet')
  })
  it.each(AUTOMATION_READ_TRIGGER_TYPES)('accepts explicit manual opt-in on %s', triggerType => {
    for (const allowManual of [false, true]) {
      const cfg = { operation, allowManual }
      expect(automationReadAuthoringProblems({ ...candidate, triggerType, actionConfig: cfg, actions: [{ type, config: cfg }] })).toEqual([])
    }
  })
  it.each([null, [], undefined])('accepts legacy-only actions %s', actions => {
    expect(automationReadAuthoringProblems({ ...candidate, actions })).toEqual([])
  })
  it.each([
    {}, { operation, allowManual: 'true' }, { operation, allowManual: 0 },
    { operation: 'other', allowManual: false }, { ...config, sql: 'private' },
    { ...config, sourceId: 'private' }, { ...config, selectors: {} }, { ...config, grantId: 'private' },
  ])('refuses malformed or private config without sanitizing it', invalid => {
    expect(isAutomationReadConfig(invalid)).toBe(false)
    expect(automationReadAuthoringProblems({ ...candidate, actionConfig: invalid })).toContain('config')
    expect(() => buildAutomationReadConfig(invalid)).toThrow('Invalid read-preview configuration')
  })
  it('does not invoke config getters', () => {
    const getter = vi.fn(() => operation)
    const cfg = { allowManual: false }
    Object.defineProperty(cfg, 'operation', { enumerable: true, get: getter })
    expect(isAutomationReadConfig(cfg)).toBe(false)
    expect(getter).not.toHaveBeenCalled()
  })
  it('checks singleton, legacy equality, mode and trigger separately', () => {
    expect(automationReadAuthoringProblems({ ...candidate, actions: [candidate.actions[0], { type: 'send_webhook', config: {} }] })).toContain('singleton')
    expect(automationReadAuthoringProblems({ ...candidate, actionConfig: { operation, allowManual: true } })).toContain('representation')
    expect(automationReadAuthoringProblems({ ...candidate, executionMode: 'workflow_job_v1' })).toContain('mode')
    expect(automationReadAuthoringProblems({ ...candidate, triggerType: 'webhook.received' })).toContain('trigger')
  })
  it('scans hidden legacy and nested executable paths but ignores business JSON', () => {
    expect(containsAutomationReadAction({ ...candidate, actions: [{ type: 'update_record', config: {} }] })).toBe(true)
    for (const branchType of ['condition_branch', 'parallel_branch']) {
      const nested = { type: branchType, config: { branches: [{ actions: [{ type, config }] }] } }
      expect(containsAutomationReadAction([nested])).toBe(true)
      expect(automationReadAuthoringProblems({ ...candidate, actionType: branchType, actionConfig: nested.config, actions: [nested] })).toContain('representation')
    }
    expect(containsAutomationReadAction([{ type: 'update_record', config: { fields: { note: { type } } } }])).toBe(false)
    expect(containsAutomationReadAction([{ type: 'parallel_branch', config: { branches: [], defaultBranch: { actions: [{ type, config }] } } }])).toBe(false)
    expect(containsAutomationReadAction([{ type: 'parallel_branch', config: { parallelBranches: [{ actions: [{ type, config }] }] } }])).toBe(false)
    expect(containsAutomationReadAction([{ type: 'parallel_branch', config: { parallelBranches: [{ actions: [{ type, config }] }] } }], true)).toBe(true)
  })
  it('builds a new closed config and renders a fixed bilingual summary', () => {
    expect(buildAutomationReadConfig(config)).toEqual(config)
    expect(buildAutomationReadConfig(config)).not.toBe(config)
    expect(summarizeAutomationAction({ type, integrationReadPreview: { allowManual: false } }, false)).toContain('manual not selected')
    expect(summarizeAutomationAction({ type, integrationReadPreview: { allowManual: true } }, true)).toContain('仍需负责人授权')
  })
})
