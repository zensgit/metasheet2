// Form-share manager chrome string table (T3C-2b).
//
// Scope: MetaFormShareManager.vue. User/group names, subtitles, public token
// values, backend error messages, and persisted access-mode values stay raw.

export type MetaFormShareLabelKey =
  | 'title'
  | 'state.loading'
  | 'toggle.enabled'
  | 'toggle.disabled'
  | 'status.active'
  | 'status.expired'
  | 'status.disabled'
  | 'access.label'
  | 'access.option.public'
  | 'access.option.dingtalk'
  | 'access.option.dingtalkGranted'
  | 'access.hint.public'
  | 'access.hint.dingtalk'
  | 'access.hint.dingtalkGranted'
  | 'audience.public.title'
  | 'audience.public.description'
  | 'audience.dingtalk.selected.title'
  | 'audience.dingtalk.selected.description'
  | 'audience.dingtalk.all.title'
  | 'audience.dingtalk.all.description'
  | 'audience.granted.selected.title'
  | 'audience.granted.selected.description'
  | 'audience.granted.all.title'
  | 'audience.granted.all.description'
  | 'allowlist.label'
  | 'allowlist.hint'
  | 'allowlist.summary.none'
  | 'allowlist.summary.prefix'
  | 'allowlist.summary.suffix'
  | 'allowlist.localUser'
  | 'allowlist.localUsers'
  | 'allowlist.localMemberGroup'
  | 'allowlist.localMemberGroups'
  | 'allowlist.join'
  | 'allowlist.searchPlaceholder'
  | 'allowlist.users'
  | 'allowlist.groups'
  | 'allowlist.inactiveUser'
  | 'allowlist.userEmpty'
  | 'allowlist.groupEmpty'
  | 'candidate.addSection'
  | 'candidate.loading'
  | 'candidate.empty'
  | 'candidate.user'
  | 'candidate.memberGroup'
  | 'candidate.inactiveUser'
  | 'dingtalk.memberGroup'
  | 'dingtalk.notBound'
  | 'dingtalk.boundAuthorized'
  | 'dingtalk.authorizationMissing'
  | 'dingtalk.bound'
  | 'dingtalk.deliveryLinked'
  | 'link.label'
  | 'link.copy'
  | 'link.copied'
  | 'link.regenerate'
  | 'link.preview'
  | 'expiry.label'
  | 'expiry.none'
  | 'error.loadConfig'
  | 'error.loadCandidates'
  | 'error.updateAllowlist'
  | 'error.update'
  | 'error.clearBeforePublic'
  | 'error.updateAccessMode'
  | 'error.regenerate'
  | 'error.updateExpiry'
  | 'error.clearExpiry'

