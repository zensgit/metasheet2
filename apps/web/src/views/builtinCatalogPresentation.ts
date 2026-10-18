/**
 * Display-only Chinese titles for verified first-party role and permission defaults.
 * Stable ids and any stored label that is not one of those defaults stay as stored.
 * Nothing here is written back by a permissions-only save.
 *
 * Role sources: migrations/054_create_users_table.sql; zzzz20260208100000_create_roles_table.ts
 * (named seed and the earlier name=id backfill); zzzz20260826140000_add_elearning_role_templates.ts
 * via buildPluginRoleId('plugin-elearning'); zzzz20261010124500_seed_stock_prep_role_templates.ts
 * and the 2026-10-12 frontline name 操作人员. 一线填写 stays when that is still the stored name.
 *
 * Permission sources: the same users migration, seed-rbac.ts, 20250924190000_create_rbac_tables.ts,
 * and the permission INSERT migrations under src/db/migrations (attendance, spreadsheet, comments,
 * multitable, approvals, elearning, stock-prep, tasks). Alternate ON CONFLICT descriptions are
 * aliases of the same code, as are the two compare-and-set stock-prep:admin description updates
 * (zzzz20260927120000 and zzzz20261009120000). Plugin-provisioned names are dynamic and are not
 * in this whitelist.
 */

type DescriptionAlias = {
  source: string
  text: string
}

type PermissionPresentation = {
  title: string
  names: readonly string[]
  descriptions: readonly DescriptionAlias[]
}

type RolePresentation = {
  title: string
  names: readonly string[]
}

const PROTOTYPE_IDS = new Set(['__proto__', 'prototype', 'constructor'])

function isPrototypeLikeId(value: string): boolean {
  return PROTOTYPE_IDS.has(value) || value.includes('__proto__')
}

function permission(
  title: string,
  seededNames: readonly string[],
  descriptions: readonly DescriptionAlias[],
): PermissionPresentation {
  return { title, names: ['', ...seededNames], descriptions }
}

function describe(source: string, text: string): DescriptionAlias {
  return { source, text }
}

