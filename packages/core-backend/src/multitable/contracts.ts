export type MultitableProvisioningFieldType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'date'
  | 'formula'
  | 'select'
  | 'multiSelect'
  | 'link'
  | 'lookup'
  | 'rollup'
  | 'attachment'
  | 'longText'

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
  groupInfo?: Record<string, unknown>
  hiddenFieldIds?: string[]
  config?: Record<string, unknown>
}
