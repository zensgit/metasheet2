import { describe, expect, it } from 'vitest'
import { presentPermission, presentRoleTitle, roleNameForSave } from '../src/views/builtinCatalogPresentation'
import freshCatalog from './fixtures/builtinCatalogSeedDefaults.json'

const FRESH_ROLE_TITLES: Record<string, string> = {
  admin: '管理员',
  attendance_admin: '考勤管理员',
  attendance_approver: '考勤审批人',
  attendance_employee: '考勤员工',
  attendance_importer: '考勤导入员',
  plugin_elearning_admin: '在线学习管理员',
  plugin_elearning_operator: '在线学习操作员',
  plugin_elearning_viewer: '在线学习查看者',
  'stock-prep_admin': '备料主管理员',
  'stock-prep_developer': '开发成员',
  'stock-prep_frontline': '操作人员',
  'stock-prep_puller': '数据管理员（拉取人员）',
}

const FRESH_PERMISSIONS: Record<string, { name: string; description: string }> = {
  'admin:all': { name: '全部管理权限', description: '完整的管理权限' },
  'approval-templates:manage': {
    name: '审批模板管理',
    description: '编写和管理审批模板（创建、编辑、发布、归档、模板组）并管理审批委托；同一模板管理守卫也接受 approvals:admin-templates',
  },
  'approvals:act': {
    name: '审批处理',
    description: '通过审批动作端点对审批实例做决定（同意、拒绝、退回、转交、加签或减签）。这是路由级能力：每条路由自行判断持有人能否处理该实例',
  },
  'approvals:admin': { name: '审批管理', description: '执行审批恢复类管理操作' },
  'approvals:admin-data': { name: '审批数据恢复管理', description: '执行审批数据恢复，不含模板管理权限' },
  'approvals:admin-templates': { name: '审批模板管理员', description: '管理审批模板，不含审批流程恢复权限' },
  'approvals:analytics': { name: '审批分析', description: '查看个人级审批流程分析（绩效汇总）' },
  'approvals:read': {
    name: '审批读取',
    description: '读取审批实例、历史、评论、委托和待办队列——同时放行少数共用同一守卫的写操作（见迁移文件头说明）；不是纯粹的只读授权',
  },
  'approvals:write': {
    name: '审批写入',
    description: '发起审批：从已发布模板创建和预览审批实例、保留表单草稿并上传草稿附件。不允许处理审批（approvals:act），也不允许编写模板（approval-templates:manage）',
  },
  'attendance:admin': { name: '考勤管理', description: '管理考勤规则、设置和排班' },
  'attendance:approve': { name: '考勤审批', description: '批准或拒绝考勤调整' },
  'attendance:import': { name: '考勤导入', description: '导入考勤记录并管理导入批次' },
  'attendance:read': { name: '考勤读取', description: '读取考勤记录和汇总' },
  'attendance:write': { name: '考勤写入', description: '创建考勤打卡和调整申请' },
  'comments:read': { name: '评论读取', description: '读取评论和讨论串' },
  'comments:write': { name: '评论写入', description: '创建、更新、解决和删除评论' },
  'demo:read': { name: '演示读取', description: '用于演示的读取权限' },
  'demo:write': { name: '演示写入', description: '用于演示的写入权限' },
  'elearning:admin': { name: '在线学习管理', description: '在线学习的全局管理' },
  'elearning:grade': { name: '在线学习评分', description: '在授权范围内评阅考试作答' },
  'elearning:read': { name: '在线学习读取', description: '读取已发布的学习内容和自己的作答' },
  'elearning:stats': { name: '在线学习统计', description: '读取学习统计' },
  'elearning:write': { name: '在线学习写入', description: '创建和编辑学习内容与考试' },
  'multitable:manage-schema': {
    name: '多维表结构管理',
    description: '创建、重命名、改类型和删除多维表字段（表结构）——multitable:write 并不包含此权限',
  },
  'multitable:read': { name: '多维表读取', description: '读取多维表的库、表、视图和记录' },
  'multitable:share': { name: '多维表分享', description: '管理多维表的表级访问覆盖' },
  'multitable:submit-approval': {
    name: '多维表送审',
    description: '将多维表记录提交到审批模板（记录级送审）——multitable:write 并不包含此权限；审批产品仍要求 approvals:write',
  },
  'multitable:write': { name: '多维表写入', description: '管理多维表的库、字段、视图和记录' },
  'spreadsheet:read': { name: '电子表格读取', description: '读取电子表格资源和单元格数据' },
  'spreadsheet:write': { name: '电子表格编辑', description: '创建和更新电子表格资源与单元格数据' },
  'spreadsheets:read': { name: '电子表格读取', description: '读取电子表格资源和单元格数据' },
  'spreadsheets:write': { name: '电子表格写入', description: '创建和更新电子表格资源与单元格数据' },
  'stock-prep:admin': {
    name: '备料管理',
    description: '工作台范围内的备料管理（不含安装包；操作开关打开时，可将仍为英文的托管表表头改为其中文模板名；包含拉取层级，项目表开关打开时可按冻结模板为一个项目创建一张备料表）',
  },
  'stock-prep:operate': { name: '备料操作', description: '确认备料队列决定并回读自己的取值' },
  'stock-prep:pull': {
    name: '备料拉取',
    description: '从 PLM 拉取到备料表（试运行、应用、大 BOM 后台通道、对账）；后续切片还可创建项目表并归档或恢复。持有人还必须同时持有 stock-prep:operate 和 stock-prep:read',
  },
  'stock-prep:read': { name: '备料读取', description: '读取不含业务取值的备料确认队列' },
  'tasks:admin': { name: '任务管理', description: '管理调用方组织内的任务设置' },
  'tasks:read': { name: '任务读取', description: '读取调用方组织内的任务' },
  'tasks:write': { name: '任务写入', description: '在调用方组织内创建和更新任务' },
  'test:read': { name: '测试读取', description: '用于测试的读取权限' },
  'test:write': { name: '测试写入', description: '用于测试的写入权限' },
}