const PERMISSIONS = new Map<string, PermissionPresentation>([
  ['*:*', permission('所有权限', [], [describe('所有权限', '所有权限')])],
  ['admin:all', permission('全部管理权限', ['Admin All'], [describe('Full admin access', '完整的管理权限')])],
  ['admin:users', permission('用户管理', [], [describe('管理用户', '管理用户')])],
  ['admin:roles', permission('角色管理', [], [describe('管理角色', '管理角色')])],
  ['admin:permissions', permission('权限管理', [], [describe('管理权限', '管理权限')])],
  ['permissions:read', permission('权限读取', ['Permissions Read'], [describe('List permissions', '列出权限')])],
  ['permissions:write', permission('权限写入', ['Permissions Write'], [describe('Grant/Revoke permissions', '授予或收回权限')])],
  ['roles:read', permission('角色读取', ['Roles Read'], [describe('List roles', '列出角色')])],
  ['roles:write', permission('角色写入', ['Roles Write'], [describe('Manage roles', '管理角色')])],
  ['demo:read', permission('演示读取', ['Demo Read'], [
    describe('Read access for demo purposes', '用于演示的读取权限'),
    describe('Demo read permission for CI', '用于持续集成的演示读取权限'),
  ])],
  ['demo:write', permission('演示写入', ['Demo Write'], [describe('Write access for demo purposes', '用于演示的写入权限')])],
  ['test:read', permission('测试读取', ['Test Read'], [describe('Read access for testing', '用于测试的读取权限')])],
  ['test:write', permission('测试写入', ['Test Write'], [describe('Write access for testing', '用于测试的写入权限')])],
  ['spreadsheet:read', permission('电子表格读取', ['Spreadsheet Read'], [
    describe('Read spreadsheet resources and cell data', '读取电子表格资源和单元格数据'),
    describe('读取电子表格', '读取电子表格'),
  ])],
  ['spreadsheet:write', permission('电子表格编辑', ['Spreadsheet Write'], [
    describe('Create and update spreadsheet resources and cell data', '创建和更新电子表格资源与单元格数据'),
    describe('编辑电子表格', '编辑电子表格'),
  ])],
  ['spreadsheet:delete', permission('电子表格删除', [], [describe('删除电子表格', '删除电子表格')])],
  ['spreadsheet:share', permission('电子表格分享', [], [describe('分享电子表格', '分享电子表格')])],
  ['spreadsheets:read', permission('电子表格读取', ['Spreadsheets Read'], [
    describe('Read spreadsheet resources and cell data', '读取电子表格资源和单元格数据'),
  ])],
  ['spreadsheets:write', permission('电子表格写入', ['Spreadsheets Write'], [
    describe('Create and update spreadsheet resources and cell data', '创建和更新电子表格资源与单元格数据'),
  ])],
  ['comments:read', permission('评论读取', ['Comments Read'], [
    describe('Read comments and discussion threads', '读取评论和讨论串'),
  ])],
  ['comments:write', permission('评论写入', ['Comments Write'], [
    describe('Create, update, resolve, and delete comments', '创建、更新、解决和删除评论'),
  ])],
  ['attendance:read', permission('考勤读取', ['Attendance Read'], [
    describe('Read attendance records and summaries', '读取考勤记录和汇总'),
    describe('Read attendance data', '读取考勤数据'),
  ])],
  ['attendance:write', permission('考勤写入', ['Attendance Write'], [
    describe('Create attendance punches and adjustment requests', '创建考勤打卡和调整申请'),
    describe('Create attendance punches and requests', '创建考勤打卡和申请'),
  ])],
  ['attendance:approve', permission('考勤审批', ['Attendance Approve'], [
    describe('Approve or reject attendance adjustments', '批准或拒绝考勤调整'),
    describe('Approve attendance adjustment requests', '批准考勤调整申请'),
  ])],
  ['attendance:import', permission('考勤导入', ['Attendance Import'], [
    describe('Import attendance records and manage import batches', '导入考勤记录并管理导入批次'),
    describe('Import attendance records and batches', '导入考勤记录和批次'),
  ])],
  ['attendance:admin', permission('考勤管理', ['Attendance Admin'], [
    describe('Manage attendance rules, settings, and schedules', '管理考勤规则、设置和排班'),
    describe('Manage attendance rules', '管理考勤规则'),
  ])],
  ['multitable:read', permission('多维表读取', ['Multitable Read'], [
    describe('Read multitable bases, sheets, views, and records', '读取多维表的库、表、视图和记录'),
  ])],
  ['multitable:write', permission('多维表写入', ['Multitable Write'], [
    describe('Manage multitable bases, fields, views, and records', '管理多维表的库、字段、视图和记录'),
  ])],
  ['multitable:share', permission('多维表分享', ['Multitable Share'], [
    describe('Manage sheet-level multitable access overrides', '管理多维表的表级访问覆盖'),
  ])],
  ['multitable:manage-schema', permission('多维表结构管理', ['Multitable Manage Schema'], [
    describe(
      'Create, rename, retype and delete multitable fields (table structure) — NOT implied by multitable:write',
      '创建、重命名、改类型和删除多维表字段（表结构）——multitable:write 并不包含此权限',
    ),
  ])],
  ['multitable:submit-approval', permission('多维表送审', ['Multitable Submit Approval'], [
    describe(
      'Submit a multitable record to an approval template (record-level send-for-approval) — NOT implied by multitable:write; the approval product still requires approvals:write',
      '将多维表记录提交到审批模板（记录级送审）——multitable:write 并不包含此权限；审批产品仍要求 approvals:write',
    ),
  ])],
  ['elearning:read', permission('在线学习读取', ['E-learning Read'], [
    describe('Read published learning content and own attempts', '读取已发布的学习内容和自己的作答'),
  ])],
  ['elearning:write', permission('在线学习写入', ['E-learning Write'], [
    describe('Create and edit learning content and exams', '创建和编辑学习内容与考试'),
  ])],
  ['elearning:grade', permission('在线学习评分', ['E-learning Grade'], [
    describe('Grade exam attempts within authorized scope', '在授权范围内评阅考试作答'),
  ])],
  ['elearning:stats', permission('在线学习统计', ['E-learning Stats'], [
    describe('Read learning statistics', '读取学习统计'),
  ])],
  ['elearning:admin', permission('在线学习管理', ['E-learning Admin'], [
    describe('Global e-learning administration', '在线学习的全局管理'),
  ])],
  ['stock-prep:read', permission('备料读取', ['Stock Prep Read'], [
    describe('Read the values-free stock-preparation confirmation queue', '读取不含业务取值的备料确认队列'),
  ])],
  ['stock-prep:operate', permission('备料操作', ['Stock Prep Operate'], [
    describe('Confirm stock-preparation queue decisions and read back own value entry', '确认备料队列决定并回读自己的取值'),
  ])],
  ['stock-prep:admin', permission('备料管理', ['Stock Prep Admin'], [
    describe(
      'Workbench-scoped stock-preparation administration (no provisioning, no pack install)',
      '工作台范围内的备料管理（不含开通，不含安装包）',
    ),
    describe(
      'Workbench-scoped stock-preparation administration (no provisioning, no pack install; may relabel still-English managed-table headers to their Chinese template names when the operator switch is on)',
      '工作台范围内的备料管理（不含开通，不含安装包；操作开关打开时，可将仍为英文的托管表表头改为其中文模板名）',
    ),
    describe(
      'Workbench-scoped stock-preparation administration (no pack install; may relabel still-English managed-table headers to their Chinese template names when the operator switch is on; includes the puller tier, which may create one per-project stock-preparation sheet from the frozen template when the project-sheets switch is on)',
      '工作台范围内的备料管理（不含安装包；操作开关打开时，可将仍为英文的托管表表头改为其中文模板名；包含拉取层级，项目表开关打开时可按冻结模板为一个项目创建一张备料表）',
    ),
  ])],
  ['stock-prep:pull', permission('备料拉取', ['Stock Prep Pull'], [
    describe(
      'Pull from PLM into the stock-preparation sheet (dry-run, apply, large-BOM background channel, reconcile); in later slices also create project sheets and archive/restore them. The holder must also hold stock-prep:operate and stock-prep:read',
      '从 PLM 拉取到备料表（试运行、应用、大 BOM 后台通道、对账）；后续切片还可创建项目表并归档或恢复。持有人还必须同时持有 stock-prep:operate 和 stock-prep:read',
    ),
  ])],
  ['tasks:read', permission('任务读取', ['Tasks Read'], [describe('Read tasks in the caller org', '读取调用方组织内的任务')])],
  ['tasks:write', permission('任务写入', ['Tasks Write'], [describe('Create and update tasks in the caller org', '在调用方组织内创建和更新任务')])],
  ['tasks:admin', permission('任务管理', ['Tasks Admin'], [describe('Administer task settings in the caller org', '管理调用方组织内的任务设置')])],
  ['approvals:read', permission('审批读取', ['Approvals Read'], [
    describe(
      'Read approval instances, history, comments, delegations, and pending/todo queues — also gates a few write-shaped actions sharing this same guard (see the migration file header); not a pure read-only grant',
      '读取审批实例、历史、评论、委托和待办队列——同时放行少数共用同一守卫的写操作（见迁移文件头说明）；不是纯粹的只读授权',
    ),
  ])],
  ['approvals:write', permission('审批写入', ['Approvals Write'], [
    describe(
      'Start approvals: create and preview approval instances from published templates, keep form drafts and upload draft attachments. Does not allow acting on an approval (approvals:act) or authoring templates (approval-templates:manage)',
      '发起审批：从已发布模板创建和预览审批实例、保留表单草稿并上传草稿附件。不允许处理审批（approvals:act），也不允许编写模板（approval-templates:manage）',
    ),
  ])],
  ['approvals:act', permission('审批处理', ['Approvals Act'], [
    describe(
      'Take decision actions on approval instances (approve, reject, return, transfer, add/reduce sign) through the approval action endpoints. Route-level capability: each route evaluates whether the holder may act on a given instance',
      '通过审批动作端点对审批实例做决定（同意、拒绝、退回、转交、加签或减签）。这是路由级能力：每条路由自行判断持有人能否处理该实例',
    ),
  ])],
  ['approvals:admin', permission('审批管理', ['Approvals Admin'], [
    describe('Perform administrative approval recovery actions', '执行审批恢复类管理操作'),
    describe('Perform administrative approval process recovery actions', '执行审批流程恢复类管理操作'),
  ])],
  ['approvals:admin-templates', permission('审批模板管理员', ['Approval Template Admin'], [
    describe(
      'Manage approval templates without approval process recovery privileges',
      '管理审批模板，不含审批流程恢复权限',
    ),
  ])],
  ['approvals:admin-data', permission('审批数据恢复管理', ['Approval Data Recovery Admin'], [
    describe(
      'Perform approval data recovery operations without template administration privileges',
      '执行审批数据恢复，不含模板管理权限',
    ),
  ])],
  ['approvals:analytics', permission('审批分析', ['Approvals Analytics'], [
    describe(
      'View person-level approval process analytics (performance aggregations)',
      '查看个人级审批流程分析（绩效汇总）',
    ),
  ])],
  ['approval-templates:manage', permission('审批模板管理', ['Approval Templates Manage'], [
    describe(
      'Author and manage approval templates (create, edit, publish, archive, template groups) and administer approval delegations; the same template-admin guard also accepts approvals:admin-templates',
      '编写和管理审批模板（创建、编辑、发布、归档、模板组）并管理审批委托；同一模板管理守卫也接受 approvals:admin-templates',
    ),
  ])],
])

