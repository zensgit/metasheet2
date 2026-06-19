// API token / webhook / DingTalk destination manager chrome string table (T3C-2c).
//
// Scope: MetaApiTokenManager.vue. Token names, webhook names/URLs, DingTalk
// destination names, subjects, timestamps, persisted enum values, HTTP status,
// secrets/tokens, and backend error messages stay raw.

export type MetaApiTokenLabelKey =
  | 'title.full' | 'title.basic'
  | 'tab.tokens' | 'tab.webhooks' | 'tab.dingtalkGroups'
  | 'notice.dingtalkPermission'
  | 'token.newShownOnce' | 'token.saveWarning'
  | 'token.newTitle' | 'token.name' | 'token.namePlaceholder'
  | 'token.scopes' | 'token.expiryOptional' | 'token.newButton'
  | 'token.loading' | 'token.empty' | 'token.meta.scopes'
  | 'token.meta.created' | 'token.meta.lastUsed' | 'token.meta.expires'
  | 'token.scope.none' | 'token.scope.read' | 'token.scope.write' | 'token.scope.admin'
  | 'token.scope.records-read' | 'token.scope.records-write' | 'token.scope.fields-read'
  | 'token.scope.comments-read' | 'token.scope.comments-write' | 'token.scope.webhooks-manage'
  | 'token.action.copy' | 'token.action.copied' | 'token.action.create'
  | 'token.action.rotate' | 'token.action.revoke'
  | 'webhook.newTitle' | 'webhook.editTitle' | 'webhook.name'
  | 'webhook.namePlaceholder' | 'webhook.url' | 'webhook.urlPlaceholder'
  | 'webhook.events' | 'webhook.secretOptional' | 'webhook.secretPlaceholder'
  | 'webhook.newButton' | 'webhook.loading' | 'webhook.empty'
  | 'webhook.status.active' | 'webhook.status.disabled'
  | 'webhook.meta.url' | 'webhook.meta.events' | 'webhook.meta.failures'
  | 'webhook.action.create' | 'webhook.action.update' | 'webhook.action.edit'
  | 'webhook.action.enable' | 'webhook.action.disable' | 'webhook.action.deliveries'
  | 'webhook.delivery.recent' | 'webhook.delivery.ok' | 'webhook.delivery.fail'
  | 'webhook.delivery.retries'
  | 'webhook.retry.section' | 'webhook.retry.maxRetries'
  | 'webhook.retry.maxRetriesHint' | 'webhook.retry.baseDelay'
  | 'webhook.retry.baseDelayHint' | 'webhook.retry.maxDelay'
  | 'webhook.retry.maxDelayHint' | 'webhook.retry.rangeError'
  | 'webhook.event.recordCreated' | 'webhook.event.recordUpdated'
  | 'webhook.event.recordDeleted' | 'webhook.event.fieldChanged'
  | 'dingtalk.scopeNote.title' | 'dingtalk.scopeNote.bound'
  | 'dingtalk.scopeNote.delivery'
  | 'dingtalk.newTitle' | 'dingtalk.editTitle'
  | 'dingtalk.name' | 'dingtalk.namePlaceholder'
  | 'dingtalk.webhookUrl' | 'dingtalk.webhookPlaceholder'
  | 'dingtalk.webhookHelp' | 'dingtalk.secretOptional'
  | 'dingtalk.secretPlaceholder' | 'dingtalk.secretHelp.new'
  | 'dingtalk.secretHelp.saved' | 'dingtalk.clearSecret'
  | 'dingtalk.enabled' | 'dingtalk.newButton'
  | 'dingtalk.loading' | 'dingtalk.empty'
  | 'dingtalk.status.enabled' | 'dingtalk.status.disabled'
  | 'dingtalk.meta.webhook' | 'dingtalk.meta.secret'
  | 'dingtalk.meta.secretConfigured' | 'dingtalk.meta.secretNotConfigured'
  | 'dingtalk.meta.created' | 'dingtalk.meta.lastTest'
  | 'dingtalk.meta.testStatus' | 'dingtalk.meta.lastError'
  | 'dingtalk.scope.org' | 'dingtalk.scope.orgWithId'
  | 'dingtalk.scope.sheet' | 'dingtalk.scope.sheetWithId'
  | 'dingtalk.scope.private'
  | 'dingtalk.action.create' | 'dingtalk.action.update'
  | 'dingtalk.action.edit' | 'dingtalk.action.enable' | 'dingtalk.action.disable'
  | 'dingtalk.action.deliveries' | 'dingtalk.action.testSend'
  | 'dingtalk.readonly'
  | 'dingtalk.delivery.recent' | 'dingtalk.delivery.loading'
  | 'dingtalk.delivery.empty' | 'dingtalk.delivery.manualTest'
  | 'dingtalk.delivery.automation'
  | 'error.loadTokens' | 'error.createToken' | 'error.revokeToken'
  | 'error.rotateToken' | 'error.loadWebhooks' | 'error.saveWebhook'
  | 'error.toggleWebhook' | 'error.deleteWebhook' | 'error.loadDeliveries'
  | 'error.loadDingTalkGroups' | 'error.saveDingTalkGroup'
  | 'error.toggleDingTalkGroup' | 'error.testDingTalkGroup'
  | 'error.loadDingTalkDeliveries' | 'error.deleteDingTalkGroup'
  | 'validation.webhookRequired' | 'validation.webhookInvalid'
  | 'validation.webhookHttps' | 'validation.webhookDingTalkUrl'
  | 'validation.webhookAccessToken' | 'validation.secretPrefix'

