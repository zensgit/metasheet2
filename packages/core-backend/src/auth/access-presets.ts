export type AccessPresetProductMode = 'platform' | 'attendance' | 'plm-workbench'

export interface AccessPresetDefinition {
  id: string
  name: string
  description: string
  productMode: AccessPresetProductMode
  role: string
  roleId?: string
  permissions: string[]
  homePath: string
  welcomeTitle: string
  checklist: string[]
}

export interface OnboardingPacket {
  presetId: string | null
  productMode: AccessPresetProductMode
  homePath: string
  loginPath: string
  loginUrl: string
  acceptInvitePath: string
  acceptInviteUrl: string
  accountLabel: string
  welcomeTitle: string
  checklist: string[]
  inviteMessage: string
}

const ACCESS_PRESETS: AccessPresetDefinition[] = [
  {
    id: 'platform-editor',
    name: '平台编辑者',
    description: '适用于多维表与基础流程协作成员。',
    productMode: 'platform',
    role: 'user',
    permissions: ['spreadsheet:read', 'spreadsheet:write', 'spreadsheets:read', 'spreadsheets:write', 'workflow:read'],
    homePath: '/grid',
    welcomeTitle: 'MetaSheet 平台协作',
    checklist: ['登录后进入表格主页', '确认可访问表格与流程入口', '如需审批权限再由管理员追加授权'],
  },
  {
    id: 'platform-viewer',
    name: '平台只读用户',
    description: '适用于只读查看表格与流程状态。',
    productMode: 'platform',
    role: 'user',
    permissions: ['spreadsheet:read', 'spreadsheets:read', 'workflow:read'],
    homePath: '/grid',
    welcomeTitle: 'MetaSheet 平台只读访问',
    checklist: ['登录后确认只读访问范围', '如需编辑能力需管理员提升权限'],
  },
  {
    id: 'attendance-employee',
    name: '考勤员工',
    description: '适用于日常打卡与补卡申请。',
    productMode: 'attendance',
    role: 'user',
    roleId: 'attendance_employee',
    permissions: ['attendance:read', 'attendance:write'],
    homePath: '/attendance',
    welcomeTitle: 'MetaSheet 考勤员工入口',
    checklist: ['首次登录后确认班次与组织信息', '可进行打卡、记录查看与补卡申请'],
  },
  {
    id: 'attendance-approver',
    name: '考勤审批人',
    description: '适用于审批补卡、调班和异常申请。',
    productMode: 'attendance',
    role: 'user',
    roleId: 'attendance_approver',
    permissions: ['attendance:read', 'attendance:approve'],
    homePath: '/attendance',
    welcomeTitle: 'MetaSheet 考勤审批入口',
    checklist: ['确认审批范围', '进入考勤页查看待审批项目'],
  },
  {
    id: 'attendance-admin',
    name: '考勤管理员',
    description: '适用于规则、排班、导入与审批全量管理。',
    productMode: 'attendance',
    role: 'admin',
    roleId: 'attendance_admin',
    permissions: ['attendance:read', 'attendance:write', 'attendance:approve', 'attendance:admin'],
    homePath: '/attendance',
    welcomeTitle: 'MetaSheet 考勤管理入口',
    checklist: ['确认规则、班次与导入权限', '建议首次登录后检查系统设置'],
  },
  {
    id: 'plm-collaborator',
    name: 'PLM 协作成员',
    description: '适用于查看 PLM 工作台、审批与评论协作。',
    productMode: 'plm-workbench',
    role: 'user',
    permissions: ['spreadsheets:read', 'workflow:read', 'approvals:read', 'comments:read'],
    homePath: '/plm',
    welcomeTitle: 'MetaSheet PLM 协作入口',
    checklist: ['进入 PLM 工作台确认可见产品范围', '如需审批写入能力再由管理员追加权限'],
  },
]

export function listAccessPresets(): AccessPresetDefinition[] {
  return ACCESS_PRESETS.map((preset) => ({
    ...preset,
    permissions: [...preset.permissions],
    checklist: [...preset.checklist],
  }))
}

export function getAccessPreset(presetId?: string | null): AccessPresetDefinition | null {
  if (!presetId) return null
  return ACCESS_PRESETS.find((preset) => preset.id === presetId) || null
}

function resolvePublicAppBase(): string {
  const raw = process.env.PUBLIC_APP_URL || process.env.APP_BASE_URL || ''
  return raw.trim().replace(/\/$/, '')
}

export function buildOnboardingPacket(options: {
  email?: string | null
  accountLabel?: string | null
  temporaryPassword?: string | null
  preset: AccessPresetDefinition | null
  inviteToken?: string | null
}): OnboardingPacket {
  const productMode = options.preset?.productMode || 'platform'
  const homePath = options.preset?.homePath || '/grid'
  const loginPath = '/login'
  const acceptInvitePath = '/accept-invite'
  const appBase = resolvePublicAppBase()
  const loginUrl = `${appBase}${loginPath}?redirect=${encodeURIComponent(homePath)}`
  const acceptInviteUrl = options.inviteToken
    ? `${appBase}${acceptInvitePath}?token=${encodeURIComponent(options.inviteToken)}`
    : ''
  const welcomeTitle = options.preset?.welcomeTitle || 'MetaSheet 新用户引导'
  const checklist = options.preset?.checklist || ['登录后确认首页入口与权限范围']
  const accountLabel = (options.accountLabel || options.email || '由管理员单独告知').trim()
  const passwordLine = options.temporaryPassword
    ? `临时密码：${options.temporaryPassword}`
    : '初始密码：由管理员单独告知'

  const inviteMessage = [
    `${welcomeTitle}`,
    `账号：${accountLabel}`,
    passwordLine,
    ...(acceptInviteUrl ? [`首次设置密码：${acceptInviteUrl}`] : []),
    `登录地址：${loginUrl}`,
    `推荐入口：${homePath}`,
    `模式：${productMode}`,
    '',
    '建议首次登录后完成：',
    ...checklist.map((item, index) => `${index + 1}. ${item}`),
  ].join('\n')

  return {
    presetId: options.preset?.id || null,
    productMode,
    homePath,
    loginPath,
    loginUrl,
    acceptInvitePath,
    acceptInviteUrl,
    accountLabel,
    welcomeTitle,
    checklist,
    inviteMessage,
  }
}
