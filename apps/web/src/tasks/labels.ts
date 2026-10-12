// Label tables for the tasks surfaces — M4 frontend design §9 (`R20`, option (a): every
// task-surface string, including the M2 / M3 copy that used to be hard-coded in TasksView.vue,
// the nav badge component and tasksDateDisplay.ts, lives here).
// Shape: a flat `*_ZH` / `*_EN` pair,
// `EN: Record<keyof typeof ZH, string>` so vue-tsc enforces key parity, consumed as
// `computed(() => (isZh.value ? ZH : EN))` from `useLocale()` and read as `t.xxx` in templates.
// tests/tasks-labels.spec.ts pins the same parity at runtime plus: every ZH value contains CJK,
// no EN value does, and the two never coincide.
//
// RULED(2026-10-07): [R20] — option (a): every task string lives here, the M2 / M3 ones
// included, with the ZH / EN spec.
//
// Three tables:
//   - `TASKS_ZH` / `TASKS_EN`         plain strings (view chrome, states, inline error copy).
//   - `TASKS_FMT_ZH` / `TASKS_FMT_EN` sentences with an interpolated value, as functions.
//   - `TASKS_CODE_KEYS`               contract error code -> key of the plain-string table, read
//                                     through `codeMessage(code, t)`.
//
// The Chinese values of the retrofitted M2 / M3 strings are byte-identical to what the views
// rendered before this table existed — the existing specs pin them with `.toBe`.
//
// Not in these tables: `data-testid` values, `aria-*` attribute NAMES, and the route meta
// `title` / `titleZh` (the route table carries both languages itself).

