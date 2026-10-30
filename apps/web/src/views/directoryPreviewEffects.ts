export const directoryPreviewEffectFields = [
  { key: 'wouldAdmitUsers', label: '将准入本地用户' },
  { key: 'wouldBindAccounts', label: '将绑定账号' },
  { key: 'wouldUnbindAccounts', label: '将解除绑定' },
  { key: 'wouldCreateMemberGroups', label: '将新增成员组' },
  { key: 'wouldSyncMemberGroups', label: '将同步成员组' },
  { key: 'wouldAddMemberGroupMemberships', label: '将加入成员组' },
  { key: 'wouldRemoveMemberGroupMemberships', label: '将移出成员组' },
  { key: 'wouldAssignRoles', label: '将新增角色分配' },
  { key: 'wouldAdmitNamespaces', label: '将新增命名空间准入' },
] as const

export type DirectoryPreviewEffectCounts = Record<typeof directoryPreviewEffectFields[number]['key'], number>

export function formatDirectoryPreviewEffect(value: unknown): string {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : '未提供'
}
