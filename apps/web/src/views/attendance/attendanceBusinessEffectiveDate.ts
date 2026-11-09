type Translate = (en: string, zh: string) => string

export function withBusinessEffectiveDate<T extends object>(body: T, value: string | undefined): T & { businessEffectiveDate?: string } {
  return value ? { ...body, businessEffectiveDate: value } : body
}

export function businessEffectiveDateError(code: unknown, tr: Translate): string | null {
  switch (code) {
    case 'ATTENDANCE_CALC14_EFFECTIVE_DATE_REQUIRED': return tr('Enter an effective date for this change.', '请为本次变更填写生效日期。')
    case 'ATTENDANCE_CALC14_EFFECTIVE_DATE_INVALID': return tr('Enter a valid effective date.', '请填写有效的生效日期。')
    case 'ATTENDANCE_CALC14_HISTORICAL_AUTHORIZATION_REQUIRED': return tr('Historical dates require separate verification and authorization.', '历史生效日期需单独核验并授权。')
    case 'ATTENDANCE_CALC14_SOURCE_DATE_CONFLICT': return tr('A different change already exists for this date, or the date precedes an existing change. Review the history before choosing a date.', '该日期已有不同变更，或早于已有变更。请核对历史后再选择日期。')
    case 'ATTENDANCE_CALC14_SOURCE_HISTORY_INCOMPLETE': return tr('The required source history is incomplete. Contact an administrator before continuing.', '所需历史资料不完整，请联系管理员核验后再操作。')
    default: return null
  }
}
