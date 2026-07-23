import type { ApprovalEdge, ApprovalGraph, ApprovalNode } from '../types/approval'
import type { TemplateVersionChangeKind, TemplateVersionDiff } from './templateVersionDiff'

export interface VersionGraphOverlay {
  graph: ApprovalGraph
  nodeChanges: Map<string, TemplateVersionChangeKind>
  edgeChanges: Map<string, TemplateVersionChangeKind>
}

function unionByKey<T extends { key: string }>(before: T[], after: T[]): T[] {
  // Inputs may be Vue reactive proxies. The overlay is read-only and never mutates entity config,
  // so a shallow entity copy is both sufficient and proxy-safe (`structuredClone` rejects Proxy).
  const result = after.map((value) => ({ ...value }))
  const seen = new Set(after.map((value) => value.key))
  for (const value of before) {
    if (!seen.has(value.key)) result.push({ ...value })
  }
  return result
}

export function buildVersionGraphOverlay(
  before: ApprovalGraph,
  after: ApprovalGraph,
  diff: TemplateVersionDiff,
): VersionGraphOverlay {
  const nodeChanges = new Map<string, TemplateVersionChangeKind>()
  const edgeChanges = new Map<string, TemplateVersionChangeKind>()
  for (const change of diff.changes) {
    if (change.entity === 'node') nodeChanges.set(change.key, change.kind)
    if (change.entity === 'edge') edgeChanges.set(change.key, change.kind)
  }

  return {
    graph: {
      nodes: unionByKey<ApprovalNode>(before.nodes, after.nodes),
      edges: unionByKey<ApprovalEdge>(before.edges, after.edges),
    },
    nodeChanges,
    edgeChanges,
  }
}