const LABELS: Record<MetaFormShareLabelKey, { en: string; zh: string }> = {
  title: { en: 'Public Form Sharing', zh: '公开表单分享' },
  'state.loading': { en: 'Loading share settings...', zh: '正在加载分享设置...' },
  'toggle.enabled': { en: 'Sharing enabled', zh: '分享已启用' },
  'toggle.disabled': { en: 'Sharing disabled', zh: '分享已停用' },
  'status.active': { en: 'Active', zh: '有效' },
  'status.expired': { en: 'Expired', zh: '已过期' },
  'status.disabled': { en: 'Disabled', zh: '已停用' },
  'access.label': { en: 'Access mode', zh: '访问模式' },
  'access.option.public': { en: 'Anyone with the link', zh: '持有链接的任何人' },
  'access.option.dingtalk': { en: 'Bound DingTalk users only', zh: '仅已绑定钉钉用户' },
  'access.option.dingtalkGranted': { en: 'DingTalk-authorized users only', zh: '仅已授权钉钉用户' },
  'access.hint.public': { en: 'Anyone who has the link can open and submit this form.', zh: '持有链接的人都可以打开并提交此表单。' },
  'access.hint.dingtalk': {
    en: 'The form opens only after DingTalk sign-in, and the user must already be bound to a local account.',
    zh: '用户需先钉钉登录，且本地账户已绑定钉钉后才能打开此表单。',
  },
  'access.hint.dingtalkGranted': {
    en: 'The form opens only for DingTalk-bound users whose DingTalk grant is enabled by an administrator.',
    zh: '仅允许已绑定钉钉且管理员已启用钉钉授权的用户打开此表单。',
  },
  'audience.public.title': { en: 'Fully public anonymous form', zh: '完全公开匿名表单' },
  'audience.public.description': {
    en: 'Anyone with the link can open and submit without local login or DingTalk binding.',
    zh: '任何持有链接的人无需本地登录或钉钉绑定即可打开并提交。',
  },
  'audience.dingtalk.selected.title': { en: 'Selected DingTalk-bound users', zh: '已选已绑定钉钉用户' },
  'audience.dingtalk.selected.description': {
    en: 'Only selected local users or group members can fill, and each user must be bound to DingTalk.',
    zh: '只有已选本地用户或组成员可以填写，且每个用户必须已绑定钉钉。',
  },
  'audience.dingtalk.all.title': { en: 'All DingTalk-bound users', zh: '全部已绑定钉钉用户' },
  'audience.dingtalk.all.description': {
    en: 'Any local user can fill after DingTalk sign-in when their account is bound to DingTalk.',
    zh: '任意本地用户在钉钉登录且账户已绑定钉钉后即可填写。',
  },
  'audience.granted.selected.title': { en: 'Selected authorized DingTalk users', zh: '已选授权钉钉用户' },
  'audience.granted.selected.description': {
    en: 'Only selected local users or group members can fill, and each user must be DingTalk-bound with form authorization enabled.',
    zh: '只有已选本地用户或组成员可以填写，且每个用户必须已绑定钉钉并启用表单授权。',
  },
  'audience.granted.all.title': { en: 'All authorized DingTalk users', zh: '全部授权钉钉用户' },
  'audience.granted.all.description': {
    en: 'Any DingTalk-bound local user can fill after an administrator enables their DingTalk form authorization.',
    zh: '任意已绑定钉钉的本地用户，在管理员启用其钉钉表单授权后即可填写。',
  },
  'allowlist.label': { en: 'Allowed system users and member groups', zh: '允许的系统用户和成员组' },
  'allowlist.hint': {
    en: 'DingTalk is only the sign-in and delivery channel. The allowlist still targets your local users and member groups.',
    zh: '钉钉仅用于登录和投递通道；允许名单仍以本地用户和成员组为准。',
  },
  'allowlist.summary.none': {
    en: 'No local allowlist limits are set; all users allowed by the selected DingTalk mode can fill this form.',
    zh: '未设置本地允许名单限制；所有通过当前钉钉模式的用户都可以填写此表单。',
  },
  'allowlist.summary.prefix': { en: 'Local allowlist limits:', zh: '本地允许名单限制：' },
  'allowlist.summary.suffix': { en: 'can fill after passing the selected DingTalk mode.', zh: '通过当前钉钉模式后可以填写此表单。' },
  'allowlist.localUser': { en: 'local user', zh: '个本地用户' },
  'allowlist.localUsers': { en: 'local users', zh: '个本地用户' },
  'allowlist.localMemberGroup': { en: 'local member group', zh: '个本地成员组' },
  'allowlist.localMemberGroups': { en: 'local member groups', zh: '个本地成员组' },
  'allowlist.join': { en: ' and ', zh: '和 ' },
  'allowlist.searchPlaceholder': { en: 'Search local users or member groups', zh: '搜索本地用户或成员组' },
  'allowlist.users': { en: 'Allowed users', zh: '允许的用户' },
  'allowlist.groups': { en: 'Allowed member groups', zh: '允许的成员组' },
  'allowlist.inactiveUser': { en: 'Inactive user', zh: '已停用用户' },
  'allowlist.userEmpty': {
    en: 'No local user allowlist configured. Access is still gated by the selected DingTalk mode; add local users or member groups to narrow who can fill this form.',
    zh: '未配置本地用户允许名单。访问仍受当前钉钉模式限制；可添加本地用户或成员组来缩小可填写范围。',
  },
  'allowlist.groupEmpty': {
    en: 'No local member-group allowlist configured. Add a local member group to let its members fill this form.',
    zh: '未配置本地成员组允许名单。添加本地成员组后，其成员即可填写此表单。',
  },
  'candidate.addSection': { en: 'Add from eligible people and groups', zh: '从可添加人员和组中选择' },
  'candidate.loading': { en: 'Searching users and member groups...', zh: '正在搜索用户和成员组...' },
  'candidate.empty': { en: 'No matching candidates.', zh: '没有匹配的候选项。' },
  'candidate.user': { en: 'User', zh: '用户' },
  'candidate.memberGroup': { en: 'Member group', zh: '成员组' },
  'candidate.inactiveUser': { en: 'Inactive users cannot be added', zh: '已停用用户不能添加' },
  'dingtalk.memberGroup': { en: 'Members are checked individually', zh: '成员会逐个校验' },
  'dingtalk.notBound': { en: 'DingTalk not bound', zh: '未绑定钉钉' },
  'dingtalk.boundAuthorized': { en: 'DingTalk bound and authorized', zh: '已绑定钉钉并已授权' },
  'dingtalk.authorizationMissing': { en: 'DingTalk authorization not enabled', zh: '未启用钉钉授权' },
  'dingtalk.bound': { en: 'DingTalk bound', zh: '已绑定钉钉' },
  'dingtalk.deliveryLinked': { en: 'DingTalk delivery linked', zh: '已关联钉钉投递' },
  'link.label': { en: 'Public link', zh: '公开链接' },
  'link.copy': { en: 'Copy', zh: '复制' },
  'link.copied': { en: 'Copied!', zh: '已复制！' },
  'link.regenerate': { en: 'Regenerate token', zh: '重新生成令牌' },
  'link.preview': { en: 'Preview', zh: '预览' },
  'expiry.label': { en: 'Expiry', zh: '过期时间' },
  'expiry.none': { en: 'No expiry', zh: '无过期时间' },
  'error.loadConfig': { en: 'Failed to load share config', zh: '加载分享配置失败' },
  'error.loadCandidates': { en: 'Failed to load allowlist candidates', zh: '加载允许名单候选项失败' },
  'error.updateAllowlist': { en: 'Failed to update allowlist', zh: '更新允许名单失败' },
  'error.update': { en: 'Failed to update', zh: '更新失败' },
  'error.clearBeforePublic': {
    en: 'Clear the allowed users and member groups before switching back to a fully public form.',
    zh: '切换回完全公开表单前，请先清除允许的用户和成员组。',
  },
  'error.updateAccessMode': { en: 'Failed to update access mode', zh: '更新访问模式失败' },
  'error.regenerate': { en: 'Failed to regenerate token', zh: '重新生成令牌失败' },
  'error.updateExpiry': { en: 'Failed to update expiry', zh: '更新过期时间失败' },
  'error.clearExpiry': { en: 'Failed to clear expiry', zh: '清除过期时间失败' },
}

