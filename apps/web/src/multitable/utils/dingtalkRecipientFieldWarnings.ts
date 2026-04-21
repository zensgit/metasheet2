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
): string[] {
  const fieldMap = new Map(fields.map((field) => [field.id, field]))
  return parseRecordFieldPaths(value).flatMap((path) => {
    const field = fieldMap.get(path)
    if (!field) {
      return [`record.${path} is not a known field in this sheet; DingTalk group messages expect field IDs that resolve to destination IDs.`]
    }
    if (field.type === 'user') {
      return [`record.${path} is a user field; use DingTalk person recipient fields instead.`]
    }
    if (isDingTalkMemberGroupRecipientField(field)) {
      return [`record.${path} is a member group field; use DingTalk person member-group recipient fields instead.`]
    }
    return []
  })
}

export function listDingTalkPersonMemberGroupRecipientFieldPathWarnings(
  value: unknown,
  fields: readonly DingTalkRecipientWarningField[],
): string[] {
  const fieldMap = new Map(fields.map((field) => [field.id, field]))
  return parseRecordFieldPaths(value).flatMap((path) => {
    const field = fieldMap.get(path)
    if (!field) {
      return [`record.${path} is not a known field in this sheet; DingTalk person member-group recipients expect field IDs that resolve to member group IDs.`]
    }
    if (field.type === 'user') {
      return [`record.${path} is a user field; use Record recipient field paths instead.`]
    }
    if (!isDingTalkMemberGroupRecipientField(field)) {
      return [`record.${path} is not a member group field; DingTalk person member-group recipients expect member group fields.`]
    }
    return []
  })
}