const LABELS: Record<MetaApiTokenLabelKey, { en: string; zh: string }> = {
  'title.full': { en: 'API Tokens, Webhooks & DingTalk Groups', zh: 'API 令牌、Webhook 与钉钉群' },
  'title.basic': { en: 'API Tokens & Webhooks', zh: 'API 令牌与 Webhook' },
  'tab.tokens': { en: 'API Tokens', zh: 'API 令牌' },
  'tab.webhooks': { en: 'Webhooks', zh: 'Webhook' },
  'tab.dingtalkGroups': { en: 'DingTalk Groups', zh: '钉钉群' },
  'notice.dingtalkPermission': {
    en: 'DingTalk group bindings require automation management permission for this table.',
    zh: '钉钉群绑定需要此表的自动化管理权限。',
  },
  'token.newShownOnce': { en: 'Your new API token (shown once):', zh: '新的 API 令牌（仅显示一次）：' },
  'token.saveWarning': { en: 'Save this token now. You will not be able to see it again.', zh: '请立即保存此令牌。之后将无法再次查看。' },
  'token.newTitle': { en: 'New API Token', zh: '新建 API 令牌' },
  'token.name': { en: 'Name', zh: '名称' },
  'token.namePlaceholder': { en: 'Token name', zh: '令牌名称' },
  'token.scopes': { en: 'Scopes', zh: '权限范围' },
  'token.expiryOptional': { en: 'Expiry (optional)', zh: '过期时间（可选）' },
  'token.newButton': { en: '+ New Token', zh: '+ 新建令牌' },
  'token.loading': { en: 'Loading tokens...', zh: '正在加载令牌...' },
  'token.empty': { en: 'No API tokens yet.', zh: '暂无 API 令牌。' },
  'token.meta.scopes': { en: 'Scopes', zh: '权限范围' },
  'token.meta.created': { en: 'Created', zh: '创建时间' },
  'token.meta.lastUsed': { en: 'Last used', zh: '上次使用' },
  'token.meta.expires': { en: 'Expires', zh: '过期时间' },
  'token.scope.none': { en: 'none', zh: '无' },
  'token.scope.read': { en: 'read', zh: '读取' },
  'token.scope.write': { en: 'write', zh: '写入' },
  'token.scope.admin': { en: 'admin', zh: '管理' },
  'token.scope.records-read': { en: 'Records: read', zh: '记录：读取' },
  'token.scope.records-write': { en: 'Records: write', zh: '记录：写入' },
  'token.scope.fields-read': { en: 'Fields: read', zh: '字段：读取' },
  'token.scope.comments-read': { en: 'Comments: read', zh: '评论：读取' },
  'token.scope.comments-write': { en: 'Comments: write', zh: '评论：写入' },
  'token.scope.webhooks-manage': { en: 'Webhooks: manage', zh: 'Webhook：管理' },
  'token.action.copy': { en: 'Copy', zh: '复制' },
  'token.action.copied': { en: 'Copied!', zh: '已复制！' },
  'token.action.create': { en: 'Create', zh: '创建' },
  'token.action.rotate': { en: 'Rotate', zh: '轮换' },
  'token.action.revoke': { en: 'Revoke', zh: '撤销' },
  'webhook.newTitle': { en: 'New Webhook', zh: '新建 Webhook' },
  'webhook.editTitle': { en: 'Edit Webhook', zh: '编辑 Webhook' },
  'webhook.name': { en: 'Name', zh: '名称' },
  'webhook.namePlaceholder': { en: 'Webhook name', zh: 'Webhook 名称' },
  'webhook.url': { en: 'URL (HTTPS required)', zh: 'URL（必须使用 HTTPS）' },
  'webhook.urlPlaceholder': { en: 'https://example.com/webhook', zh: 'https://example.com/webhook' },
  'webhook.events': { en: 'Events', zh: '事件' },
  'webhook.secretOptional': { en: 'Secret (optional)', zh: '密钥（可选）' },
  'webhook.secretPlaceholder': { en: 'HMAC secret', zh: 'HMAC 密钥' },
  'webhook.newButton': { en: '+ New Webhook', zh: '+ 新建 Webhook' },
  'webhook.loading': { en: 'Loading webhooks...', zh: '正在加载 Webhook...' },
  'webhook.empty': { en: 'No webhooks yet.', zh: '暂无 Webhook。' },
  'webhook.status.active': { en: 'Active', zh: '有效' },
  'webhook.status.disabled': { en: 'Disabled', zh: '已停用' },
  'webhook.meta.url': { en: 'URL', zh: 'URL' },
  'webhook.meta.events': { en: 'Events', zh: '事件' },
  'webhook.meta.failures': { en: 'Failures', zh: '失败次数' },
  'webhook.action.create': { en: 'Create', zh: '创建' },
  'webhook.action.update': { en: 'Update', zh: '更新' },
  'webhook.action.edit': { en: 'Edit', zh: '编辑' },
  'webhook.action.enable': { en: 'Enable', zh: '启用' },
  'webhook.action.disable': { en: 'Disable', zh: '停用' },
  'webhook.action.deliveries': { en: 'Deliveries', zh: '投递记录' },
  'webhook.delivery.recent': { en: 'Recent Deliveries', zh: '最近投递' },
  'webhook.delivery.ok': { en: 'OK', zh: '成功' },
  'webhook.delivery.fail': { en: 'FAIL', zh: '失败' },
  'webhook.delivery.retries': { en: 'Retries', zh: '重试次数' },
  'webhook.retry.section': { en: 'Retry policy (optional)', zh: '重试策略（可选）' },
  'webhook.retry.maxRetries': { en: 'Max retries', zh: '最大重试次数' },
  'webhook.retry.maxRetriesHint': { en: '0–10 (default 3)', zh: '0–10（默认 3）' },
  'webhook.retry.baseDelay': { en: 'Base delay (ms)', zh: '基础延迟（毫秒）' },
  'webhook.retry.baseDelayHint': { en: '100–60000 (default 1000)', zh: '100–60000（默认 1000）' },
  'webhook.retry.maxDelay': { en: 'Max delay (ms)', zh: '最大延迟（毫秒）' },
  'webhook.retry.maxDelayHint': { en: '1000–3600000 (optional)', zh: '1000–3600000（可选）' },
  'webhook.retry.rangeError': { en: 'Value is out of the allowed range.', zh: '取值超出允许范围。' },
  'webhook.event.recordCreated': { en: 'record.created', zh: '记录已创建' },
  'webhook.event.recordUpdated': { en: 'record.updated', zh: '记录已更新' },
  'webhook.event.recordDeleted': { en: 'record.deleted', zh: '记录已删除' },
  'webhook.event.fieldChanged': { en: 'field.changed', zh: '字段已变更' },
  'dingtalk.scopeNote.title': { en: 'Table-scoped DingTalk groups', zh: '表级钉钉群' },
  'dingtalk.scopeNote.bound': {
    en: 'Groups created here are bound to this table. You can add multiple groups and choose one or more in automations; organization catalog groups are listed read-only when shared with your organization.',
    zh: '此处创建的群会绑定到当前表。你可以添加多个群，并在自动化中选择一个或多个；组织共享的目录群会以只读方式展示。',
  },
  'dingtalk.scopeNote.delivery': {
    en: 'Register DingTalk robot webhooks as send destinations for this table. This does not import DingTalk group members or control form access.',
    zh: '将钉钉机器人 Webhook 注册为此表的发送目标。此功能不会导入钉钉群成员，也不会控制表单访问。',
  },
  'dingtalk.newTitle': { en: 'New DingTalk Group', zh: '新建钉钉群' },
  'dingtalk.editTitle': { en: 'Edit DingTalk Group', zh: '编辑钉钉群' },
  'dingtalk.name': { en: 'Name', zh: '名称' },
  'dingtalk.namePlaceholder': { en: 'Support group', zh: '支持群' },
  'dingtalk.webhookUrl': { en: 'Webhook URL', zh: 'Webhook URL' },
  'dingtalk.webhookPlaceholder': { en: 'https://oapi.dingtalk.com/robot/send?access_token=...', zh: 'https://oapi.dingtalk.com/robot/send?access_token=...' },
  'dingtalk.webhookHelp': {
    en: "Paste the robot webhook from the target DingTalk group robot settings. After saving, this destination appears in this table's automation rule editor. The access token is stored for delivery but masked in this UI.",
    zh: '粘贴目标钉钉群机器人设置中的 Webhook。保存后，该目标会出现在此表的自动化规则编辑器中。access_token 会用于投递存储，但在界面中脱敏显示。',
  },
  'dingtalk.secretOptional': { en: 'Secret (optional)', zh: '密钥（可选）' },
  'dingtalk.secretPlaceholder': { en: 'SEC...', zh: 'SEC...' },
  'dingtalk.secretHelp.new': {
    en: 'Fill this only when the DingTalk robot uses signature security. Leave empty for robots without a SEC secret.',
    zh: '仅当钉钉机器人启用签名安全时填写。没有 SEC 密钥的机器人请留空。',
  },
  'dingtalk.secretHelp.saved': {
    en: 'A SEC secret is already saved. Leave blank to keep it, enter a new SEC secret to replace it, or clear it below.',
    zh: '已保存 SEC 密钥。留空表示保留；输入新的 SEC 密钥可替换；也可在下方清除。',
  },
  'dingtalk.clearSecret': { en: 'Clear saved SEC secret', zh: '清除已保存的 SEC 密钥' },
  'dingtalk.enabled': { en: 'Enabled', zh: '已启用' },
  'dingtalk.newButton': { en: '+ New DingTalk Group', zh: '+ 新建钉钉群' },
  'dingtalk.loading': { en: 'Loading DingTalk groups...', zh: '正在加载钉钉群...' },
  'dingtalk.empty': {
    en: 'No DingTalk group destinations yet. Add a group robot webhook before configuring group-message automations.',
    zh: '暂无钉钉群目标。请先添加群机器人 Webhook，再配置群消息自动化。',
  },
  'dingtalk.status.enabled': { en: 'Enabled', zh: '已启用' },
  'dingtalk.status.disabled': { en: 'Disabled', zh: '已停用' },
  'dingtalk.meta.webhook': { en: 'Webhook', zh: 'Webhook' },
  'dingtalk.meta.secret': { en: 'Secret', zh: '密钥' },
  'dingtalk.meta.secretConfigured': { en: 'configured', zh: '已配置' },
  'dingtalk.meta.secretNotConfigured': { en: 'not configured', zh: '未配置' },
  'dingtalk.meta.created': { en: 'Created', zh: '创建时间' },
  'dingtalk.meta.lastTest': { en: 'Last test', zh: '上次测试' },
  'dingtalk.meta.testStatus': { en: 'Test status', zh: '测试状态' },
  'dingtalk.meta.lastError': { en: 'Last error', zh: '最近错误' },
  'dingtalk.scope.org': { en: 'Organization catalog group', zh: '组织目录群' },
  'dingtalk.scope.orgWithId': { en: 'Organization catalog group', zh: '组织目录群' },
  'dingtalk.scope.sheet': { en: 'Shared with this sheet', zh: '与此表共享' },
  'dingtalk.scope.sheetWithId': { en: 'Shared with sheet', zh: '共享到表' },
  'dingtalk.scope.private': { en: 'Private legacy group', zh: '私有旧版群' },
  'dingtalk.action.create': { en: 'Create', zh: '创建' },
  'dingtalk.action.update': { en: 'Update', zh: '更新' },
  'dingtalk.action.edit': { en: 'Edit', zh: '编辑' },
  'dingtalk.action.enable': { en: 'Enable', zh: '启用' },
  'dingtalk.action.disable': { en: 'Disable', zh: '停用' },
  'dingtalk.action.deliveries': { en: 'Deliveries', zh: '投递记录' },
  'dingtalk.action.testSend': { en: 'Test send', zh: '测试发送' },
  'dingtalk.readonly': { en: 'Managed by organization admins', zh: '由组织管理员管理' },
  'dingtalk.delivery.recent': { en: 'Recent Deliveries', zh: '最近投递' },
  'dingtalk.delivery.loading': { en: 'Loading DingTalk deliveries...', zh: '正在加载钉钉投递...' },
  'dingtalk.delivery.empty': { en: 'No DingTalk deliveries yet.', zh: '暂无钉钉投递。' },
  'dingtalk.delivery.manualTest': { en: 'Manual test', zh: '手动测试' },
  'dingtalk.delivery.automation': { en: 'Automation', zh: '自动化' },
  'error.loadTokens': { en: 'Failed to load tokens', zh: '加载令牌失败' },
  'error.createToken': { en: 'Failed to create token', zh: '创建令牌失败' },
  'error.revokeToken': { en: 'Failed to revoke token', zh: '撤销令牌失败' },
  'error.rotateToken': { en: 'Failed to rotate token', zh: '轮换令牌失败' },
  'error.loadWebhooks': { en: 'Failed to load webhooks', zh: '加载 Webhook 失败' },
  'error.saveWebhook': { en: 'Failed to save webhook', zh: '保存 Webhook 失败' },
  'error.toggleWebhook': { en: 'Failed to toggle webhook', zh: '切换 Webhook 状态失败' },
  'error.deleteWebhook': { en: 'Failed to delete webhook', zh: '删除 Webhook 失败' },
  'error.loadDeliveries': { en: 'Failed to load deliveries', zh: '加载投递记录失败' },
  'error.loadDingTalkGroups': { en: 'Failed to load DingTalk groups', zh: '加载钉钉群失败' },
  'error.saveDingTalkGroup': { en: 'Failed to save DingTalk group', zh: '保存钉钉群失败' },
  'error.toggleDingTalkGroup': { en: 'Failed to toggle DingTalk group', zh: '切换钉钉群状态失败' },
  'error.testDingTalkGroup': { en: 'Failed to test DingTalk group', zh: '测试钉钉群失败' },
  'error.loadDingTalkDeliveries': { en: 'Failed to load DingTalk deliveries', zh: '加载钉钉投递失败' },
  'error.deleteDingTalkGroup': { en: 'Failed to delete DingTalk group', zh: '删除钉钉群失败' },
  'validation.webhookRequired': { en: 'Webhook URL is required', zh: 'Webhook URL 为必填项' },
  'validation.webhookInvalid': { en: 'Webhook URL is not a valid URL', zh: 'Webhook URL 不是有效 URL' },
  'validation.webhookHttps': { en: 'DingTalk robot webhook URL must use HTTPS', zh: '钉钉机器人 Webhook URL 必须使用 HTTPS' },
  'validation.webhookDingTalkUrl': {
    en: 'Use the DingTalk group robot webhook from https://oapi.dingtalk.com/robot/send',
    zh: '请使用来自 https://oapi.dingtalk.com/robot/send 的钉钉群机器人 Webhook',
  },
  'validation.webhookAccessToken': { en: 'DingTalk group robot webhook must include access_token', zh: '钉钉群机器人 Webhook 必须包含 access_token' },
  'validation.secretPrefix': { en: 'DingTalk robot secret must start with SEC', zh: '钉钉机器人密钥必须以 SEC 开头' },
}