describe('builtin role and permission presentation', () => {
  it('shows Chinese titles for verified builtin role defaults and id aliases', () => {
    expect(presentRoleTitle({ id: 'attendance_admin', name: 'Attendance Admin' })).toBe('考勤管理员')
    expect(presentRoleTitle({ id: 'attendance_admin', name: 'attendance_admin' })).toBe('考勤管理员')
    expect(presentRoleTitle({ id: 'attendance_employee', name: 'Attendance Employee' })).toBe('考勤员工')
    expect(presentRoleTitle({ id: 'plugin_elearning_viewer', name: 'E-learning Viewer' })).toBe('在线学习查看者')
    expect(presentRoleTitle({ id: 'plugin_elearning_admin', name: 'plugin_elearning_admin' })).toBe('在线学习管理员')
    expect(presentRoleTitle({ id: 'admin', name: '管理员' })).toBe('管理员')
    expect(presentRoleTitle({ id: 'admin', name: 'admin' })).toBe('管理员')
    expect(presentRoleTitle({ id: 'stock-prep_frontline', name: '操作人员' })).toBe('操作人员')
    expect(presentRoleTitle({ id: 'stock-prep_frontline', name: 'stock-prep_frontline' })).toBe('操作人员')
    expect(presentRoleTitle({ id: 'stock-prep_puller', name: '数据管理员（拉取人员）' })).toBe('数据管理员（拉取人员）')
  })

  it('preserves custom labels, the previous frontline name, unknown ids, and prototype-like ids', () => {
    expect(presentRoleTitle({ id: 'attendance_admin', name: 'Floor Captain' })).toBe('Floor Captain')
    expect(presentRoleTitle({ id: 'attendance_admin', name: '考勤管理员' })).toBe('考勤管理员')
    expect(presentRoleTitle({ id: 'attendance_admin ', name: 'Attendance Admin' })).toBe('Attendance Admin')
    expect(presentRoleTitle({ id: 'stock-prep_frontline', name: '一线填写' })).toBe('一线填写')
    expect(presentRoleTitle({ id: 'stock-prep_frontline', name: '操作人员（内置）' })).toBe('操作人员（内置）')
    expect(presentRoleTitle({ id: 'workshop_lead', name: 'Workshop Lead' })).toBe('Workshop Lead')
    expect(presentRoleTitle({ id: 'constructor', name: 'Attendance Admin' })).toBe('Attendance Admin')
    expect(presentRoleTitle({ id: '__proto__', name: 'Attendance Admin' })).toBe('Attendance Admin')
    expect(presentRoleTitle({ id: 'prototype', name: 'admin' })).toBe('admin')
    expect(presentRoleTitle({ id: 'attendance_admin__proto__copy', name: 'Attendance Admin' })).toBe('Attendance Admin')
  })

  it('translates verified permission defaults and description aliases field by field', () => {
    expect(presentPermission({
      code: 'attendance:read',
      name: 'Attendance Read',
      description: 'Read attendance records and summaries',
    })).toEqual({ name: '考勤读取', description: '读取考勤记录和汇总' })
    expect(presentPermission({
      code: 'attendance:read',
      name: 'Attendance Read',
      description: 'Read attendance data',
    })).toEqual({ name: '考勤读取', description: '读取考勤数据' })
    expect(presentPermission({
      code: 'approvals:admin',
      name: 'Approvals Admin',
      description: 'Perform administrative approval process recovery actions',
    }).description).toBe('执行审批流程恢复类管理操作')
    expect(presentPermission({
      code: 'spreadsheet:read',
      name: '',
      description: '读取电子表格',
    })).toEqual({ name: '电子表格读取', description: '读取电子表格' })
    expect(presentPermission({
      code: 'admin:users',
      name: null,
      description: '管理用户',
    })).toEqual({ name: '用户管理', description: '管理用户' })
    expect(presentPermission({
      code: 'stock-prep:admin',
      name: 'Stock Prep Admin',
      description: 'Workbench-scoped stock-preparation administration (no pack install; may relabel still-English managed-table headers to their Chinese template names when the operator switch is on; includes the puller tier, which may create one per-project stock-preparation sheet from the frozen template when the project-sheets switch is on)',
    }).description).toBe('工作台范围内的备料管理（不含安装包；操作开关打开时，可将仍为英文的托管表表头改为其中文模板名；包含拉取层级，项目表开关打开时可按冻结模板为一个项目创建一张备料表）')
    expect(presentPermission({
      code: 'comments:read',
      name: 'Comments Read',
      description: 'Read comments and discussion threads',
    }).description).toBe('读取评论和讨论串')
  })

  it('keeps custom permission text, unknown codes, and prototype-like codes', () => {
    expect(presentPermission({
      code: 'attendance:read',
      name: 'Floor only',
      description: 'Read attendance records and summaries',
    })).toEqual({ name: 'Floor only', description: '读取考勤记录和汇总' })
    expect(presentPermission({
      code: 'attendance:read',
      name: 'Attendance Read',
      description: 'Site-specific note',
    })).toEqual({ name: '考勤读取', description: 'Site-specific note' })
    expect(presentPermission({
      code: 'not-a-real:permission',
      name: 'Attendance Read',
      description: 'Read attendance records and summaries',
    })).toEqual({
      name: 'Attendance Read',
      description: 'Read attendance records and summaries',
    })
    expect(presentPermission({
      code: 'constructor',
      name: 'Attendance Read',
      description: 'Read attendance records and summaries',
    })).toEqual({
      name: 'Attendance Read',
      description: 'Read attendance records and summaries',
    })
    expect(presentPermission({
      code: 'attendance__proto__read',
      name: 'Attendance Read',
      description: 'Read attendance records and summaries',
    })).toEqual({
      name: 'Attendance Read',
      description: 'Read attendance records and summaries',
    })
    expect(presentPermission({
      code: 'plugin_made:read',
      name: 'Plugin Made Read',
      description: 'Provisioned by demo: plugin_made:read',
    })).toEqual({
      name: 'Plugin Made Read',
      description: 'Provisioned by demo: plugin_made:read',
    })
  })

  it('translates every fresh-migration builtin default', () => {
    expect(freshCatalog.synthetic_only).toBe(true)
    expect(freshCatalog.roles).toHaveLength(12)
    expect(freshCatalog.permissions).toHaveLength(41)
    expect(freshCatalog.roles.map((role) => role.id).sort()).toEqual(Object.keys(FRESH_ROLE_TITLES).sort())
    expect(freshCatalog.permissions.map((permission) => permission.code).sort()).toEqual(
      Object.keys(FRESH_PERMISSIONS).sort(),
    )

    for (const role of freshCatalog.roles) {
      expect(presentRoleTitle(role)).toBe(FRESH_ROLE_TITLES[role.id])
    }
    for (const permission of freshCatalog.permissions) {
      const shown = presentPermission(permission)
      expect(shown).toEqual(FRESH_PERMISSIONS[permission.code])
      expect(shown.name).not.toBe(permission.name)
      expect(shown.description).not.toBe(permission.description)
    }
  })

  it('still translates historical aliases the fresh catalog does not insert', () => {
    const roleIds = new Set(freshCatalog.roles.map((role) => role.id))
    const codes = new Set(freshCatalog.permissions.map((permission) => permission.code))
    expect(roleIds.has('user')).toBe(false)
    expect(presentRoleTitle({ id: 'user', name: 'user' })).toBe('普通用户')
    expect(presentRoleTitle({ id: 'user', name: '普通用户' })).toBe('普通用户')
    expect(presentRoleTitle({ id: 'attendance_employee', name: 'attendance_employee' })).toBe('考勤员工')
    expect(presentRoleTitle({ id: 'stock-prep_frontline', name: '一线填写' })).toBe('一线填写')

    for (const code of [
      '*:*',
      'admin:users',
      'admin:roles',
      'admin:permissions',
      'permissions:read',
      'permissions:write',
      'roles:read',
      'roles:write',
      'spreadsheet:delete',
      'spreadsheet:share',
    ]) {
      expect(codes.has(code)).toBe(false)
    }
    expect(presentPermission({ code: '*:*', name: '', description: '所有权限' })).toEqual({
      name: '所有权限',
      description: '所有权限',
    })
    expect(presentPermission({ code: 'admin:roles', name: null, description: '管理角色' })).toEqual({
      name: '角色管理',
      description: '管理角色',
    })
    expect(presentPermission({ code: 'permissions:read', name: 'Permissions Read', description: 'List permissions' })).toEqual({
      name: '权限读取',
      description: '列出权限',
    })
    expect(presentPermission({ code: 'roles:write', name: 'Roles Write', description: 'Manage roles' })).toEqual({
      name: '角色写入',
      description: '管理角色',
    })
    expect(presentPermission({ code: 'spreadsheet:delete', name: '', description: '删除电子表格' })).toEqual({
      name: '电子表格删除',
      description: '删除电子表格',
    })
    expect(presentPermission({ code: 'spreadsheet:share', name: '', description: '分享电子表格' })).toEqual({
      name: '电子表格分享',
      description: '分享电子表格',
    })
    expect(presentPermission({
      code: 'demo:read',
      name: 'Demo Read',
      description: 'Demo read permission for CI',
    }).description).toBe('用于持续集成的演示读取权限')
    expect(presentPermission({
      code: 'attendance:write',
      name: 'Attendance Write',
      description: 'Create attendance punches and requests',
    }).description).toBe('创建考勤打卡和申请')
    expect(presentPermission({
      code: 'stock-prep:admin',
      name: 'Stock Prep Admin',
      description: 'Workbench-scoped stock-preparation administration (no provisioning, no pack install)',
    }).description).toBe('工作台范围内的备料管理（不含开通，不含安装包）')
  })

  it('persists the loaded raw name until the name field is explicitly edited', () => {
    expect(roleNameForSave('Attendance Admin', '考勤管理员', false)).toBe('Attendance Admin')
    expect(roleNameForSave('Floor Captain', 'Floor Captain', false)).toBe('Floor Captain')
    expect(roleNameForSave('Attendance Admin', '现场负责人', true)).toBe('现场负责人')
    expect(roleNameForSave('Attendance Admin', '考勤管理员', true)).toBe('考勤管理员')
    expect(roleNameForSave(null, '新建角色', false)).toBe('新建角色')
  })
})
