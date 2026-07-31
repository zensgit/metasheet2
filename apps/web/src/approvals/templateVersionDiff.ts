import type {
  ApprovalEdge,
  ApprovalGraph,
  ApprovalNode,
  ApprovalTemplateVersionDetailDTO,
  FormField,
} from '../types/approval'
import {
  approvalEdgeDisplayLabel,
  approvalFieldDisplayLabel,
  approvalNodeDisplayLabel,
} from './approvalVersionPresentation'

export type TemplateVersionChangeKind = 'added' | 'removed' | 'changed' | 'moved'
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
  return approvalFieldDisplayLabel(field)
}

function nodeLabel(node: ApprovalNode): string {
  return approvalNodeDisplayLabel(node)
}

function edgeLabel(edge: ApprovalEdge, graph: ApprovalGraph): string {
  return approvalEdgeDisplayLabel(edge, graph)
}

function compareEntities<T>(
  before: T[],
  after: T[],
  keyOf: (value: T) => string,
  labelOf: (value: T, side: 'before' | 'after') => string,
  entity: TemplateVersionChangeEntity,
  options: { trackMoves?: boolean } = {},
): TemplateVersionChange[] {
  const beforeByKey = new Map(before.map((value) => [keyOf(value), value]))
  const afterByKey = new Map(after.map((value) => [keyOf(value), value]))
  // Rank keys by their position among SHARED keys only. Baking the absolute array index into the
  // comparison re-attributed every neighbour of an insertion/removal as "changed" (index churn);
  // relative rank only moves when a kept entry actually changes place among the kept entries.
  const rankAmongShared = (values: T[], other: Map<string, T>): Map<string, number> => {
    const ranks = new Map<string, number>()
    for (const value of values) {
      const key = keyOf(value)
      if (other.has(key)) ranks.set(key, ranks.size)
    }
    return ranks
  }
  const beforeRanks = options.trackMoves ? rankAmongShared(before, afterByKey) : null
  const afterRanks = options.trackMoves ? rankAmongShared(after, beforeByKey) : null
  const changes: TemplateVersionChange[] = []

  for (const [key, value] of beforeByKey) {
    const next = afterByKey.get(key)
    if (!next) {
      changes.push({ kind: 'removed', entity, key, label: labelOf(value, 'before') })
      continue
    }
    if (!sameValue(value, next)) {
      // Content attribution wins: an edited entry reports as "changed" even if it also moved.
      changes.push({ kind: 'changed', entity, key, label: labelOf(next, 'after') })
      continue
    }
    if (beforeRanks && afterRanks && beforeRanks.get(key) !== afterRanks.get(key)) {
      changes.push({ kind: 'moved', entity, key, label: labelOf(next, 'after') })
    }
  }
  for (const [key, value] of afterByKey) {
    if (!beforeByKey.has(key)) {
      changes.push({ kind: 'added', entity, key, label: labelOf(value, 'after') })
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
    (field) => fieldLabel(field),
    'field',
    // Field order is form-visible, so a repositioned-but-unchanged field still surfaces — as
    // 'moved', never as a spurious 'changed'. Node/edge order carries no semantics (the graph is
    // topology-keyed), so moves are not tracked there.
    { trackMoves: true },
  )
  const nodeChanges = compareEntities(
    before.approvalGraph.nodes,
    after.approvalGraph.nodes,
    (node) => node.key,
    (node) => nodeLabel(node),
    'node',
  )
  const edgeChanges = compareEntities(
    before.approvalGraph.edges,
    after.approvalGraph.edges,
    (edge) => edge.key,
    (edge, side) => edgeLabel(edge, side === 'before' ? before.approvalGraph : after.approvalGraph),
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
