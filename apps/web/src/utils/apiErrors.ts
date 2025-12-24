export type ApiErrorPayload = {
  code?: string
  message?: string
}

const DEFAULT_MESSAGES: Record<string, string> = {
  FIELD_READONLY: '字段只读，无法编辑',
  VERSION_CONFLICT: '版本冲突，请刷新后重试',
  VALIDATION_ERROR: '数据校验失败',
  NOT_FOUND: '资源不存在',
  CONFLICT: '资源冲突',
}

export function formatApiErrorMessage(error: ApiErrorPayload | undefined, fallback: string) {
  if (!error) return fallback
  if (error.code && DEFAULT_MESSAGES[error.code]) return DEFAULT_MESSAGES[error.code]
  if (error.message && error.message.trim().length > 0) return error.message
  return fallback
}
