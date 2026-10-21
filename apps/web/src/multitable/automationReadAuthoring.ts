// Public authoring carries only a fixed operation and an explicit manual opt-in.
// This proves no source authority: execution belongs to the owner preparation panel.
export const AUTOMATION_READ_ACTION_TYPE = 'integration_read_preview'
export const AUTOMATION_READ_OPERATION = 'plm.stock-preparation.diff-preview.v1'
export const AUTOMATION_READ_TRIGGER_TYPES = [
  'record.created', 'record.updated', 'record.deleted', 'field.value_changed',
  'schedule.cron', 'schedule.interval', 'schedule.date_field',
] as const

export interface AutomationReadAuthoringInput {
  actionType: unknown
  actionConfig: unknown
  actions: unknown
  executionMode: unknown
  triggerType: unknown
}
export type AutomationReadAuthoringProblem = 'config' | 'singleton' | 'trigger' | 'mode' | 'representation'

function closedData(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    || Reflect.ownKeys(value).length !== keys.length) return null
  const result: Record<string, unknown> = {}
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null
    result[key] = descriptor.value
  }
  return result
}

export function isAutomationReadConfig(value: unknown): boolean {
  try {
    const data = closedData(value, ['operation', 'allowManual'])
    return data?.operation === AUTOMATION_READ_OPERATION && typeof data.allowManual === 'boolean'
  } catch { return false }
}

export function buildAutomationReadConfig(value: unknown): { operation: typeof AUTOMATION_READ_OPERATION; allowManual: boolean } {
  if (!isAutomationReadConfig(value)) throw new Error('Invalid read-preview configuration')
  const data = closedData(value, ['operation', 'allowManual'])!
  return { operation: AUTOMATION_READ_OPERATION, allowManual: data.allowManual as boolean }
}

/** Walk executable action paths only, including hidden legacy pairs and unsupported branches. */
export function containsAutomationReadAction(value: unknown, includeDraft = false): boolean {
  const seen = new Set<object>()
  function read(entry: unknown, key: string): unknown {
    if (!entry || typeof entry !== 'object') return undefined
    const descriptor = Object.getOwnPropertyDescriptor(entry, key)
    // In a Vue draft, a data-property get also registers reactive dependencies.
    // Accessors remain excluded; public stored-policy scans keep descriptor values.
    return descriptor && Object.hasOwn(descriptor, 'value')
      ? includeDraft ? Reflect.get(entry, key) : descriptor.value : undefined
  }
  function list(entry: unknown): boolean {
    return Array.isArray(entry) && Array.from({ length: entry.length }, (_, index) => read(entry, String(index))).some(action)
  }
  function branches(config: unknown, type: unknown): boolean {
    const rows = read(config, 'branches') ?? (includeDraft ? read(config, 'parallelBranches') : undefined)
    return (Array.isArray(rows) && Array.from({ length: rows.length }, (_, index) => read(rows, String(index))).some(row => list(read(row, 'actions'))))
      || (type === 'condition_branch' && list(read(read(config, 'defaultBranch'), 'actions')))
  }
  function action(entry: unknown): boolean {
    if (!entry || typeof entry !== 'object' || seen.has(entry)) return false
    seen.add(entry)
    const type = read(entry, 'type')
    if (type === AUTOMATION_READ_ACTION_TYPE) return true
    if (type === 'condition_branch' || type === 'parallel_branch') {
      const config = read(entry, 'config')
      return branches(config, type) || (includeDraft
        && (branches(read(config, 'branchOriginal'), type) || branches(read(config, 'parallelBranchOriginal'), type)))
    }
    return false
  }
  try {
    if (Array.isArray(value)) return list(value)
    return action(value) || action({ type: read(value, 'actionType'), config: read(value, 'actionConfig') })
      || list(read(value, 'actions'))
  } catch { return true }
}