export function apiTokenLabel(key: MetaApiTokenLabelKey, isZh: boolean): string {
  const entry = LABELS[key]
  return isZh ? entry.zh : entry.en
}

export function apiManagerTitle(canManageDingTalkGroups: boolean, isZh: boolean): string {
  return apiTokenLabel(canManageDingTalkGroups ? 'title.full' : 'title.basic', isZh)
}

const API_SCOPE_LABEL_KEY: Record<string, MetaApiTokenLabelKey> = {
  'records:read': 'token.scope.records-read',
  'records:write': 'token.scope.records-write',
  'fields:read': 'token.scope.fields-read',
  'comments:read': 'token.scope.comments-read',
  'comments:write': 'token.scope.comments-write',
  'webhooks:manage': 'token.scope.webhooks-manage',
}

export function apiScopeLabel(scope: string, isZh: boolean): string {
  const key = API_SCOPE_LABEL_KEY[scope]
  if (key) return apiTokenLabel(key, isZh)
  // Legacy/unknown values render raw (covers any pre-existing read/write/admin display).
  if (scope === 'read') return apiTokenLabel('token.scope.read', isZh)
  if (scope === 'write') return apiTokenLabel('token.scope.write', isZh)
  if (scope === 'admin') return apiTokenLabel('token.scope.admin', isZh)
  return scope
}

