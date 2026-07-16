export type PlatformAppLabelKey =
  | 'header.eyebrow'
  | 'header.title'
  | 'header.subtitle'
  | 'action.refresh'
  | 'action.refreshing'
  | 'action.open'
  | 'action.install'
  | 'action.onboard'
  | 'action.reinstall'
  | 'action.recover'
  | 'action.diagnostics'
  | 'action.adminDiagnostics'
  | 'action.adminOnly'
  | 'action.description.direct'
  | 'action.description.install'
  | 'action.description.onboard'
  | 'action.description.reinstall'
  | 'action.description.recover'
  | 'action.description.failed'
  | 'action.description.inactive'
  | 'action.description.active'
  | 'state.loading'
  | 'state.empty'
  | 'state.error'
  | 'description.empty'
  | 'meta.plugin'
  | 'meta.install'
  | 'meta.dependencies'
  | 'meta.objects'
  | 'meta.workflows'
  | 'meta.project'
  | 'value.notRequired'
  | 'value.unavailable'
  | 'instance.direct'
  | 'instance.notInstalled'

type LocalizedLabel = { en: string; zh: string }

const PLATFORM_APP_LABELS: Record<PlatformAppLabelKey, LocalizedLabel> = {
  'header.eyebrow': { en: 'Platform Apps', zh: '平台应用' },
  'header.title': { en: 'App Center', zh: '应用中心' },
  'header.subtitle': {
    en: 'Browse available apps and continue work from their standard entry points.',
    zh: '查看平台可用应用，并从标准入口继续工作。',
  },
  'action.refresh': { en: 'Refresh apps', zh: '刷新应用' },
  'action.refreshing': { en: 'Refreshing apps', zh: '正在刷新应用' },
  'action.open': { en: 'Open app', zh: '打开应用' },
  'action.install': { en: 'Install app', zh: '安装应用' },
  'action.onboard': { en: 'Open onboarding', zh: '开始配置' },
  'action.reinstall': { en: 'Reinstall app', zh: '重新安装' },
  'action.recover': { en: 'Open recovery', zh: '进入修复' },
  'action.diagnostics': { en: 'Admin diagnostics', zh: '管理员诊断' },
  'action.adminDiagnostics': { en: 'Admin diagnostics', zh: '管理员诊断' },
  'action.adminOnly': {
    en: 'An administrator must review the app diagnostics.',
    zh: '需要管理员查看应用诊断信息。',
  },
  'action.description.direct': {
    en: 'Open this app from its standard entry point. No tenant installation is required.',
    zh: '从标准入口直接打开应用，无需为当前租户安装。',
  },
  'action.description.install': {
    en: 'No tenant app instance exists yet. Install it with the app-defined setup contract.',
    zh: '当前租户尚未安装应用实例，请按应用定义的配置流程完成安装。',
  },
  'action.description.onboard': {
    en: 'No tenant app instance exists yet. Open the app to complete its initial setup.',
    zh: '当前租户尚未安装应用实例，请打开应用完成首次配置。',
  },
  'action.description.reinstall': {
    en: 'The current app installation is incomplete. Reinstall it with the existing setup contract.',
    zh: '当前应用安装不完整，请按现有配置重新安装。',
  },
  'action.description.recover': {
    en: 'The current app installation is degraded. Open the app to repair it.',
    zh: '当前应用安装状态异常，请打开应用进行修复。',
  },
  'action.description.failed': {
    en: 'The plugin runtime is degraded. Review diagnostics before continuing.',
    zh: '插件运行状态异常，请先查看诊断信息。',
  },
  'action.description.inactive': {
    en: 'The app instance is inactive. Review diagnostics before reopening it.',
    zh: '应用实例已停用，请先查看诊断信息。',
  },
  'action.description.active': {
    en: 'The app is ready to open.',
    zh: '应用已就绪，可以直接打开。',
  },
  'state.loading': { en: 'Loading apps...', zh: '正在加载应用...' },
  'state.empty': { en: 'No apps are available.', zh: '暂无可用应用。' },
  'state.error': { en: 'Unable to load apps. Try again.', zh: '应用加载失败，请重试。' },
  'description.empty': {
    en: 'No app description is available.',
    zh: '暂无应用说明。',
  },
  'meta.plugin': { en: 'Plugin', zh: '插件' },
  'meta.install': { en: 'Install', zh: '安装状态' },
  'meta.dependencies': { en: 'Dependencies', zh: '依赖项' },
  'meta.objects': { en: 'Objects', zh: '数据对象' },
  'meta.workflows': { en: 'Workflows', zh: '工作流' },
  'meta.project': { en: 'Project', zh: '项目' },
  'value.notRequired': { en: 'Not required', zh: '无需项目' },
  'value.unavailable': { en: 'Unavailable', zh: '不可用' },
  'instance.direct': { en: 'Direct runtime', zh: '直接运行' },
  'instance.notInstalled': {
    en: 'App instance not installed for this tenant yet.',
    zh: '当前租户尚未安装应用实例。',
  },
}

