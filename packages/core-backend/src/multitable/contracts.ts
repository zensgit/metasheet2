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