export function apiScopesText(scopes: readonly string[], isZh: boolean): string {
  if (scopes.length === 0) return apiTokenLabel('token.scope.none', isZh)
  return scopes.map((scope) => apiScopeLabel(scope, isZh)).join(', ')
}

export function apiWebhookEventLabel(event: string, isZh: boolean): string {
  if (event === 'record.created') return apiTokenLabel('webhook.event.recordCreated', isZh)
  if (event === 'record.updated') return apiTokenLabel('webhook.event.recordUpdated', isZh)
  if (event === 'record.deleted') return apiTokenLabel('webhook.event.recordDeleted', isZh)
  if (event === 'field.changed') return apiTokenLabel('webhook.event.fieldChanged', isZh)
  return event
}

export function apiWebhookEventsText(events: readonly string[], isZh: boolean): string {
  return events.map((event) => apiWebhookEventLabel(event, isZh)).join(', ')
}

export function apiWebhookStatusLabel(active: boolean, isZh: boolean): string {
  return apiTokenLabel(active ? 'webhook.status.active' : 'webhook.status.disabled', isZh)
}

export function apiDingTalkEnabledLabel(enabled: boolean, isZh: boolean): string {
  return apiTokenLabel(enabled ? 'dingtalk.status.enabled' : 'dingtalk.status.disabled', isZh)
}

