// User recycle bin copy. Same key-table + useLocale().isZh pattern as
// workflowHubLabels.ts. User Management's older chrome is still Chinese literals;
// the recycle bin and the danger-zone action that feeds it go through this table.

export type UserRecycleLabelKey =
  | 'tab'
  | 'title'
  | 'hint'
  | 'empty'
  | 'loading'
  | 'search'
  | 'refresh'
  | 'colMember'
  | 'colDeletedAt'
  | 'colDeletedBy'
  | 'colPurgeAfter'
  | 'restore'
  | 'restoreSelected'
  | 'purgePlaceholder'
  | 'purgeSelected'
  | 'purgedHint'
  | 'dangerSummary'
  | 'dangerHint'
  | 'dangerPhrase'
  | 'dangerButton'
  | 'moved'
  | 'restored'
  | 'purged'
  | 'unknownActor'

const ZH: Record<UserRecycleLabelKey, string> = {
  tab: '回收站',
  title: '回收站',
  hint: '移入回收站的账号不能登录，也不会出现在成员列表和目录里。默认保留 {days} 天后自动清除个人身份；考勤、审计和目录历史仍保留。',
  empty: '回收站是空的',
  loading: '正在加载回收站…',
  search: '搜索回收站',
  refresh: '刷新',
  colMember: '成员',
  colDeletedAt: '移入时间',
  colDeletedBy: '操作者',
  colPurgeAfter: '预计清除',
  restore: '恢复',
  restoreSelected: '恢复所选',
  purgePlaceholder: '输入「立即清除」',
  purgeSelected: '立即清除所选',
  purgedHint: '清除后不能恢复。账号编号还在，姓名、邮箱和登录方式会被抹掉，考勤和审计记录不会被删。',
  dangerSummary: '移入回收站',
  dangerHint: '停用可以随时恢复。确认「永久删除」会把所选账号移入回收站：立即不能登录，并从成员列表和目录中隐藏。保留期内可在「回收站」恢复；到期后自动清除个人身份，考勤、审计和目录历史不删。',
  dangerPhrase: '输入「永久删除」',
  dangerButton: '确认移入回收站',
  moved: '已移入回收站：成功 {ok}，失败 {fail}',
  restored: '已恢复：成功 {ok}，失败 {fail}',
  purged: '已清除：成功 {ok}，失败 {fail}',
  unknownActor: '未知',
}

const EN: Record<UserRecycleLabelKey, string> = {
  tab: 'Recycle bin',
  title: 'Recycle bin',
  hint: 'Accounts in the recycle bin cannot sign in and are hidden from member and directory lists. Personal identity is cleared after {days} days by default. Attendance, audit, and directory history stay.',
  empty: 'The recycle bin is empty',
  loading: 'Loading the recycle bin…',
  search: 'Search the recycle bin',
  refresh: 'Refresh',
  colMember: 'Member',
  colDeletedAt: 'Deleted at',
  colDeletedBy: 'Deleted by',
  colPurgeAfter: 'Purge after',
  restore: 'Restore',
  restoreSelected: 'Restore selected',
  purgePlaceholder: 'Type「立即清除」',
  purgeSelected: 'Purge selected now',
  purgedHint: 'Purge cannot be undone. The account id stays so history remains; name, email, and sign-in methods are cleared.',
  dangerSummary: 'Move to recycle bin',
  dangerHint: 'Disable can be undone. Confirming permanent delete moves the selected accounts into the recycle bin: they cannot sign in and disappear from member and directory lists. Restore them before the retention window ends. After that, personal identity is cleared and attendance, audit, and directory history stay.',
  dangerPhrase: 'Type “永久删除”',
  dangerButton: 'Move to recycle bin',
  moved: 'Moved to the recycle bin: {ok} succeeded, {fail} failed',
  restored: 'Restored: {ok} succeeded, {fail} failed',
  purged: 'Purged: {ok} succeeded, {fail} failed',
  unknownActor: 'Unknown',
}

export function userRecycleLabel(isZh: boolean, key: UserRecycleLabelKey, vars: Record<string, string | number> = {}): string {
  const template = (isZh ? ZH : EN)[key]
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => String(vars[name] ?? ''))
}
