/**
 * provisioning(模板装表 / 插件建表)认得的字段类型。
 *
 * F7 补了 13 种自洽类型(person 起至 modifiedBy),让「先在数据表里把类型调好、再一键存为
 * 模板」这条路真的成立 —— 在此之前这些类型存进模板会被拍成文本列。`meta_fields.type` 是
 * 裸 text 无 CHECK(zzz20251231_create_meta_schema.ts),所以加宽不需要任何 DDL / 数据迁移。
 * 加宽只影响「装得下什么」,不影响任何读面或权限判定。
 */
export type MultitableProvisioningFieldType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'date'
  | 'dateTime'
  | 'formula'
  | 'select'
  | 'multiSelect'
  | 'link'
  | 'lookup'
  | 'rollup'
  | 'attachment'
  | 'barcode'
  | 'qrcode'
  | 'location'
  | 'longText'
  | 'person'
  | 'currency'
  | 'percent'
  | 'rating'
  | 'duration'
  | 'url'
  | 'email'
  | 'phone'
  | 'autoNumber'
  | 'createdTime'
  | 'modifiedTime'
  | 'createdBy'
  | 'modifiedBy'

export interface MultitableProvisioningFieldDescriptor {
  id: string
  name: string
  type: MultitableProvisioningFieldType
  order?: number
  options?: string[]
  property?: Record<string, unknown>
}

export interface MultitableProvisioningObjectDescriptor {
  id: string
  name: string
  description?: string | null
  fields?: MultitableProvisioningFieldDescriptor[]
}

export interface MultitableProvisioningViewDescriptor {
  id: string
  objectId: string
  name: string
  type: string
  filterInfo?: Record<string, unknown>
  sortInfo?: Record<string, unknown>
  // groupInfo (grid nested grouping): NEW `{ fieldIds: string[] }` ordered 1..3 levels, with legacy
  // `{ fieldId }` still written as level-1 + dual-read for back-compat. Parity with frontend types.ts.
  groupInfo?: Record<string, unknown>
  hiddenFieldIds?: string[]
  config?: Record<string, unknown>
}
