const countFields: Record<string, string> = {
  accountsSeen: '目录账号数', accountsSynced: '同步账号数',
  departmentsSeen: '目录部门数', departmentsSynced: '同步部门数',
  pendingCount: '待处理数', linkedCount: '已绑定数',
  rootDepartmentChildCount: '根部门子部门数',
  rootDepartmentDirectUserCount: '根部门直属成员数',
  rootDepartmentDirectUserCountWithAccessLimit: '含受限直属成员数',
  managerCount: '主管数', linkedManagerCount: '已绑定主管数',
  missingManagerCount: '缺失主管数', consecutiveFailureCount: '连续失败数',
  inactiveLinkedCount: '停用且仍绑定数', durationMs: '耗时（毫秒）',
}
const booleanFields: Record<string, string> = {
  rootDepartmentDirectUserHasMore: '直属成员还有更多',
  rootDepartmentDirectUserHasMoreWithAccessLimit: '含受限成员还有更多',
}

export function directoryAlertDetailRows(details: unknown): Array<{ label: string; value: string }> {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return []
  const record = details as Record<string, unknown>
  const rows: Array<{ label: string; value: string }> = []
  for (const [key, label] of Object.entries(countFields)) {
    const value = record[key]
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) rows.push({ label, value: String(value) })
  }
  for (const [key, label] of Object.entries(booleanFields)) {
    if (typeof record[key] === 'boolean') rows.push({ label, value: record[key] ? '是' : '否' })
  }
  return rows
}
