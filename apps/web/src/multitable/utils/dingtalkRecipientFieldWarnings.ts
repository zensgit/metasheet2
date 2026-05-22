export interface DingTalkRecipientWarningField {
  id: string
  type?: unknown
  property?: Record<string, unknown> | undefined
}

export function isDingTalkMemberGroupRecipientField(field: { type?: unknown; property?: Record<string, unknown> | undefined }): boolean {
  const type = typeof field.type === 'string' ? field.type.trim().toLowerCase() : ''
  const refKind = typeof field.property?.refKind === 'string' ? field.property.refKind.trim().toLowerCase() : ''
  return refKind === 'member-group'
    || type === 'member-group'
    || type === 'member_group'
    || type === 'membergroup'
}

function parseRecordFieldPaths(value: unknown): string[] {
  if (typeof value !== 'string') return []
  return Array.from(new Set(
    value
      .split(/[\n,]+/)
      .map((entry) => entry.trim().replace(/^record\./, ''))
      .filter(Boolean),
  ))
}

export function listDingTalkGroupDestinationFieldPathWarnings(
  value: unknown,
  fields: readonly DingTalkRecipientWarningField[],
  isZh = false,
): string[] {
  const fieldMap = new Map(fields.map((field) => [field.id, field]))
  return parseRecordFieldPaths(value).flatMap((path) => {
    const field = fieldMap.get(path)
    if (!field) {
      return [isZh
        ? `record.${path} 不是此表中的已知字段；钉钉群消息需要能解析为目标 ID 的字段 ID。`
        : `record.${path} is not a known field in this sheet; DingTalk group messages expect field IDs that resolve to destination IDs.`]
    }
    if (field.type === 'user') {
      return [isZh
        ? `record.${path} 是用户字段；请改用钉钉个人收件人字段。`
        : `record.${path} is a user field; use DingTalk person recipient fields instead.`]
    }
    if (isDingTalkMemberGroupRecipientField(field)) {
      return [isZh
        ? `record.${path} 是成员组字段；请改用钉钉个人成员组收件人字段。`
        : `record.${path} is a member group field; use DingTalk person member-group recipient fields instead.`]
    }
    return []
  })
}

export function listDingTalkPersonRecipientFieldPathWarnings(
  value: unknown,
  fields: readonly DingTalkRecipientWarningField[],
  isZh = false,
): string[] {
  const userFieldIds = new Set(fields
    .filter((field) => field.type === 'user')
    .map((field) => field.id))
  return parseRecordFieldPaths(value)
    .filter((path) => !userFieldIds.has(path))
    .map((path) => isZh
      ? `record.${path} 不是用户字段；钉钉个人消息需要本地用户 ID。`
      : `record.${path} is not a user field; DingTalk person messages expect local user IDs.`)
}

export function listDingTalkPersonMemberGroupRecipientFieldPathWarnings(
  value: unknown,
  fields: readonly DingTalkRecipientWarningField[],
  isZh = false,
): string[] {
  const fieldMap = new Map(fields.map((field) => [field.id, field]))
  return parseRecordFieldPaths(value).flatMap((path) => {
    const field = fieldMap.get(path)
    if (!field) {
      return [isZh
        ? `record.${path} 不是此表中的已知字段；钉钉个人成员组收件人需要能解析为成员组 ID 的字段 ID。`
        : `record.${path} is not a known field in this sheet; DingTalk person member-group recipients expect field IDs that resolve to member group IDs.`]
    }
    if (field.type === 'user') {
      return [isZh
        ? `record.${path} 是用户字段；请改用记录收件人字段路径。`
        : `record.${path} is a user field; use Record recipient field paths instead.`]
    }
    if (!isDingTalkMemberGroupRecipientField(field)) {
      return [isZh
        ? `record.${path} 不是成员组字段；钉钉个人成员组收件人需要成员组字段。`
        : `record.${path} is not a member group field; DingTalk person member-group recipients expect member group fields.`]
    }
    return []
  })
}
