/**
 * D8-b thin — pure read surface for template version diffs.
 * Combines `TemplateVersionDiff` counts with optional graph overlay badge tallies
 * so authoring/detail UIs can show a values-free change summary without dual-canvas chrome.
 * Does not load versions or call the network.
 */
import type { VersionGraphOverlay } from './versionGraphOverlay'
import type { TemplateVersionChangeKind, TemplateVersionDiff } from './templateVersionDiff'

export interface ApprovalVersionReadSummary {
  totalChanges: number
  fieldChanges: number
  nodeChanges: number
  edgeChanges: number
  /** Business-facing one-liners; never include raw edge/node keys as the primary label. */
  lines: string[]
  /** Overlay badge counts when a graph overlay is supplied (ghost add/remove/change). */
  overlay: {
    addedNodes: number
    removedNodes: number
    changedNodes: number
    addedEdges: number
    removedEdges: number
    changedEdges: number
  } | null
}

const KIND_LABEL: Record<TemplateVersionChangeKind, string> = {
  added: '新增',
  removed: '移除',
  changed: '变更',
  moved: '移动',
}

const ENTITY_LABEL = {
  field: '表单字段',
  node: '流程节点',
  edge: '连线',
} as const

function countKinds(
  map: Map<string, TemplateVersionChangeKind>,
): { added: number; removed: number; changed: number } {
  let added = 0
  let removed = 0
  let changed = 0
  for (const kind of map.values()) {
    if (kind === 'added') added += 1
    else if (kind === 'removed') removed += 1
    else if (kind === 'changed' || kind === 'moved') changed += 1
  }
  return { added, removed, changed }
}

/**
 * Build a read-only summary from an existing diff (+ optional overlay).
 * Empty diffs produce a single “无差异” line and zero counts.
 */
export function buildApprovalVersionReadSummary(
  diff: TemplateVersionDiff,
  overlay: VersionGraphOverlay | null = null,
): ApprovalVersionReadSummary {
  const lines: string[] = []
  if (diff.totalChanges === 0) {
    lines.push('与对照版本无差异')
  } else {
    lines.push(
      `共 ${diff.totalChanges} 处差异（字段 ${diff.fieldChanges} / 节点 ${diff.nodeChanges} / 连线 ${diff.edgeChanges}）`,
    )
    for (const change of diff.changes.slice(0, 12)) {
      const entity = ENTITY_LABEL[change.entity]
      const kind = KIND_LABEL[change.kind]
      const label = change.label?.trim() || entity
      lines.push(`${kind}${entity}：${label}`)
    }
    if (diff.changes.length > 12) {
      lines.push(`另有 ${diff.changes.length - 12} 处未列出`)
    }
  }

  let overlaySummary: ApprovalVersionReadSummary['overlay'] = null
  if (overlay) {
    const nodes = countKinds(overlay.nodeChanges)
    const edges = countKinds(overlay.edgeChanges)
    overlaySummary = {
      addedNodes: nodes.added,
      removedNodes: nodes.removed,
      changedNodes: nodes.changed,
      addedEdges: edges.added,
      removedEdges: edges.removed,
      changedEdges: edges.changed,
    }
  }

  return {
    totalChanges: diff.totalChanges,
    fieldChanges: diff.fieldChanges,
    nodeChanges: diff.nodeChanges,
    edgeChanges: diff.edgeChanges,
    lines,
    overlay: overlaySummary,
  }
}
