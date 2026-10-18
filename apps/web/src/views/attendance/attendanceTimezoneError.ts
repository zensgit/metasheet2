type Translate = (en: string, zh: string) => string

// Only fixed messages for known codes cross into the UI; never render server values.
export function attendanceTimezoneErrorMessage(code: unknown, tr: Translate): string | null {
  switch (code) {
    case 'ATTENDANCE_TIMEZONE_DEFAULT_REQUIRED':
      return tr('The organization has no default attendance rule. Ask an attendance administrator to check the organization’s default rule and upgrade readiness. Refreshing alone will not repair missing configuration.', '本组织尚未配置默认考勤规则。请考勤管理员检查默认规则和升级前置条件；仅刷新不能修复缺失配置。')
    case 'ATTENDANCE_TIMEZONE_DEFAULT_MISSING':
      return tr('The missing default attendance rule cannot be created while existing attendance sources require upgrade checks. Ask an administrator to review the upgrade prerequisites.', '已有考勤配置需要升级检查，暂时无法补建默认考勤规则。请管理员检查升级前置条件。')
    case 'ATTENDANCE_TIMEZONE_FROZEN_CONTEXT_MIGRATION_REQUIRED':
      return tr('This date has a historical attendance record without the required frozen context. Ask an administrator to review the historical data upgrade; refreshing will not resolve it.', '该日期已有历史考勤记录，但缺少所需的冻结上下文。请管理员处理历史数据升级；刷新不能解决此问题。')
    case 'ATTENDANCE_TIMEZONE_DEFAULT_RECOVERY_SOURCE_AMBIGUOUS':
      return tr('Nearby attendance assignments need a verified historical context before the default rule can be restored. Ask an administrator to review the upgrade prerequisites.', '附近日期的考勤安排需要先确认历史上下文，才能恢复默认规则。请管理员检查升级前置条件。')
    case 'ATTENDANCE_TIMEZONE_REPAIR_POSTURE_UNSUPPORTED':
      return tr('This historical attendance context is not supported by the current calculation mode. Ask an administrator to review the upgrade prerequisites.', '当前计算模式不支持该历史考勤上下文。请管理员检查升级前置条件。')
    case 'ATTENDANCE_TIMEZONE_INVALID_ZONE':
      return tr('An attendance timezone is invalid. Ask an attendance administrator to check the timezone configuration, then refresh.', '考勤时区配置无效。请考勤管理员检查时区配置后刷新。')
    case 'ATTENDANCE_TIMEZONE_MULTIPLE_DEFAULTS':
      return tr('The organization has conflicting default attendance rules. Ask an attendance administrator to resolve them, then refresh.', '本组织存在冲突的默认考勤规则。请考勤管理员处理后刷新。')
    case 'ATTENDANCE_TIMEZONE_INVALID_REVISION':
      return tr('The attendance timezone configuration version is invalid. Ask an administrator to check the database upgrade and configuration.', '考勤时区配置版本无效。请管理员检查数据库升级和配置。')
    case 'ATTENDANCE_TIMEZONE_MEMBER_REQUIRED':
      return tr('An active organization membership is required. Ask an administrator to check your organization membership, then sign in again.', '需要有效的组织成员关系。请管理员检查组织归属后重新登录。')
    default:
      return null
  }
}