export function formShareLabel(key: MetaFormShareLabelKey, isZh: boolean): string {
  const entry = LABELS[key]
  return isZh ? entry.zh : entry.en
}

export function formShareStatusLabel(status: string | undefined, isZh: boolean): string {
  if (status === 'active') return formShareLabel('status.active', isZh)
  if (status === 'expired') return formShareLabel('status.expired', isZh)
  return formShareLabel('status.disabled', isZh)
}

export function formShareAccessModeHint(mode: string | undefined, isZh: boolean): string {
  if (mode === 'dingtalk_granted') return formShareLabel('access.hint.dingtalkGranted', isZh)
  if (mode === 'dingtalk') return formShareLabel('access.hint.dingtalk', isZh)
  return formShareLabel('access.hint.public', isZh)
}

export function formShareAudienceRule(
  mode: string | undefined,
  hasLocalAllowlist: boolean,
  isZh: boolean,
): { title: string; description: string } {
  if (mode === 'dingtalk_granted') {
    return hasLocalAllowlist
      ? {
          title: formShareLabel('audience.granted.selected.title', isZh),
          description: formShareLabel('audience.granted.selected.description', isZh),
        }
      : {
          title: formShareLabel('audience.granted.all.title', isZh),
          description: formShareLabel('audience.granted.all.description', isZh),
        }
  }
  if (mode === 'dingtalk') {
    return hasLocalAllowlist
      ? {
          title: formShareLabel('audience.dingtalk.selected.title', isZh),
          description: formShareLabel('audience.dingtalk.selected.description', isZh),
        }
      : {
          title: formShareLabel('audience.dingtalk.all.title', isZh),
          description: formShareLabel('audience.dingtalk.all.description', isZh),
        }
  }
  return {
    title: formShareLabel('audience.public.title', isZh),
    description: formShareLabel('audience.public.description', isZh),
  }
}

export function formShareAllowlistSummary(userCount: number, memberGroupCount: number, isZh: boolean): string {
  if (userCount === 0 && memberGroupCount === 0) {
    return formShareLabel('allowlist.summary.none', isZh)
  }

  const parts: string[] = []
  if (userCount > 0) {
    parts.push(`${userCount} ${formShareLabel(userCount === 1 ? 'allowlist.localUser' : 'allowlist.localUsers', isZh)}`)
  }
  if (memberGroupCount > 0) {
    parts.push(`${memberGroupCount} ${formShareLabel(memberGroupCount === 1 ? 'allowlist.localMemberGroup' : 'allowlist.localMemberGroups', isZh)}`)
  }

  const prefix = formShareLabel('allowlist.summary.prefix', isZh)
  const suffix = formShareLabel('allowlist.summary.suffix', isZh)
  return isZh
    ? `${prefix}${parts.join(formShareLabel('allowlist.join', isZh))}${suffix}`
    : `${prefix} ${parts.join(formShareLabel('allowlist.join', isZh))} ${suffix}`
}

export function formShareDingTalkStatusLabel(
  subject: {
    subjectType?: string
    dingtalkBound?: boolean | null
    dingtalkGrantEnabled?: boolean | null
    dingtalkPersonDeliveryAvailable?: boolean | null
  },
  mode: string | undefined,
  isZh: boolean,
): string {
  if (mode === 'public') return ''
  if (subject.subjectType === 'member-group') return formShareLabel('dingtalk.memberGroup', isZh)
  if (subject.subjectType !== 'user') return ''
  if (subject.dingtalkBound === false) return formShareLabel('dingtalk.notBound', isZh)
  if (mode === 'dingtalk_granted') {
    if (subject.dingtalkGrantEnabled === true) return formShareLabel('dingtalk.boundAuthorized', isZh)
    if (subject.dingtalkBound === true && subject.dingtalkGrantEnabled === false) {
      return formShareLabel('dingtalk.authorizationMissing', isZh)
    }
  }
  if (subject.dingtalkBound === true) return formShareLabel('dingtalk.bound', isZh)
  if (subject.dingtalkPersonDeliveryAvailable === true) return formShareLabel('dingtalk.deliveryLinked', isZh)
  return ''
}
