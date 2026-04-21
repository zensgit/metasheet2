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

function collectDingTalkActionConfigs(
  actionType: unknown,
  actionConfig: unknown,
  actions: unknown,
): Record<string, unknown>[] {
  const configs: Record<string, unknown>[] = []
  const addIfDingTalkAction = (type: unknown, config: unknown) => {
    if (type !== 'send_dingtalk_group_message' && type !== 'send_dingtalk_person_message') return
    if (isPlainObject(config)) configs.push(config)
  }

  addIfDingTalkAction(actionType, actionConfig)
  if (Array.isArray(actions)) {
    for (const item of actions) {
      if (!isPlainObject(item)) continue
      addIfDingTalkAction(item.type, item.config)
    }
  }

  return configs
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