const ROLES = new Map<string, RolePresentation>([
  ['admin', { title: '管理员', names: ['管理员', 'admin'] }],
  ['user', { title: '普通用户', names: ['普通用户', 'user'] }],
  ['attendance_employee', { title: '考勤员工', names: ['Attendance Employee', 'attendance_employee'] }],
  ['attendance_approver', { title: '考勤审批人', names: ['Attendance Approver', 'attendance_approver'] }],
  ['attendance_importer', { title: '考勤导入员', names: ['Attendance Importer', 'attendance_importer'] }],
  ['attendance_admin', { title: '考勤管理员', names: ['Attendance Admin', 'attendance_admin'] }],
  ['plugin_elearning_viewer', { title: '在线学习查看者', names: ['E-learning Viewer', 'plugin_elearning_viewer'] }],
  ['plugin_elearning_operator', { title: '在线学习操作员', names: ['E-learning Operator', 'plugin_elearning_operator'] }],
  ['plugin_elearning_admin', { title: '在线学习管理员', names: ['E-learning Admin', 'plugin_elearning_admin'] }],
  ['stock-prep_admin', { title: '备料主管理员', names: ['备料主管理员', 'stock-prep_admin'] }],
  ['stock-prep_puller', { title: '数据管理员（拉取人员）', names: ['数据管理员（拉取人员）', 'stock-prep_puller'] }],
  ['stock-prep_developer', { title: '开发成员', names: ['开发成员', 'stock-prep_developer'] }],
  ['stock-prep_frontline', { title: '操作人员', names: ['操作人员', 'stock-prep_frontline'] }],
])