export const TASKS_ZH = {
  // /tasks — list page chrome
  listTitle: '任务',
  viewSwitcherLabel: '任务视角',
  viewAssigned: '分配给我',
  viewFollowing: '关注中',
  viewCreated: '我创建的',
  viewDelegated: '我委派的',
  viewAnyRole: '任一角色',
  createTitlePlaceholder: '新建任务标题',
  create: '创建',
  createInvalidTitle: '标题为空或包含无法保存的字符',
  createFailed: '创建任务失败，请稍后重试',
  listEmpty: '暂无任务',
  listLoadFailed: '加载任务失败，请稍后重试',
  loading: '加载中…',
  statusOpen: '进行中',
  statusDone: '已完成',
  complete: '完成',
  reopen: '重启',
  modeAll: '全部负责人完成',
  modeAny: '任一负责人完成',

  // context states and the org-guidance block (shared by every task page)
  orgMissing: '请先选择一个组织后再查看任务',
  contextUnavailable: '任务功能未启用或当前服务不支持',
  contextForbidden: '您没有权限查看任务',
  contextError: '加载任务时出现错误，请稍后重试',

  // action banner (list row actions and every detail action share it)
  actionForbidden: '您没有权限修改此任务',
  actionFailed: '操作失败，请稍后重试',

  // /tasks/:id — detail page chrome
  detailTitle: '任务详情',
  backToList: '返回任务列表',
  detailNotFound: '未找到该任务',
  detailForbidden: '您没有权限查看此任务',
  detailLoadFailed: '加载任务详情失败，请稍后重试',
  assigneeNotDone: '未完成',
  remove: '移除',
  addAssigneePlaceholder: '添加负责人（用户ID）',
  addAssignee: '添加负责人',
  switchModeLabel: '切换完成模式：',
  subtasksHeading: '子任务',
  depthLabel: '层级深度：',
  parentLabel: '父任务：',
  noChildren: '暂无子任务',
  setParentPlaceholder: '设为子任务（填写父任务ID）',
  setParent: '设置父任务',
  makeIndependent: '取消父任务',
  followersHeading: '关注人',
  followersUnknown: '关注人列表在有变更后才会显示',
  addFollowerPlaceholder: '添加关注人（用户ID）',
  addFollower: '添加关注人',
  leave: '退出关注',
  commentsHeading: '评论',
  commentsLoadFailed: '加载评论失败，请稍后重试',
  commentsTruncated: '评论较多，未全部显示；较新的评论可能不在下方列表中',
  commentDeleted: '已删除',
  save: '保存',
  cancel: '取消',
  edit: '编辑',
  delete: '删除',
  postComment: '发表评论',
  deleteTask: '删除任务',
  deleteConfirmPrompt: '确认删除此任务？此操作无法撤销。',
  deleteConfirm: '确认删除',

  // /tasks list header — the entry to /tasks/settings (design §2.2)
  settingsLink: '设置',

  // /tasks/settings (design §4.5, §7.1). The page also reads `backToList`, `loading`, `save`, the
  // four context-state strings and the six settings codes below.
  // RULED(2026-10-07): [R02] — the four fields and the wording of their closed sets.
  // RULED(2026-10-07): [R07] — the daily reminder needs a time zone.
  settingsTitle: '任务设置',
  // ASSUMPTION(task-m4-fe): [own-19] (PR-3a) — the read is a 404 both for a missing route and for
  // a missing org, so the copy names both causes.
  settingsNotFound: '无法读取设置：当前服务不支持，或尚未选择组织',
  settingsForbidden: '您没有权限查看任务设置',
  settingsLoadFailed: '加载任务设置失败，请稍后重试',
  settingsBadgeScopeLegend: '红点统计范围',
  settingsBadgeScopeOff: '关闭',
  settingsBadgeScopeOverdue: '仅逾期',
  settingsBadgeScopeOverdueOrToday: '逾期与今天到期',
  settingsDailyReminder: '每日汇总提醒',
  settingsDailyReminderNote: '按你的时区每天固定时刻发送；是否实际发送取决于服务端配置',
  settingsRemindPolicyLabel: '新任务的缺省提醒',
  settingsRemindPolicyDefault: '按缺省规则',
  settingsRemindPolicyNone: '不提醒',
  settingsTimeZoneLabel: '时区',
  settingsTimeZonePlaceholder: 'IANA 时区名，例如 Asia/Shanghai',
  settingsUseBrowserTimeZone: '使用浏览器时区',
  settingsTimeZoneAutofilled: '已按浏览器时区填入，可修改',
  settingsSaved: '已保存',
  settingsSaveForbidden: '您没有权限修改任务设置',
  settingsSaveUnavailable: '无法保存设置：当前服务不支持',
  settingsSaveFailed: '保存设置失败，请稍后重试',

  // /tasks/:id — the read-only rows of the PR-3a S4 fields (design §7.2's display layer)
  detailStartLabel: '开始：',
  noStartDate: '无开始日期',
  detailDescriptionLabel: '描述：',
  noDescription: '无描述',
  detailRemindLabel: '提醒：',
  noReminder: '不提醒',

  // /tasks/:id — the editor (design §4.3, §7.2, §7.3). The submit button reads `save`.
  // RULED(2026-10-07): [R03] — editing through one PATCH, with a review prompt after a 409.
  editorHeading: '编辑任务',
  editorTitleLabel: '标题',
  editorDescriptionLabel: '描述',
  editorDueDateLabel: '截止日期',
  editorDueTimeLabel: '截止时间',
  editorStartDateLabel: '开始日期',
  editorStartTimeLabel: '开始时间',
  editorTimeZoneLabel: '时区',
  editorTimeZonePlaceholder: 'IANA 时区名，例如 Asia/Shanghai',
  editorUseBrowserTimeZone: '使用浏览器时区',
  editorReminderLegend: '提醒',
  editorReminderNone: '不提醒',
  editorReminderAt: '指定时刻',
  editorReminderTimeLabel: '提醒时刻',
  // ASSUMPTION(task-m4-fe): [own-06] (PR-3a) — a PATCH never derives the reminder from the due date.
  editorReminderNotFollowing: '提醒时刻不会自动跟随截止日期',
  editorDiscard: '放弃我的修改',
  editorServerUpdated: '服务端已更新；你未保存的修改仍保留',
  // `VERSION_CONFLICT` without a usable `currentVersion` in the 409 body; with one, the
  // `versionConflict` format entry renders instead.
  versionConflictUnknown: '任务已被他人修改，已载入最新内容，请核对后再保存',

  // /tasks/:id — the lists holding the task (design §4.3 `TaskDetailLists`)
  // RULED(2026-10-07): [R04] — the section does not assume the task shows in any list view.
  listsHeading: '所属清单',
  listsEmpty: '尚未加入任何清单',
  listsNotMember: '（你不是成员）',
  listsMineUnavailable: '暂时无法读取你的清单，清单以 ID 显示',
  listsAddLabel: '加入清单',
  listsAddPlaceholder: '选择清单',
  listsAdd: '加入',
  listsNoCandidates: '没有可加入的清单',
  listsRemove: '移出',
  listsRemoveConfirmPrompt: '确认将此任务移出该清单？',
  listsRemoveConfirm: '确认移出',
  // RULED(2026-10-07): [own-25] (PR-3a, R12 (a1)) — adding needs a direct role on the task;
  // the copy reads the folded 404 that way (`[fe-02]`).
  listsAddNotFound: '无法加入：你需要是该任务的创建人或负责人',

  // Shared by the lists sidebar and the list page's activity panel.
  loadMore: '加载更多',
  listRoleOwner: '所有者',
  listRoleEdit: '可编辑',
  listRoleRead: '只读',
  listArchivedMark: '已归档',

  // /tasks — the lists sidebar (design §4.1 `TaskListsSidebar`)
  sidebarHeading: '我的清单',
  sidebarShowArchived: '显示已归档',
  sidebarEmpty: '还没有清单',
  sidebarLoadFailed: '加载清单失败，请稍后重试',
  sidebarForbidden: '您没有权限查看任务清单',
  sidebarUnavailable: '清单功能暂不可用',
  sidebarLoadMoreFailed: '加载更多清单失败，请稍后重试',
  sidebarCreateLabel: '新清单名称',
  sidebarCreatePlaceholder: '清单名称',
  sidebarCreate: '新建清单',
  sidebarCreateForbidden: '您没有权限创建清单',
  sidebarCreateFailed: '创建清单失败，请稍后重试',

  // /task-lists/:id — the list page (design §2.4, §4.2). The page also reads `backToList`,
  // `loading`, `save`, `cancel`, `actionFailed`, `listsRemoveConfirm`, the four context-state
  // strings and the list / item codes below.
  listPageTitle: '任务清单',
  // ASSUMPTION(task-m4-fe): [own-09] (PR-3a) — a missing list, another org's list and a list the
  // viewer is not a member of are one 404, so the copy names both causes.
  listNotFound: '清单不存在或你不是成员',
  listForbidden: '您没有权限查看此清单',
  listPageLoadFailed: '加载清单失败，请稍后重试',
  listMyRoleLabel: '我的角色：',
  listRename: '改名',
  listRenameLabel: '清单名称',
  listArchive: '归档',
  listUnarchive: '取消归档',
  listWriteNotFound: '清单不可用或你已不是成员',
  listWriteForbidden: '您没有权限修改此清单',
  listItemsHeading: '清单内的任务',
  listItemsEmpty: '清单中还没有任务',
  listItemsUnavailable: '暂时无法读取清单中的任务',
  listItemsTruncated: '清单中的任务较多，未全部显示',
  listAddTaskLabel: '加入任务（任务 ID）',
  listAddTaskPlaceholder: '任务 ID',
  listAddTask: '加入任务',
  // RULED(2026-10-07): [own-25] (PR-3a, R12 (a1)) — adding needs a direct role on the task
  // (creator or assignee; an edit right that comes only from a list does not count), and the 404
  // folds that with a missing task and an unavailable list.
  listAddTaskNotFound: '任务不存在、你不是它的创建人或负责人，或清单不可用',
  listRemoveTask: '移出清单',
  listRemoveTaskConfirmPrompt: '确认将此任务移出清单？',
  // RULED(2026-10-07): [R19] — the list's activity, read on demand.
  listEventsToggle: '动态',
  listEventsHeading: '清单动态',
  listEventsEmpty: '暂无动态',
  listEventsLoadFailed: '加载动态失败，请稍后重试',
  // The words of the activity's closed event-type set (`TASKS_LIST_EVENT_KEYS` below).
  listEventCreated: '创建了清单',
  listEventRenamed: '重命名了清单',
  listEventArchived: '归档了清单',
  listEventUnarchived: '取消归档了清单',
  listEventOwnerTransferred: '转让了所有权',
  listEventMemberAdded: '添加了成员',
  listEventMemberRemoved: '移除了成员',
  listEventMemberRoleChanged: '更改了成员角色',
  listEventItemAdded: '加入了任务',
  listEventItemRemoved: '移出了任务',
  listEventGroupCreated: '新建了分组',
  listEventGroupRenamed: '重命名了分组',
  listEventGroupDeleted: '删除了分组',
  listEventFieldBound: '绑定了字段',
  listEventFieldUnbound: '解绑了字段',

  // /task-lists/:id — the members dialog (design §5.2) and the header button that opens it. The
  // dialog also reads `loading`, `remove`, `cancel`, `actionFailed`, the three role labels,
  // `listWriteNotFound`, `listWriteForbidden`, `listForbidden`, `codeLimitMembers` and the member
  // codes below.
  listMembers: '成员',
  membersTitle: '清单成员',
  membersEmpty: '暂无成员',
  membersLoadFailed: '加载成员失败，请稍后重试',
  membersCreatorMark: '创建人',
  membersTransfer: '设为所有者',
  membersTransferConfirm: '确认转让',
  membersAddLabel: '添加成员（用户 ID）',
  membersAddPlaceholder: '用户 ID',
  membersAddRoleLabel: '角色',
  membersAdd: '添加成员',
  membersLeave: '退出清单',
  membersLeavePrompt: '确认退出此清单？',
  membersLeaveConfirm: '确认退出',
  membersClose: '关闭',

  // The grouping board (design §4.4, §6) — the list page's groups and the personal groups of the
  // assigned view. It also reads `save`, `cancel`, `listRename`, `actionFailed`, `codeLimitGroups`
  // and the group codes below.
  groupsUnavailable: '分组不可用',
  groupsRefresh: '刷新',
  groupsUnsorted: '未排序',
  groupsEmpty: '此分组暂无任务',
  groupsDragHandle: '拖动以排序',
  groupsMoveUp: '上移',
  groupsMoveDown: '下移',
  groupsAddToOrder: '加入排序',
  groupsSaving: '正在保存顺序',
  groupsReorderOff: '部分任务未显示，排序已停用',
  groupsCreateLabel: '新分组名称',
  groupsCreatePlaceholder: '分组名称',
  groupsCreate: '新建分组',
  groupsRenameLabel: '分组新名称',
  // ASSUMPTION(task-m4-fe): [own-24] (PR-3a) — the personal default group has no id before its row
  // exists, so it cannot be renamed yet.
  groupsDefaultRenameHint: '首次排序或新建分组后可改名',
  groupsDelete: '删除分组',
  groupsDeleteConfirm: '确认删除',
  groupsNotFound: '任务或分组已不可用',
  groupsForbidden: '您没有权限调整分组',

  // tasksDateDisplay.ts — the all-day form's placeholder and time-zone brackets (§9.1: the EN
  // brackets are ASCII because the fullwidth pair counts as CJK in the parity spec's class)
  noDueDate: '无截止日期',
  timeZoneOpen: '（',
  timeZoneClose: '）',

  // Contract error codes -> inline copy (design §9.2 / §5.3). Keyed by `TASKS_CODE_KEYS` below.
  // M3 contract (task-m3-backend-design-20260928.md):
  codeInvalidParent: '无效的父任务',
  codeDepthExceeded: '任务层级已达上限',
  codeInvalidAssignees: '无效的用户',
  codeLimit: '人数已达上限',
  codeInvalidMode: '无效的完成模式',
  codeCommentBlank: '评论内容不能为空',
  codeCommentTooLong: '评论内容过长',
  codeCommentInvalidChar: '评论包含无法保存的字符',
  codeHasChildren: '请先删除子任务',
  codeTaskBusy: '任务正在被修改，请稍后重试',
  // PR-3a contract, task editing (S4). `VERSION_CONFLICT` carries a version number and is the
  // `versionConflict` entry of the format table instead.
  codeInvalidVersion: '版本信息缺失，请刷新页面',
  codeInvalidTitle: '标题不能为空',
  codeInvalidDescription: '描述过长或包含无法保存的字符',
  codeInvalidDate: '日期或时间格式不正确',
  codeInvalidTimeZone: '无效的时区',
  codeTimeZoneRequired: '设置日期时必须指定时区',
  codeInvalidRemindAt: '提醒时刻格式不正确',
  // PR-3a contract, settings (S3).
  codeInvalidSettings: '设置格式不正确',
  codeInvalidBadgeScope: '无效的红点范围',
  codeInvalidDailyReminderEnabled: '无效的每日提醒开关',
  codeInvalidPolicy: '无效的提醒策略',
  codeDailyReminderRequiresTimeZone: '开启每日提醒需要先设置时区',
  // PR-3a contract, lists / items / groups (S5, S7, S8).
  codeInvalidName: '名称不能为空',
  codeNameTooLong: '名称过长',
  codeInvalidTask: '无效的任务',
  codeIsDefault: '默认分组不能删除',
  codeInvalidGroup: '分组不存在',
  codeInvalidPosition: '位置已变化，请刷新后重试',
  // PR-3a contract, list members (S6); `INACTIVE_ORG_MEMBER` also answers the task create and the
  // assignee / follower adds (S9).
  codeInvalidMember: '无效的用户',
  codeInvalidRole: '无效的角色',
  codeInactiveOrgMember: '该用户不在当前组织或已停用',
  codeOwnerMustTransfer: '请先转让所有权',
  codeCreatedByImmutable: '清单创建人不能被移除',
  codeTargetNotMember: '对方不是清单成员',
  // `LIMIT` is one code with three call-site readings on the M4 surfaces (§9.2); the call site
  // picks the key, `codeMessage('LIMIT', t)` keeps the M3 reading (`codeLimit`).
  // ASSUMPTION(task-m4-fe): [D14] — the "10 lists per task" figure.
  codeLimitMembers: '成员数已达上限',
  codeLimitTaskLists: '一个任务最多属于 10 个清单',
  codeLimitGroups: '分组数已达上限',
}