export function apiToggleLabel(enabled: boolean, isZh: boolean): string {
  return apiTokenLabel(enabled ? 'webhook.action.disable' : 'webhook.action.enable', isZh)
}

export function apiDingTalkToggleLabel(enabled: boolean, isZh: boolean): string {
  return apiTokenLabel(enabled ? 'dingtalk.action.disable' : 'dingtalk.action.enable', isZh)
}

export function apiDeliveryResultLabel(success: boolean, isZh: boolean): string {
  return apiTokenLabel(success ? 'webhook.delivery.ok' : 'webhook.delivery.fail', isZh)
}

export function apiDingTalkScopeLabel(
  scope: 'private' | 'sheet' | 'org',
  ids: { sheetId?: string; orgId?: string },
  isZh: boolean,
): string {
  if (scope === 'org') {
    const label = apiTokenLabel(ids.orgId ? 'dingtalk.scope.orgWithId' : 'dingtalk.scope.org', isZh)
    return ids.orgId ? `${label}: ${ids.orgId}` : label
  }
  if (scope === 'sheet') {
    const label = apiTokenLabel(ids.sheetId ? 'dingtalk.scope.sheetWithId' : 'dingtalk.scope.sheet', isZh)
    return ids.sheetId ? `${label}: ${ids.sheetId}` : label
  }
  return apiTokenLabel('dingtalk.scope.private', isZh)
}

export function apiDingTalkSecretStateLabel(hasSecret: boolean, isZh: boolean): string {
  return apiTokenLabel(hasSecret ? 'dingtalk.meta.secretConfigured' : 'dingtalk.meta.secretNotConfigured', isZh)
}

export function apiDingTalkDeliverySourceLabel(sourceType: string, isZh: boolean): string {
  if (sourceType === 'manual_test') return apiTokenLabel('dingtalk.delivery.manualTest', isZh)
  if (sourceType === 'automation') return apiTokenLabel('dingtalk.delivery.automation', isZh)
  return sourceType
}
