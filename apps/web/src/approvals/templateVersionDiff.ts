import type {
  ApprovalEdge,
  ApprovalNode,
  ApprovalTemplateVersionDetailDTO,
  FormField,
} from '../types/approval'

export type TemplateVersionChangeKind = 'added' | 'removed' | 'changed'
export type TemplateVersionChangeEntity = 'field' | 'node' | 'edge'

export interface TemplateVersionChange {
  kind: TemplateVersionChangeKind
  entity: TemplateVersionChangeEntity
  key: string
  label: string
}

export interface TemplateVersionDiff {
  changes: TemplateVersionChange[]
  fieldChanges: number
  nodeChanges: number
  edgeChanges: number
  totalChanges: number
}

type VersionSnapshot = Pick<ApprovalTemplateVersionDetailDTO, 'formSchema' | 'approvalGraph'>

function normalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeJson)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, normalizeJson(entry)]),
  )
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(normalizeJson(left)) === JSON.stringify(normalizeJson(right))
}

function fieldLabel(field: FormField): string {
  return field.label || field.id
}

function nodeLabel(node: ApprovalNode): string {
  return node.name || node.key
}

function edgeLabel(edge: ApprovalEdge): string {
  return `${edge.source} -> ${edge.target}`
}

function compareEntities<T>(
  before: T[],
  after: T[],
  keyOf: (value: T) => string,
  labelOf: (value: T) => string,
  entity: TemplateVersionChangeEntity,
  valueOf: (value: T, index: number) => unknown = (value) => value,
): TemplateVersionChange[] {
  const beforeByKey = new Map(before.map((value, index) => [keyOf(value), { value, index }]))
  const afterByKey = new Map(after.map((value, index) => [keyOf(value), { value, index }]))
  const changes: TemplateVersionChange[] = []

  for (const [key, entry] of beforeByKey) {
    const next = afterByKey.get(key)
    if (!next) {
      changes.push({ kind: 'removed', entity, key, label: labelOf(entry.value) })
      continue
    }
    if (!sameValue(valueOf(entry.value, entry.index), valueOf(next.value, next.index))) {
      changes.push({ kind: 'changed', entity, key, label: labelOf(next.value) })
    }
  }
  for (const [key, entry] of afterByKey) {
    if (!beforeByKey.has(key)) {
      changes.push({ kind: 'added', entity, key, label: labelOf(entry.value) })
    }
  }
  return changes
}

export function diffApprovalTemplateVersions(
  before: VersionSnapshot,
  after: VersionSnapshot,
): TemplateVersionDiff {
  const fieldChanges = compareEntities(
    before.formSchema.fields,
    after.formSchema.fields,
    (field) => field.id,
    fieldLabel,
    'field',
    (field, index) => ({ index, field }),
  )
  const nodeChanges = compareEntities(
    before.approvalGraph.nodes,
    after.approvalGraph.nodes,
    (node) => node.key,
    nodeLabel,
    'node',
  )
  const edgeChanges = compareEntities(
    before.approvalGraph.edges,
    after.approvalGraph.edges,
    (edge) => edge.key,
    edgeLabel,
    'edge',
  )
  const changes = [...fieldChanges, ...nodeChanges, ...edgeChanges]

  return {
    changes,
    fieldChanges: fieldChanges.length,
    nodeChanges: nodeChanges.length,
    edgeChanges: edgeChanges.length,
    totalChanges: changes.length,
  }
}