export type TasksText = typeof TASKS_ZH

export const TASKS_EN: Record<keyof typeof TASKS_ZH, string> = {
  listTitle: 'Tasks',
  viewSwitcherLabel: 'Task views',
  viewAssigned: 'Assigned to me',
  viewFollowing: 'Following',
  viewCreated: 'Created by me',
  viewDelegated: 'Delegated by me',
  viewAnyRole: 'Any role',
  createTitlePlaceholder: 'New task title',
  create: 'Create',
  createInvalidTitle: 'The title is empty or contains characters that cannot be saved',
  createFailed: 'Could not create the task. Please try again later.',
  listEmpty: 'No tasks yet',
  listLoadFailed: 'Could not load tasks. Please try again later.',
  loading: 'Loading…',
  statusOpen: 'In progress',
  statusDone: 'Completed',
  complete: 'Complete',
  reopen: 'Reopen',
  modeAll: 'All assignees complete',
  modeAny: 'Any assignee completes',

  orgMissing: 'Select an organization to view tasks',
  contextUnavailable: 'Tasks are not enabled, or this service does not support them',
  contextForbidden: 'You do not have permission to view tasks',
  contextError: 'Something went wrong while loading tasks. Please try again later.',

  actionForbidden: 'You do not have permission to change this task',
  actionFailed: 'The action failed. Please try again later.',

  detailTitle: 'Task details',
  backToList: 'Back to task list',
  detailNotFound: 'Task not found',
  detailForbidden: 'You do not have permission to view this task',
  detailLoadFailed: 'Could not load the task details. Please try again later.',
  assigneeNotDone: 'Not completed',
  remove: 'Remove',
  addAssigneePlaceholder: 'Add assignee (user ID)',
  addAssignee: 'Add assignee',
  switchModeLabel: 'Completion mode:',
  subtasksHeading: 'Subtasks',
  depthLabel: 'Depth: ',
  parentLabel: 'Parent task:',
  noChildren: 'No subtasks yet',
  setParentPlaceholder: 'Make this a subtask (parent task ID)',
  setParent: 'Set parent task',
  makeIndependent: 'Remove parent task',
  followersHeading: 'Followers',
  followersUnknown: 'The follower list appears after a change is made',
  addFollowerPlaceholder: 'Add follower (user ID)',
  addFollower: 'Add follower',
  leave: 'Unfollow',
  commentsHeading: 'Comments',
  commentsLoadFailed: 'Could not load comments. Please try again later.',
  commentsTruncated: 'There are many comments and not all are shown; newer comments may be missing from the list below',
  commentDeleted: 'Deleted',
  save: 'Save',
  cancel: 'Cancel',
  edit: 'Edit',
  delete: 'Delete',
  postComment: 'Post comment',
  deleteTask: 'Delete task',
  deleteConfirmPrompt: 'Delete this task? This cannot be undone.',
  deleteConfirm: 'Confirm delete',

  settingsLink: 'Settings',

  settingsTitle: 'Task settings',
  settingsNotFound: 'Settings could not be read: this service does not support them, or no organization is selected',
  settingsForbidden: 'You do not have permission to view task settings',
  settingsLoadFailed: 'Could not load task settings. Please try again later.',
  settingsBadgeScopeLegend: 'Badge count scope',
  settingsBadgeScopeOff: 'Off',
  settingsBadgeScopeOverdue: 'Overdue only',
  settingsBadgeScopeOverdueOrToday: 'Overdue and due today',
  settingsDailyReminder: 'Daily summary reminder',
  settingsDailyReminderNote: 'Sent at a fixed time each day in your time zone; whether it is actually sent depends on the server configuration',
  settingsRemindPolicyLabel: 'Default reminder for new tasks',
  settingsRemindPolicyDefault: 'Use the default rule',
  settingsRemindPolicyNone: 'No reminder',
  settingsTimeZoneLabel: 'Time zone',
  settingsTimeZonePlaceholder: 'IANA time zone name, for example Asia/Shanghai',
  settingsUseBrowserTimeZone: 'Use browser time zone',
  settingsTimeZoneAutofilled: 'Filled in from your browser time zone; you can change it',
  settingsSaved: 'Saved',
  settingsSaveForbidden: 'You do not have permission to change task settings',
  settingsSaveUnavailable: 'Settings could not be saved: this service does not support them',
  settingsSaveFailed: 'Could not save the settings. Please try again later.',

  detailStartLabel: 'Start: ',
  noStartDate: 'No start date',
  detailDescriptionLabel: 'Description: ',
  noDescription: 'No description',
  detailRemindLabel: 'Reminder: ',
  noReminder: 'No reminder',

  editorHeading: 'Edit task',
  editorTitleLabel: 'Title',
  editorDescriptionLabel: 'Description',
  editorDueDateLabel: 'Due date',
  editorDueTimeLabel: 'Due time',
  editorStartDateLabel: 'Start date',
  editorStartTimeLabel: 'Start time',
  editorTimeZoneLabel: 'Time zone',
  editorTimeZonePlaceholder: 'IANA time zone name, for example Asia/Shanghai',
  editorUseBrowserTimeZone: 'Use browser time zone',
  editorReminderLegend: 'Reminder',
  editorReminderNone: 'No reminder',
  editorReminderAt: 'At a set time',
  editorReminderTimeLabel: 'Reminder time',
  editorReminderNotFollowing: 'The reminder time does not follow the due date automatically',
  editorDiscard: 'Discard my changes',
  editorServerUpdated: 'The task was updated on the server; your unsaved changes are kept',
  versionConflictUnknown: 'This task was changed by someone else. The latest content has been loaded; please review it before saving.',

  listsHeading: 'Lists',
  listsEmpty: 'Not in any list yet',
  listsNotMember: ' (you are not a member)',
  listsMineUnavailable: 'Your lists could not be loaded; lists are shown by ID',
  listsAddLabel: 'Add to list',
  listsAddPlaceholder: 'Choose a list',
  listsAdd: 'Add',
  listsNoCandidates: 'No list to add this task to',
  listsRemove: 'Remove from list',
  listsRemoveConfirmPrompt: 'Remove this task from the list?',
  listsRemoveConfirm: 'Confirm removal',
  listsAddNotFound: "Cannot add: you need to be this task's creator or an assignee",

  loadMore: 'Load more',
  listRoleOwner: 'Owner',
  listRoleEdit: 'Can edit',
  listRoleRead: 'Read only',
  listArchivedMark: 'Archived',

  sidebarHeading: 'My lists',
  sidebarShowArchived: 'Show archived',
  sidebarEmpty: 'No lists yet',
  sidebarLoadFailed: 'Could not load your lists. Please try again later.',
  sidebarForbidden: 'You do not have permission to view task lists',
  sidebarUnavailable: 'Task lists are not available on this service',
  sidebarLoadMoreFailed: 'Could not load more lists. Please try again later.',
  sidebarCreateLabel: 'New list name',
  sidebarCreatePlaceholder: 'List name',
  sidebarCreate: 'Create list',
  sidebarCreateForbidden: 'You do not have permission to create a list',
  sidebarCreateFailed: 'Could not create the list. Please try again later.',

  listPageTitle: 'Task list',
  listNotFound: 'This list does not exist, or you are not a member',
  listForbidden: 'You do not have permission to view this list',
  listPageLoadFailed: 'Could not load the list. Please try again later.',
  listMyRoleLabel: 'My role: ',
  listRename: 'Rename',
  listRenameLabel: 'List name',
  listArchive: 'Archive',
  listUnarchive: 'Unarchive',
  listWriteNotFound: 'The list is not available, or you are no longer a member',
  listWriteForbidden: 'You do not have permission to change this list',
  listItemsHeading: 'Tasks in this list',
  listItemsEmpty: 'No tasks in this list yet',
  listItemsUnavailable: 'The tasks in this list could not be loaded',
  listItemsTruncated: 'This list holds many tasks; not all of them are shown',
  listAddTaskLabel: 'Add a task (task ID)',
  listAddTaskPlaceholder: 'Task ID',
  listAddTask: 'Add task',
  listAddTaskNotFound: 'The task does not exist, you are not its creator or an assignee, or the list is not available',
  listRemoveTask: 'Remove from list',
  listRemoveTaskConfirmPrompt: 'Remove this task from the list?',
  listEventsToggle: 'Activity',
  listEventsHeading: 'List activity',
  listEventsEmpty: 'No activity yet',
  listEventsLoadFailed: 'Could not load the activity. Please try again later.',
  listEventCreated: 'created the list',
  listEventRenamed: 'renamed the list',
  listEventArchived: 'archived the list',
  listEventUnarchived: 'unarchived the list',
  listEventOwnerTransferred: 'transferred ownership',
  listEventMemberAdded: 'added a member',
  listEventMemberRemoved: 'removed a member',
  listEventMemberRoleChanged: "changed a member's role",
  listEventItemAdded: 'added a task',
  listEventItemRemoved: 'removed a task',
  listEventGroupCreated: 'created a group',
  listEventGroupRenamed: 'renamed a group',
  listEventGroupDeleted: 'deleted a group',
  listEventFieldBound: 'bound a field',
  listEventFieldUnbound: 'unbound a field',
  listMembers: 'Members',
  membersTitle: 'List members',
  membersEmpty: 'No members yet',
  membersLoadFailed: 'Could not load the members. Please try again later.',
  membersCreatorMark: 'Creator',
  membersTransfer: 'Make owner',
  membersTransferConfirm: 'Confirm transfer',
  membersAddLabel: 'Add a member (user ID)',
  membersAddPlaceholder: 'User ID',
  membersAddRoleLabel: 'Role',
  membersAdd: 'Add member',
  membersLeave: 'Leave list',
  membersLeavePrompt: 'Leave this list?',
  membersLeaveConfirm: 'Confirm leaving',
  membersClose: 'Close',
  groupsUnavailable: 'Groups are unavailable',
  groupsRefresh: 'Refresh',
  groupsUnsorted: 'Unsorted',
  groupsEmpty: 'No tasks in this group',
  groupsDragHandle: 'Drag to reorder',
  groupsMoveUp: 'Move up',
  groupsMoveDown: 'Move down',
  groupsAddToOrder: 'Add to order',
  groupsSaving: 'Saving the order',
  groupsReorderOff: 'Some tasks are not shown here, so reordering is turned off',
  groupsCreateLabel: 'New group name',
  groupsCreatePlaceholder: 'Group name',
  groupsCreate: 'New group',
  groupsRenameLabel: 'New name for this group',
  groupsDefaultRenameHint: 'This group can be renamed after the first move or after a group is created',
  groupsDelete: 'Delete group',
  groupsDeleteConfirm: 'Delete',
  groupsNotFound: 'The task or group is no longer available',
  groupsForbidden: 'You do not have permission to change groups',

  noDueDate: 'No due date',
  timeZoneOpen: ' (',
  timeZoneClose: ')',

  codeInvalidParent: 'Invalid parent task',
  codeDepthExceeded: 'The task nesting limit has been reached',
  codeInvalidAssignees: 'Invalid user',
  codeLimit: 'The people limit has been reached',
  codeInvalidMode: 'Invalid completion mode',
  codeCommentBlank: 'The comment cannot be empty',
  codeCommentTooLong: 'The comment is too long',
  codeCommentInvalidChar: 'The comment contains characters that cannot be saved',
  codeHasChildren: 'Delete the subtasks first',
  codeTaskBusy: 'The task is being changed. Please try again later.',
  codeInvalidVersion: 'Version information is missing. Please refresh the page.',
  codeInvalidTitle: 'The title cannot be empty',
  codeInvalidDescription: 'The description is too long or contains characters that cannot be saved',
  codeInvalidDate: 'The date or time format is not valid',
  codeInvalidTimeZone: 'Invalid time zone',
  codeTimeZoneRequired: 'A time zone is required when a date is set',
  codeInvalidRemindAt: 'The reminder time format is not valid',
  codeInvalidSettings: 'The settings format is not valid',
  codeInvalidBadgeScope: 'Invalid badge scope',
  codeInvalidDailyReminderEnabled: 'Invalid daily reminder switch',
  codeInvalidPolicy: 'Invalid reminder policy',
  codeDailyReminderRequiresTimeZone: 'Set a time zone before turning on the daily reminder',
  codeInvalidName: 'The name cannot be empty',
  codeNameTooLong: 'The name is too long',
  codeInvalidTask: 'Invalid task',
  codeIsDefault: 'The default group cannot be deleted',
  codeInvalidGroup: 'The group does not exist',
  codeInvalidPosition: 'The position has changed. Please refresh and try again.',
  codeInvalidMember: 'Invalid user',
  codeInvalidRole: 'Invalid role',
  codeInactiveOrgMember: 'This user is not in the current organization or has been deactivated',
  codeOwnerMustTransfer: 'Transfer ownership first',
  codeCreatedByImmutable: 'The list creator cannot be removed',
  codeTargetNotMember: 'That user is not a member of the list',
  codeLimitMembers: 'The member limit has been reached',
  codeLimitTaskLists: 'A task can belong to at most 10 lists',
  codeLimitGroups: 'The group limit has been reached',
}