const PLATFORM_APP_STATUS_LABELS: Record<string, LocalizedLabel> = {
  active: { en: 'Active', zh: '可用' },
  inactive: { en: 'Inactive', zh: '已停用' },
  failed: { en: 'Unavailable', zh: '异常' },
}

const PLATFORM_APP_INSTALL_STATE_LABELS: Record<string, LocalizedLabel> = {
  direct: { en: 'Direct entry', zh: '直接使用' },
  active: { en: 'Ready', zh: '已就绪' },
  inactive: { en: 'Inactive', zh: '已停用' },
  failed: { en: 'Failed', zh: '安装失败' },
  partial: { en: 'Incomplete', zh: '安装不完整' },
  'not-installed': { en: 'Not installed', zh: '未安装' },
}

const PLATFORM_APP_COPY: Record<string, { name: LocalizedLabel; description: LocalizedLabel }> = {
  attendance: {
    name: { en: 'Attendance', zh: '考勤' },
    description: {
      en: 'Attendance tracking, reports, import operations, and workflow-backed adjustments.',
      zh: '考勤记录、报表、导入操作及工作流驱动的调整。',
    },
  },
  'after-sales': {
    name: { en: 'After Sales', zh: '售后服务' },
    description: {
      en: 'Service tickets, warranty handling, dispatch, and closure feedback.',
      zh: '服务工单、保修处理、派工及闭环反馈。',
    },
  },
}

function resolveLocalizedLabel(entry: LocalizedLabel, isZh: boolean): string {
  return isZh ? entry.zh : entry.en
}

export function platformAppLabel(key: PlatformAppLabelKey, isZh: boolean): string {
  return resolveLocalizedLabel(PLATFORM_APP_LABELS[key], isZh)
}

export function platformAppStatusLabel(status: string, isZh: boolean): string {
  const entry = PLATFORM_APP_STATUS_LABELS[status]
  return entry ? resolveLocalizedLabel(entry, isZh) : status
}

export function platformAppInstallStateLabel(state: string, isZh: boolean): string {
  const entry = PLATFORM_APP_INSTALL_STATE_LABELS[state]
  return entry ? resolveLocalizedLabel(entry, isZh) : state
}

export function platformAppDisplayName(appId: string, fallback: string, isZh: boolean): string {
  const entry = PLATFORM_APP_COPY[appId]?.name
  return entry ? resolveLocalizedLabel(entry, isZh) : fallback
}

export function platformAppDescription(appId: string, fallback: string | undefined, isZh: boolean): string {
  const entry = PLATFORM_APP_COPY[appId]?.description
  if (entry) return resolveLocalizedLabel(entry, isZh)
  return fallback || platformAppLabel('description.empty', isZh)
}
