export interface DingTalkNotificationTemplateToken {
  key: string
  label: string
  value: string
}

export const DINGTALK_TITLE_TEMPLATE_TOKENS: DingTalkNotificationTemplateToken[] = [
  { key: 'recordId', label: 'Record ID', value: '{{recordId}}' },
  { key: 'sheetId', label: 'Sheet ID', value: '{{sheetId}}' },
  { key: 'actorId', label: 'Actor ID', value: '{{actorId}}' },
]

export const DINGTALK_BODY_TEMPLATE_TOKENS: DingTalkNotificationTemplateToken[] = [
  ...DINGTALK_TITLE_TEMPLATE_TOKENS,
  { key: 'recordField', label: 'Record field', value: '{{record.xxx}}' },
]

export function appendTemplateToken(currentValue: string, token: string, multiline = false): string {
  if (!currentValue.trim()) return token
  if (currentValue.endsWith(token)) return currentValue
  if (/\s$/.test(currentValue)) return `${currentValue}${token}`
  return multiline ? `${currentValue}\n${token}` : `${currentValue} ${token}`
}