// Sentences with an interpolated value. The badge's `aria-label` for the 'ready' state
// (`${label}${count}`) is not here: it is a prop and a number with no copy of its own.
export const TASKS_FMT_ZH = {
  /** Detail page assignee row — `when` is the already-formatted viewer-local instant. */
  completedAt: (when: string): string => `已完成于 ${when}`,
  /** The nav badge's `aria-label` / `title` — `label` is the nav entry's own label. */
  badgeUnavailable: (label: string): string => `${label}(数据不可用)`,
  badgeLoading: (label: string): string => `${label}加载中`,
  /** The badge is switched off by the viewer's task settings (M4 design §8.1). */
  badgeOff: (label: string): string => `${label}红点已关闭`,
  /** PR-3a `VERSION_CONFLICT` (409) — design §4.3 / §9.2; `currentVersion` from the 409 body. */
  versionConflict: (currentVersion: number): string =>
    `任务已被他人修改（当前版本 ${currentVersion}），已载入最新内容，请核对后再保存`,
  /** The editor's description counter, in code points (design §7.2). */
  descriptionCount: (count: number, max: number): string => `${count} / ${max} 字`,
  /** Accessible name of a list row's remove button (design §4.3). */
  listsRemoveFrom: (name: string): string => `将此任务移出「${name}」`,
  /** Accessible name of a task row's remove button on the list page (design §4.2). */
  listRemoveTaskNamed: (title: string): string => `将「${title}」移出清单`,
  /** Members dialog (design §5.2): accessible names of a row's role select, remove and transfer
   *  buttons, and the transfer's confirmation prompt — `userId` is the row's member. */
  membersRoleFor: (userId: string): string => `「${userId}」的角色`,
  membersRemoveNamed: (userId: string): string => `移除成员「${userId}」`,
  membersTransferNamed: (userId: string): string => `将所有权转让给「${userId}」`,
  membersTransferPrompt: (userId: string): string => `确认将所有权转让给「${userId}」？转让后你将成为可编辑成员`,
  /** The grouping board (design §6): a group's row count, the accessible names of a row's move
   *  controls, the live-region sentences after a move and the group controls' names and prompt. */
  groupsItemCount: (count: number): string => `${count} 项`,
  groupsMoveUpNamed: (title: string): string => `将「${title}」上移一位`,
  groupsMoveDownNamed: (title: string): string => `将「${title}」下移一位`,
  groupsAddToOrderNamed: (title: string): string => `将「${title}」加入排序`,
  groupsMoveToNamed: (title: string): string => `将「${title}」移到分组`,
  groupsMovedTo: (place: number): string => `已移到第 ${place} 位`,
  groupsMovedToGroup: (name: string, place: number): string => `已移到「${name}」第 ${place} 位`,
  groupsRenameNamed: (name: string): string => `重命名分组「${name}」`,
  groupsDeleteNamed: (name: string): string => `删除分组「${name}」`,
  groupsDeletePrompt: (name: string): string => `确认删除分组「${name}」？其中的任务将回到默认分组`,
}

