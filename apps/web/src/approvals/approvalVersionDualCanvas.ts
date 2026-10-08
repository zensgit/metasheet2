/**
 * D8-b residual — pure dual-canvas model for side-by-side version compare.
 * Left = 对照版本 (before), right = 当前版本 (after). Each side lays out its own graph;
 * change helpers resolve via optional VersionGraphOverlay or explicit node/edge maps.
 * No network. No Vue.
 */
import type { ApprovalGraph } from '../types/approval'
import type { TemplateVersionChangeKind } from './templateVersionDiff'
import type { VersionGraphOverlay } from './versionGraphOverlay'
import { computeLayout, type GraphLayout } from './graphLayout'

const EMPTY_GRAPH: ApprovalGraph = { nodes: [], edges: [] }

export interface ApprovalVersionDualCanvasSide {
  title: string
  graph: ApprovalGraph
  layout: GraphLayout
}

export interface ApprovalVersionDualCanvasModel {
  left: ApprovalVersionDualCanvasSide
  right: ApprovalVersionDualCanvasSide
  nodeChanges: Map<string, TemplateVersionChangeKind>
  edgeChanges: Map<string, TemplateVersionChangeKind>
  nodeChange: (key: string) => TemplateVersionChangeKind | undefined
  edgeChange: (key: string) => TemplateVersionChangeKind | undefined
}

export interface ApprovalVersionDualCanvasOptions {
  /** Preferred source of change maps (union overlay from buildVersionGraphOverlay). */
  overlay?: VersionGraphOverlay | null
  /** Explicit node change map when overlay is not supplied. */
  nodeChanges?: Map<string, TemplateVersionChangeKind>
  /** Explicit edge change map when overlay is not supplied. */
  edgeChanges?: Map<string, TemplateVersionChangeKind>
}

function resolveGraph(graph: ApprovalGraph | null | undefined): ApprovalGraph {
  if (!graph) return EMPTY_GRAPH
  return {
    nodes: graph.nodes ?? [],
    edges: graph.edges ?? [],
  }
}

/**
 * Build a read-only dual-canvas model: independent layouts for before/after graphs,
 * plus key→kind helpers for ghost/change styling on each side.
 */
export function buildApprovalVersionDualCanvas(
  before: ApprovalGraph | null,
  after: ApprovalGraph | null,
  options: ApprovalVersionDualCanvasOptions = {},
): ApprovalVersionDualCanvasModel {
  const leftGraph = resolveGraph(before)
  const rightGraph = resolveGraph(after)

  const nodeChanges =
    options.overlay?.nodeChanges
    ?? options.nodeChanges
    ?? new Map<string, TemplateVersionChangeKind>()
  const edgeChanges =
    options.overlay?.edgeChanges
    ?? options.edgeChanges
    ?? new Map<string, TemplateVersionChangeKind>()

  const nodeChange = (key: string): TemplateVersionChangeKind | undefined =>
    nodeChanges.get(key)
  const edgeChange = (key: string): TemplateVersionChangeKind | undefined =>
    edgeChanges.get(key)

  return {
    left: {
      title: '对照版本',
      graph: leftGraph,
      layout: computeLayout(leftGraph),
    },
    right: {
      title: '当前版本',
      graph: rightGraph,
      layout: computeLayout(rightGraph),
    },
    nodeChanges,
    edgeChanges,
    nodeChange,
    edgeChange,
  }
}
