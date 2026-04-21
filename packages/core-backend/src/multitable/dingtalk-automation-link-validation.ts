export type AutomationLinkQueryFn = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: unknown[]; rowCount?: number | null }>

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (isPlainObject(value)) return value
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown
      return isPlainObject(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }
  return {}
}

function parsePublicFormExpiryMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (value instanceof Date) return value.getTime()
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  if (/^\d+$/.test(trimmed)) {
    const numeric = Number(trimmed)
    return Number.isFinite(numeric) ? numeric : null
  }
  const parsed = Date.parse(trimmed)
  return Number.isFinite(parsed) ? parsed : null
}

type DingTalkAutomationActionType = 'send_dingtalk_group_message' | 'send_dingtalk_person_message'

type DingTalkAutomationActionEntry = {
  type: DingTalkAutomationActionType
  config: Record<string, unknown> | null
}

function isDingTalkAutomationActionType(value: unknown): value is DingTalkAutomationActionType {
  return value === 'send_dingtalk_group_message' || value === 'send_dingtalk_person_message'
}

function collectDingTalkActionEntries(
  actionType: unknown,
  actionConfig: unknown,
  actions: unknown,
): DingTalkAutomationActionEntry[] {
  const entries: DingTalkAutomationActionEntry[] = []
  const addIfDingTalkAction = (type: unknown, config: unknown) => {
    if (!isDingTalkAutomationActionType(type)) return
    entries.push({ type, config: isPlainObject(config) ? config : null })
  }

  addIfDingTalkAction(actionType, actionConfig)
  if (Array.isArray(actions)) {
    for (const item of actions) {
      if (!isPlainObject(item)) continue
      addIfDingTalkAction(item.type, item.config)
    }
  }

  return entries
}

function collectDingTalkActionConfigs(
  actionType: unknown,
  actionConfig: unknown,
  actions: unknown,
): Record<string, unknown>[] {
  return collectDingTalkActionEntries(actionType, actionConfig, actions)
    .map((entry) => entry.config)
    .filter((config): config is Record<string, unknown> => Boolean(config))
}

function normalizeStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === 'string')
      .flatMap((entry) => entry.split(/[\n,]+/))
      .map((entry) => entry.trim())
      .filter(Boolean)
  }
  if (typeof value === 'string') {
    return value
      .split(/[\n,]+/)
      .map((entry) => entry.trim())
      .filter(Boolean)
  }
  return []
}

function normalizeFieldPaths(value: unknown): string[] {
  return normalizeStringList(value)
    .map((entry) => entry.replace(/^record\./, '').trim())
    .filter(Boolean)
}

function hasText(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

function normalizeDingTalkMessageConfig(config: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...config }
  if (!hasText(normalized.titleTemplate) && hasText(normalized.title)) {
    normalized.titleTemplate = normalized.title
  }
  if (!hasText(normalized.bodyTemplate) && hasText(normalized.content)) {
    normalized.bodyTemplate = normalized.content
  }
  return normalized
}

export function normalizeDingTalkAutomationActionInputs(
  actionType: unknown,
  actionConfig: unknown,
  actions: unknown,
): { actionConfig: unknown; actions: unknown } {
  const normalizedActionConfig = isDingTalkAutomationActionType(actionType) && isPlainObject(actionConfig)
    ? normalizeDingTalkMessageConfig(actionConfig)
    : actionConfig
  const normalizedActions = Array.isArray(actions)
    ? actions.map((item) => {
      if (!isPlainObject(item) || !isDingTalkAutomationActionType(item.type) || !isPlainObject(item.config)) return item
      return { ...item, config: normalizeDingTalkMessageConfig(item.config) }
    })
    : actions
  return { actionConfig: normalizedActionConfig, actions: normalizedActions }
}

function validateGroupMessageConfig(config: Record<string, unknown>): string | null {
  const destinationIds = [
    ...normalizeStringList(config.destinationId),
    ...normalizeStringList(config.destinationIds),
  ]
  const destinationFieldPaths = [
    ...normalizeFieldPaths(config.destinationIdFieldPath),
    ...normalizeFieldPaths(config.destinationIdFieldPaths),
  ]
  if (destinationIds.length === 0 && destinationFieldPaths.length === 0) {
    return 'At least one DingTalk destination or record destination field path is required'
  }
  if (!hasText(config.titleTemplate)) return 'DingTalk titleTemplate is required'
  if (!hasText(config.bodyTemplate)) return 'DingTalk bodyTemplate is required'
  return null
}