/** Mirrors the backend public shape policy; unrelated actions are outside this helper. */
export function automationReadAuthoringProblems(input: AutomationReadAuthoringInput): AutomationReadAuthoringProblem[] {
  if (!containsAutomationReadAction(input)) return []
  const problems = new Set<AutomationReadAuthoringProblem>()
  try {
    if (input.actionType !== AUTOMATION_READ_ACTION_TYPE) problems.add('representation')
    if (!isAutomationReadConfig(input.actionConfig)) problems.add('config')
    if (input.executionMode != null && input.executionMode !== 'legacy') problems.add('mode')
    if (!(AUTOMATION_READ_TRIGGER_TYPES as readonly unknown[]).includes(input.triggerType)) problems.add('trigger')
    if (input.actions != null) {
      if (!Array.isArray(input.actions) || Object.getPrototypeOf(input.actions) !== Array.prototype
        || input.actions.length > 1 || Reflect.ownKeys(input.actions).length !== input.actions.length + 1) {
        problems.add('singleton')
      } else if (input.actions.length === 1) {
        const descriptor = Object.getOwnPropertyDescriptor(input.actions, '0')
        const action = descriptor && Object.hasOwn(descriptor, 'value')
          ? closedData(descriptor.value, ['type', 'config']) : null
        if (!descriptor?.enumerable || !action || action.type !== AUTOMATION_READ_ACTION_TYPE) problems.add('representation')
        else if (!isAutomationReadConfig(action.config)) problems.add('config')
        else if (isAutomationReadConfig(input.actionConfig)
          && buildAutomationReadConfig(action.config).allowManual !== buildAutomationReadConfig(input.actionConfig).allowManual) problems.add('representation')
      }
    }
  } catch { problems.add('representation') }
  return [...problems]
}

export function automationReadOwnerHint(isZh: boolean): string {
  return isZh
    ? '保存或启用规则本身不会开启读取或授予数据源权限。备料面板需负责人独立授权手动预览、record.created / record.updated（可明确确认已保存的支持条件）或无条件 schedule.cron / schedule.interval / schedule.date_field；定时配置在原规则编辑器，启用绑定当前保存版本。日期授权还须确认日期字段类型和 schema 版本，每条到期记录分别消耗固定项目预算，项目不从记录推导。record.updated 指已提交更新事件，包括零字段或无实际值变化的更新，不是仅字段值变化时触发。普通测试运行不可执行；其它记录类型及带条件的定时读取尚未接通。'
    : 'Saving or enabling the rule does not start reads or grant source access. In the preparation panel, the owner must separately authorize manual preview, record.created / record.updated (with explicit confirmation of supported saved conditions) or unconditional schedule.cron / schedule.interval / schedule.date_field. Configure schedules in the original rule editor; activation binds the current saved revision. Date activation also requires confirmation of the date field type and schema revision. Each due record consumes a fixed-project allowance separately; the project is not derived from records. record.updated means a committed update event, including zero-field or unchanged-value updates, not only actual field-value changes. Ordinary Test run cannot execute this action. Other record types and conditional scheduled reads are not connected yet.'
}

export function automationReadProblemMessage(problem: AutomationReadAuthoringProblem, isZh: boolean): string {
  const messages: Record<AutomationReadAuthoringProblem, [string, string]> = {
    config: ['只读预览配置无效，请显式重置为固定操作与手动执行选项。', 'Read-preview configuration is invalid. Explicitly reset the fixed operation and manual option.'],
    singleton: ['只读预览必须是唯一顶层动作，请移除其他动作。', 'Read preview must be the only top-level action. Remove the other actions.'],
    trigger: ['只读预览只支持记录或定时触发。', 'Read preview supports only record or schedule triggers.'],
    mode: ['只读预览不能使用工作流任务模式，请关闭该模式。', 'Read preview cannot use workflow job mode. Turn that mode off.'],
    representation: ['只读预览的旧版与动作列表不一致，或嵌套在其他动作中；请显式修复。', 'Read-preview legacy and action-list representations disagree, or the action is nested. Explicitly repair the rule.'],
  }
  return messages[problem][isZh ? 0 : 1]
}