export type TasksFmt = typeof TASKS_FMT_ZH

export const TASKS_FMT_EN: { [K in keyof TasksFmt]: (...args: Parameters<TasksFmt[K]>) => string } = {
  completedAt: (when) => `Completed at ${when}`,
  badgeUnavailable: (label) => `${label} (data unavailable)`,
  badgeLoading: (label) => `${label} loading`,
  badgeOff: (label) => `${label} badge off`,
  versionConflict: (currentVersion) =>
    `This task was changed by someone else (current version ${currentVersion}). The latest content has been loaded; please review it before saving.`,
  descriptionCount: (count, max) => `${count} / ${max} characters`,
  listsRemoveFrom: (name) => `Remove this task from "${name}"`,
  listRemoveTaskNamed: (title) => `Remove "${title}" from this list`,
  membersRoleFor: (userId) => `Role of "${userId}"`,
  membersRemoveNamed: (userId) => `Remove member "${userId}"`,
  membersTransferNamed: (userId) => `Transfer ownership to "${userId}"`,
  membersTransferPrompt: (userId) => `Transfer ownership to "${userId}"? You will stay on the list with the edit role.`,
  groupsItemCount: (count) => (count === 1 ? '1 task' : `${count} tasks`),
  groupsMoveUpNamed: (title) => `Move "${title}" up one place`,
  groupsMoveDownNamed: (title) => `Move "${title}" down one place`,
  groupsAddToOrderNamed: (title) => `Add "${title}" to the sorted order`,
  groupsMoveToNamed: (title) => `Move "${title}" to a group`,
  groupsMovedTo: (place) => `Moved to place ${place}`,
  groupsMovedToGroup: (name, place) => `Moved to place ${place} in "${name}"`,
  groupsRenameNamed: (name) => `Rename group "${name}"`,
  groupsDeleteNamed: (name) => `Delete group "${name}"`,
  groupsDeletePrompt: (name) => `Delete group "${name}"? Its tasks go back to the default group.`,
}