function validatePersonMessageConfig(config: Record<string, unknown>): string | null {
  const userIds = normalizeStringList(config.userIds)
  const memberGroupIds = normalizeStringList(config.memberGroupIds)
  const recipientFieldPaths = [
    ...normalizeFieldPaths(config.userIdFieldPath),
    ...normalizeFieldPaths(config.userIdFieldPaths),
  ]
  const memberGroupRecipientFieldPaths = [
    ...normalizeFieldPaths(config.memberGroupIdFieldPath),
    ...normalizeFieldPaths(config.memberGroupIdFieldPaths),
  ]
  if (
    userIds.length === 0
    && memberGroupIds.length === 0
    && recipientFieldPaths.length === 0
    && memberGroupRecipientFieldPaths.length === 0
  ) {
    return 'At least one local userId, memberGroupId, record recipient field path, or member group record field path is required'
  }
  if (!hasText(config.titleTemplate)) return 'DingTalk titleTemplate is required'
  if (!hasText(config.bodyTemplate)) return 'DingTalk bodyTemplate is required'
  return null
}

export function validateDingTalkAutomationActionConfigs(
  actionType: unknown,
  actionConfig: unknown,
  actions: unknown,
): string | null {
  const normalized = normalizeDingTalkAutomationActionInputs(actionType, actionConfig, actions)
  for (const entry of collectDingTalkActionEntries(actionType, normalized.actionConfig, normalized.actions)) {
    if (!entry.config) return 'DingTalk action config must be an object'
    const error = entry.type === 'send_dingtalk_group_message'
      ? validateGroupMessageConfig(entry.config)
      : validatePersonMessageConfig(entry.config)
    if (error) return error
  }
  return null
}

export function collectDingTalkAutomationLinkIds(
  actionType: unknown,
  actionConfig: unknown,
  actions: unknown,
): { publicFormViewIds: string[]; internalViewIds: string[] } {
  const publicFormViewIds: string[] = []
  const internalViewIds: string[] = []

  for (const config of collectDingTalkActionConfigs(actionType, actionConfig, actions)) {
    const publicFormViewId = typeof config.publicFormViewId === 'string' ? config.publicFormViewId.trim() : ''
    const internalViewId = typeof config.internalViewId === 'string' ? config.internalViewId.trim() : ''
    if (publicFormViewId) publicFormViewIds.push(publicFormViewId)
    if (internalViewId) internalViewIds.push(internalViewId)
  }

  return {
    publicFormViewIds: Array.from(new Set(publicFormViewIds)),
    internalViewIds: Array.from(new Set(internalViewIds)),
  }
}

export async function validateDingTalkAutomationLinks(
  query: AutomationLinkQueryFn,
  sheetId: string,
  actionType: unknown,
  actionConfig: unknown,
  actions: unknown,
  nowMs = Date.now(),
): Promise<string | null> {
  const { publicFormViewIds, internalViewIds } = collectDingTalkAutomationLinkIds(actionType, actionConfig, actions)

  if (publicFormViewIds.length > 0) {
    const result = await query(
      `SELECT id::text AS id, type, config
         FROM meta_views
        WHERE sheet_id = $1
          AND id::text = ANY($2::text[])`,
      [sheetId, publicFormViewIds],
    )
    const viewEntries: Array<[string, Record<string, unknown>]> = []
    for (const row of result.rows) {
      if (!isPlainObject(row)) continue
      const id = typeof row.id === 'string' ? row.id.trim() : ''
      if (id) viewEntries.push([id, row])
    }
    const viewsById = new Map<string, Record<string, unknown>>(viewEntries)

    for (const id of publicFormViewIds) {
      const view = viewsById.get(id)
      if (!view) return `Public form view not found: ${id}`
      if (view.type !== 'form') return `Public form view is not a form view: ${id}`

      const viewConfig = parseJsonObject(view.config)
      const publicForm = isPlainObject(viewConfig.publicForm) ? viewConfig.publicForm : null
      const publicToken = typeof publicForm?.publicToken === 'string' ? publicForm.publicToken.trim() : ''
      if (publicForm?.enabled !== true || !publicToken) {
        return `Selected public form view is not shared: ${id}`
      }

      const expiryMs = parsePublicFormExpiryMs(publicForm.expiresAt ?? publicForm.expiresOn)
      if (expiryMs !== null && nowMs >= expiryMs) {
        return `Selected public form view has expired: ${id}`
      }
    }
  }

  if (internalViewIds.length > 0) {
    const result = await query(
      `SELECT id::text AS id
         FROM meta_views
        WHERE sheet_id = $1
          AND id::text = ANY($2::text[])`,
      [sheetId, internalViewIds],
    )
    const foundIds = new Set(
      result.rows
        .map((row) => (isPlainObject(row) && typeof row.id === 'string' ? row.id.trim() : ''))
        .filter(Boolean),
    )
    const missingIds = internalViewIds.filter((id) => !foundIds.has(id))
    if (missingIds.length > 0) return `Internal processing view not found: ${missingIds.join(', ')}`
  }

  return null
}