export function presentRoleTitle(role: { id: string; name: string }): string {
  if (isPrototypeLikeId(role.id)) return role.name
  const entry = ROLES.get(role.id)
  if (!entry) return role.name
  if (!entry.names.includes(role.name)) return role.name
  return entry.title
}

export function presentPermission(permission: {
  code: string
  name?: string | null
  description?: string | null
}): { name: string; description: string | null } {
  const rawName = typeof permission.name === 'string' ? permission.name : ''
  const rawDescription = typeof permission.description === 'string' ? permission.description : null
  if (isPrototypeLikeId(permission.code)) return { name: rawName, description: rawDescription }
  const entry = PERMISSIONS.get(permission.code)
  if (!entry) return { name: rawName, description: rawDescription }
  const name = entry.names.includes(rawName) ? entry.title : rawName
  const alias = rawDescription === null
    ? undefined
    : entry.descriptions.find((item) => item.source === rawDescription)
  return { name, description: alias ? alias.text : rawDescription }
}

/**
 * A permissions-only save keeps the loaded raw name. An explicit edit of the name field
 * persists the draft, including when that draft is the Chinese title currently on screen.
 */
export function roleNameForSave(storedName: string | null, draftName: string, nameEdited: boolean): string {
  if (!nameEdited && storedName !== null) return storedName
  return draftName.trim()
}