/** Contract error code -> key of the plain-string table. Codes the M4 surfaces read with a
 *  call-site-specific message (`LIMIT` on lists / groups / members) keep the M3 reading here and
 *  pick their own key at the call site. */
export const TASKS_CODE_KEYS = {
  INVALID_PARENT: 'codeInvalidParent',
  DEPTH_EXCEEDED: 'codeDepthExceeded',
  INVALID_ASSIGNEES: 'codeInvalidAssignees',
  LIMIT: 'codeLimit',
  INVALID_MODE: 'codeInvalidMode',
  COMMENT_BLANK: 'codeCommentBlank',
  COMMENT_TOO_LONG: 'codeCommentTooLong',
  COMMENT_INVALID_CHAR: 'codeCommentInvalidChar',
  HAS_CHILDREN: 'codeHasChildren',
  TASK_BUSY: 'codeTaskBusy',
  INVALID_VERSION: 'codeInvalidVersion',
  INVALID_TITLE: 'codeInvalidTitle',
  INVALID_DESCRIPTION: 'codeInvalidDescription',
  INVALID_DATE: 'codeInvalidDate',
  INVALID_TIME_ZONE: 'codeInvalidTimeZone',
  TIME_ZONE_REQUIRED: 'codeTimeZoneRequired',
  INVALID_REMIND_AT: 'codeInvalidRemindAt',
  INVALID_SETTINGS: 'codeInvalidSettings',
  INVALID_BADGE_SCOPE: 'codeInvalidBadgeScope',
  INVALID_DAILY_REMINDER_ENABLED: 'codeInvalidDailyReminderEnabled',
  INVALID_POLICY: 'codeInvalidPolicy',
  DAILY_REMINDER_REQUIRES_TIME_ZONE: 'codeDailyReminderRequiresTimeZone',
  INVALID_NAME: 'codeInvalidName',
  NAME_TOO_LONG: 'codeNameTooLong',
  INVALID_TASK: 'codeInvalidTask',
  IS_DEFAULT: 'codeIsDefault',
  INVALID_GROUP: 'codeInvalidGroup',
  INVALID_POSITION: 'codeInvalidPosition',
  INVALID_MEMBER: 'codeInvalidMember',
  INVALID_ROLE: 'codeInvalidRole',
  INACTIVE_ORG_MEMBER: 'codeInactiveOrgMember',
  OWNER_MUST_TRANSFER: 'codeOwnerMustTransfer',
  CREATED_BY_IMMUTABLE: 'codeCreatedByImmutable',
  TARGET_NOT_MEMBER: 'codeTargetNotMember',
} as const satisfies Record<string, keyof TasksText>

