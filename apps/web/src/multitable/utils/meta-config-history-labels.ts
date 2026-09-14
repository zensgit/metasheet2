import type { MetaConfigRevision } from '../api/client'

type Label = { en: string; zh: string }
const label = (value: Label, isZh: boolean): string => isZh ? value.zh : value.en
const KEYS: Record<string, Label> = {
  name: { en: 'Name', zh: '名称' },
  type: { en: 'Type', zh: '类型' },
  property: { en: 'Field properties', zh: '字段属性' },
  order: { en: 'Order', zh: '排列顺序' },
  filterInfo: { en: 'Filter conditions', zh: '筛选条件' },
  sortInfo: { en: 'Sort rules', zh: '排序规则' },
  groupInfo: { en: 'Grouping', zh: '分组规则' },
  hiddenFieldIds: { en: 'Hidden fields', zh: '隐藏字段' },
  config: { en: 'View settings', zh: '视图设置' },
  grant: { en: 'Permission grant', zh: '权限授予' },
  role: { en: 'Role', zh: '角色' },
  userId: { en: 'User', zh: '用户' },
  subjectType: { en: 'Subject type', zh: '授权对象类型' },
  subjectId: { en: 'Subject', zh: '授权对象' },
  visible: { en: 'Visible', zh: '可见' },
  readOnly: { en: 'Read only', zh: '只读' },
  required: { en: 'Required', zh: '必填' },
  options: { en: 'Options', zh: '选项' },
  rowLevelReadPermissionsEnabled: { en: 'Row read permissions', zh: '行级读取权限' },
  conditionalReadRules: { en: 'Conditional read rules', zh: '条件读取规则' },
}

export function configHistoryKeyLabel(key: string, entityType: string, isZh: boolean): string {
  if (entityType === 'field') {
    if (key === 'name') return isZh ? '字段名称' : 'Field name'
    if (key === 'type') return isZh ? '字段类型' : 'Field type'
    if (key === 'order') return isZh ? '字段排列顺序' : 'Field order'
  }
  if (entityType === 'view' && key === 'name') return isZh ? '视图名称' : 'View name'
  if (entityType === 'sheet_config' && key === 'name') return isZh ? '数据表名称' : 'Table name'
  return KEYS[key] ? label(KEYS[key], isZh) : key
}

const ENTITIES: Record<string, Label> = {
  field: { en: 'field', zh: '字段' },
  view: { en: 'view', zh: '视图' },
  permission: { en: 'permission', zh: '权限' },
  sheet_config: { en: 'table settings', zh: '表级设置' },
}
const ACTIONS: Record<string, Label> = {
  create: { en: 'Create', zh: '新增' },
  update: { en: 'Update', zh: '更新' },
  delete: { en: 'Delete', zh: '删除' },
}
const UPDATES: Record<string, Record<string, Label>> = {
  field: {
    name: { en: 'Rename field', zh: '重命名字段' },
    type: { en: 'Change field type', zh: '修改字段类型' },
    property: { en: 'Change field properties', zh: '修改字段属性' },
    order: { en: 'Reorder field', zh: '调整字段位置' },
  },
  view: {
    name: { en: 'Rename view', zh: '重命名视图' },
    type: { en: 'Change view type', zh: '修改视图类型' },
    filterInfo: { en: 'Change filter conditions', zh: '修改筛选条件' },
    sortInfo: { en: 'Change sort rules', zh: '修改排序规则' },
    groupInfo: { en: 'Change grouping', zh: '修改分组规则' },
    hiddenFieldIds: { en: 'Change hidden fields', zh: '修改隐藏字段' },
    config: { en: 'Change view settings', zh: '修改视图设置' },
  },
  sheet_config: {
    name: { en: 'Rename table', zh: '重命名数据表' },
    rowLevelReadPermissionsEnabled: { en: 'Change row read permissions', zh: '修改行级读取权限' },
    conditionalReadRules: { en: 'Change conditional read rules', zh: '修改条件读取规则' },
  },
}

export function configHistoryOperation(rev: MetaConfigRevision, isZh: boolean): string {
  if (rev.action === 'update') {
    if (rev.entityType === 'permission') return isZh ? '修改权限' : 'Change permissions'
    if (rev.changedKeys.length === 1) {
      const specific = UPDATES[rev.entityType]?.[rev.changedKeys[0]]
      if (specific) return label(specific, isZh)
    }
  }
  const action = ACTIONS[rev.action] ? label(ACTIONS[rev.action], isZh) : rev.action
  const entity = ENTITIES[rev.entityType] ? label(ENTITIES[rev.entityType], isZh) : rev.entityType
  const summary = isZh ? `${action}${entity}` : `${action} ${entity}`
  if (rev.action !== 'update' || rev.changedKeys.length === 0) return summary
  const keys = rev.changedKeys.map((key) => configHistoryKeyLabel(key, rev.entityType, isZh))
  return `${summary}${isZh ? '：' : ': '}${keys.join(isZh ? '、' : ', ')}`
}

export function configHistoryEntityName(rev: MetaConfigRevision, resolve: (id: string) => string): string {
  const snapshot = rev.action === 'delete' ? rev.before : rev.after
  const name = snapshot?.name
  return typeof name === 'string' && name.trim() ? name : resolve(rev.entityId)
}

export function configHistoryTime(timestamp: string, isZh: boolean): string {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return timestamp
  // Omit timeZone to use the current viewer's device zone, not the actor's or the server's zone.
  return date.toLocaleString(isZh ? 'zh-CN' : 'en-US', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23', timeZoneName: 'short',
  })
}