/** The inline message for a contract error code in the given language table. A code the table
 *  does not list (contract drift, or a code this surface does not read) renders the generic
 *  `actionFailed` copy of the same table. Own-property lookup only: a code that happens to spell
 *  an `Object.prototype` member is unknown, not a function. */
export function codeMessage(code: string, t: TasksText): string {
  if (!Object.prototype.hasOwnProperty.call(TASKS_CODE_KEYS, code)) return t.actionFailed
  return t[TASKS_CODE_KEYS[code as keyof typeof TASKS_CODE_KEYS]]
}

/** The closed event-type set of `GET /api/task-lists/:id/events` (PR-3a: `task_list_events`,
 *  fifteen words) -> key of the plain-string table. */
export const TASKS_LIST_EVENT_KEYS = {
  created: 'listEventCreated',
  renamed: 'listEventRenamed',
  archived: 'listEventArchived',
  unarchived: 'listEventUnarchived',
  owner_transferred: 'listEventOwnerTransferred',
  member_added: 'listEventMemberAdded',
  member_removed: 'listEventMemberRemoved',
  member_role_changed: 'listEventMemberRoleChanged',
  item_added: 'listEventItemAdded',
  item_removed: 'listEventItemRemoved',
  group_created: 'listEventGroupCreated',
  group_renamed: 'listEventGroupRenamed',
  group_deleted: 'listEventGroupDeleted',
  field_bound: 'listEventFieldBound',
  field_unbound: 'listEventFieldUnbound',
} as const satisfies Record<string, keyof TasksText>

/** The word for an activity event type in the given language table; a type outside the closed set
 *  is shown as the server sent it (design §3.2). Own-property lookup only, as in `codeMessage`. */
export function listEventLabel(eventType: string, t: TasksText): string {
  if (!Object.prototype.hasOwnProperty.call(TASKS_LIST_EVENT_KEYS, eventType)) return eventType
  return t[TASKS_LIST_EVENT_KEYS[eventType as keyof typeof TASKS_LIST_EVENT_KEYS]]
}
