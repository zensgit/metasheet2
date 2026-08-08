// E1 spike layout: constrained vertical tree. Coordinates are render-only and
// never written back into ApprovalGraph. Branch lane order comes from gateway
// config.branches (default condition branch always rightmost), never graph.nodes order.
import type {
  ApprovalEdge,
  ApprovalGraph,
  ApprovalNode,
  ApprovalNodeType,
  ConditionNodeConfig,
  ParallelNodeConfig,
} from '../src/types/approval'
import type { E1Fixture } from './approval-flow-canvas-e1-fixtures'

export const E1_NODE_WIDTH = 200
export const E1_H_GAP = 56
export const E1_V_GAP = 56
export const E1_MARGIN_X = 48
export const E1_MARGIN_Y = 40
export const E1_INSERT_SIZE = 40

export interface E1CardModel {
  /** Opaque render id (never a graph key). */
  focusId: string
  /** Internal graph key — keep out of DOM text/aria. */
  nodeKey: string
  type: ApprovalNodeType
  name: string
  typeLabel: string
  summaryLines: string[]
  /** Optional state badges in business language. */
  badges: string[]
  x: number
  y: number
  width: number
  /** Content-driven height (estimated first, then measured). */
  height: number
  /** True when this card is the matched join of a parallel fork. */
  isJoin?: boolean
  joinModeLabel?: string
  pairedFocusId?: string
}

export interface E1BranchLabelModel {
  focusId: string
  gatewayFocusId: string
  /** Visual left-to-right order (0 = leftmost). */
  order: number
  /** 1-based priority for rule branches; omitted for default. */
  priority?: number
  label: string
  isDefault: boolean
  /** Center x of the branch lane (for label placement). */
  x: number
  y: number
}

export interface E1EdgeModel {
  focusId: string
  edgeKey: string
  sourceFocusId: string
  targetFocusId: string
  sourceNodeKey: string
  targetNodeKey: string
  /** SVG path in canvas coordinates. */
  path: string
  midX: number
  midY: number
  insertable: boolean
  ariaLabel: string
  branchLabel?: string
  branchPriority?: number
  isDefaultBranch?: boolean
}

export interface E1LayoutModel {
  cards: E1CardModel[]
  edges: E1EdgeModel[]
  branchLabels: E1BranchLabelModel[]
  width: number
  height: number
  /** focusId order for keyboard spine navigation. */
  focusOrder: string[]
}

const TYPE_LABEL: Record<ApprovalNodeType, string> = {
  start: '开始',
  end: '结束',
  approval: '审批',
  cc: '抄送',
  condition: '条件',
  parallel: '并行',
}

function cloneGraph(graph: ApprovalGraph): ApprovalGraph {
  return JSON.parse(JSON.stringify(graph)) as ApprovalGraph
}

function nodeMap(graph: ApprovalGraph): Map<string, ApprovalNode> {
  return new Map(graph.nodes.map((node) => [node.key, node]))
}

function outEdgesOf(graph: ApprovalGraph, key: string): ApprovalEdge[] {
  return graph.edges.filter((edge) => edge.source === key)
}

function inEdgesOf(graph: ApprovalGraph, key: string): ApprovalEdge[] {
  return graph.edges.filter((edge) => edge.target === key)
}

/** Ordered outgoing edges for a gateway: config.branches first, default last. */
export function orderedGatewayOutEdges(graph: ApprovalGraph, node: ApprovalNode): ApprovalEdge[] {
  const outs = outEdgesOf(graph, node.key)
  const byKey = new Map(outs.map((edge) => [edge.key, edge]))
  if (node.type === 'condition') {
    const config = node.config as ConditionNodeConfig
    const ordered: ApprovalEdge[] = []
    for (const branch of config.branches ?? []) {
      const edge = byKey.get(branch.edgeKey)
      if (edge) ordered.push(edge)
    }
    if (config.defaultEdgeKey) {
      const def = byKey.get(config.defaultEdgeKey)
      if (def) ordered.push(def)
    }
    // Any unexpected outs append last (should not happen on valid graphs).
    for (const edge of outs) {
      if (!ordered.includes(edge)) ordered.push(edge)
    }
    return ordered
  }
  if (node.type === 'parallel') {
    const config = node.config as ParallelNodeConfig
    const ordered: ApprovalEdge[] = []
    for (const edgeKey of config.branches ?? []) {
      const edge = byKey.get(edgeKey)
      if (edge) ordered.push(edge)
    }
    for (const edge of outs) {
      if (!ordered.includes(edge)) ordered.push(edge)
    }
    return ordered
  }
  return outs
}

function summarizeNode(node: ApprovalNode, fixture: E1Fixture): string[] {
  if (node.type === 'start' || node.type === 'end') return []
  if (node.type === 'cc') {
    const config = node.config as { targetType?: string; targetIds?: string[] }
    if (config.targetType === 'role') return ['角色：相关主管']
    const n = config.targetIds?.length ?? 0
    return n > 0 ? [`${n} 名成员`] : ['未配置抄送对象']
  }
  if (node.type === 'condition') {
    const config = node.config as ConditionNodeConfig
    const n = (config.branches?.length ?? 0) + (config.defaultEdgeKey ? 1 : 0)
    return [`${n} 个分支${config.defaultEdgeKey ? ' · 含默认分支' : ''}`]
  }
  if (node.type === 'parallel') {
    const config = node.config as ParallelNodeConfig
    const n = config.branches?.length ?? 0
    const mode = config.joinMode === 'any' ? '任一完成后合并' : '全部完成后合并'
    return [`${n} 个并行分支 · ${mode}`]
  }
  // approval
  const config = node.config as {
    assigneeSources?: Array<{ kind: string; userIds?: string[]; roleIds?: string[] }>
    approvalMode?: string
    timeout?: unknown
    approvalThreshold?: unknown
    legacyHandlerProfile?: unknown
  }
  const lines: string[] = []
  const sources = config.assigneeSources ?? []
  const parts: string[] = []
  for (const source of sources) {
    if (source.kind === 'direct_manager') parts.push('直属上级')
    else if (source.kind === 'dept_head') parts.push('部门负责人')
    else if (source.kind === 'requester') parts.push('发起人')
    else if (source.kind === 'static_role') parts.push(`角色：${(source.roleIds?.length ?? 0) > 1 ? '多个角色' : '指定角色'}`)
    else if (source.kind === 'static_user') parts.push(`${source.userIds?.length ?? 0} 名指定成员`)
    else parts.push('审批人')
  }
  if (parts.length) lines.push(parts.join('、'))
  if (config.approvalMode === 'all') lines.push('全部通过')
  else if (config.approvalMode === 'any') lines.push('任一通过')
  else lines.push('单人审批')
  // Third summary line for the long-label fixture (assignee richness).
  if (sources.length >= 3) lines.push('含角色与上级会签')
  if (fixture.readOnly && (config.timeout || config.approvalThreshold || config.legacyHandlerProfile)) {
    if (config.timeout) lines.push('含超时策略（只读）')
    if (config.approvalThreshold) lines.push('含通过阈值（只读）')
    if (config.legacyHandlerProfile) lines.push('含历史扩展配置（只读）')
  }
  return lines.slice(0, 3)
}

function estimateHeight(summaryLines: string[], badges: string[]): number {
  const base = 52 // type + name
  const lineH = 18
  const badgeH = badges.length ? 22 : 0
  return base + summaryLines.length * lineH + badgeH + 16
}

function branchLabelFor(
  edgeKey: string,
  gateway: ApprovalNode,
  orderAmongRules: number,
  isDefault: boolean,
  fixture: E1Fixture,
): string {
  if (fixture.branchDisplayLabels?.[edgeKey]) return fixture.branchDisplayLabels[edgeKey]!
  if (isDefault) return '默认分支（其他情况）'
  if (gateway.type === 'parallel') return `分支 ${orderAmongRules + 1}`
  return `优先级 ${orderAmongRules + 1}`
}

function pointsToPath(points: Array<{ x: number; y: number }>): string {
  return points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ')
}

function pathClearsCards(
  points: Array<{ x: number; y: number }>,
  cards: E1CardModel[],
  sourceFocusId: string,
  targetFocusId: string,
): boolean {
  for (const card of cards) {
    if (card.focusId === sourceFocusId || card.focusId === targetFocusId) continue
    if (polylineHitsRect(points, { x: card.x, y: card.y, w: card.width, h: card.height })) {
      return false
    }
  }
  return true
}

/**
 * Orthogonal edge routing that never crosses a non-endpoint card.
 * 1. Prefer a straight vertical or single mid-Y elbow in a free horizontal corridor.
 * 2. If intermediate cards block that corridor, detour around their bounding box.
 */
function routeOrthogonalEdge(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  cards: E1CardModel[],
  sourceFocusId: string,
  targetFocusId: string,
): { path: string; midX: number; midY: number } {
  const tryPoints = (points: Array<{ x: number; y: number }>) =>
    pathClearsCards(points, cards, sourceFocusId, targetFocusId)

  // Same column: straight vertical when clear.
  if (Math.abs(x1 - x2) < 1) {
    const direct = [
      { x: x1, y: y1 },
      { x: x2, y: y2 },
    ]
    if (tryPoints(direct)) {
      return { path: pointsToPath(direct), midX: x1, midY: (y1 + y2) / 2 }
    }
  }

  // Candidate horizontal corridors between source bottom and target top.
  const candidates: number[] = []
  if (y2 - y1 > 4) {
    candidates.push(y1 + (y2 - y1) / 2)
    candidates.push(y1 + Math.min(16, (y2 - y1) / 3))
    candidates.push(y2 - Math.min(16, (y2 - y1) / 3))
    // Prefer channels that sit in vertical gaps between card y-ranges.
    const gapYs: number[] = []
    for (const card of cards) {
      if (card.focusId === sourceFocusId || card.focusId === targetFocusId) continue
      const bottom = card.y + card.height
      const top = card.y
      if (bottom > y1 && bottom < y2) gapYs.push(bottom + 8)
      if (top > y1 && top < y2) gapYs.push(top - 8)
    }
    candidates.push(...gapYs)
    for (let y = y1 + 8; y < y2 - 8; y += 8) candidates.push(y)
  }

  for (const midY of candidates) {
    if (!(midY > y1 && midY < y2)) continue
    const points =
      Math.abs(x1 - x2) < 1
        ? [
            { x: x1, y: y1 },
            { x: x2, y: y2 },
          ]
        : [
            { x: x1, y: y1 },
            { x: x1, y: midY },
            { x: x2, y: midY },
            { x: x2, y: y2 },
          ]
    if (tryPoints(points)) {
      return {
        path: pointsToPath(points),
        midX: Math.abs(x1 - x2) < 1 ? x1 : (x1 + x2) / 2,
        midY,
      }
    }
  }

  // Detour left/right around cards that intersect the vertical span.
  const blockers = cards.filter((card) => {
    if (card.focusId === sourceFocusId || card.focusId === targetFocusId) return false
    const verticallyBetween = card.y + card.height > y1 && card.y < y2
    if (!verticallyBetween) return false
    const minX = Math.min(x1, x2)
    const maxX = Math.max(x1, x2)
    // Same-column blockers, or any card overlapping the horizontal travel range.
    const coversSourceX = card.x < x1 && card.x + card.width > x1
    const coversTargetX = card.x < x2 && card.x + card.width > x2
    const overlapsTravel = !(card.x + card.width < minX || card.x > maxX)
    return coversSourceX || coversTargetX || overlapsTravel
  })

  const pad = 20
  const sideXs: number[] = []
  if (blockers.length) {
    sideXs.push(Math.min(...blockers.map((card) => card.x)) - pad)
    sideXs.push(Math.max(...blockers.map((card) => card.x + card.width)) + pad)
  }
  // Also try gutters outside the full card field.
  if (cards.length) {
    sideXs.push(Math.min(...cards.map((card) => card.x)) - pad)
    sideXs.push(Math.max(...cards.map((card) => card.x + card.width)) + pad)
  }

  for (const sideX of sideXs) {
    const clearTop = blockers.length
      ? Math.min(...blockers.map((card) => card.y)) - 10
      : y1 + (y2 - y1) / 4
    const clearBot = blockers.length
      ? Math.max(...blockers.map((card) => card.y + card.height)) + 10
      : y2 - (y2 - y1) / 4
    const yA = Math.max(y1 + 6, Math.min(clearTop, y2 - 12))
    const yB = Math.min(y2 - 6, Math.max(clearBot, y1 + 12))
    if (!(yA > y1 && yB < y2 && yB >= yA)) continue
    const points = [
      { x: x1, y: y1 },
      { x: x1, y: yA },
      { x: sideX, y: yA },
      { x: sideX, y: yB },
      { x: x2, y: yB },
      { x: x2, y: y2 },
    ]
    if (tryPoints(points)) {
      return { path: pointsToPath(points), midX: sideX, midY: (yA + yB) / 2 }
    }
  }

  // Last resort: simple elbow (may still be used for zero-obstacle graphs).
  const midY = y1 + (y2 - y1) / 2
  const fallback =
    Math.abs(x1 - x2) < 1
      ? [
          { x: x1, y: y1 },
          { x: x2, y: y2 },
        ]
      : [
          { x: x1, y: y1 },
          { x: x1, y: midY },
          { x: x2, y: midY },
          { x: x2, y: y2 },
        ]
  return {
    path: pointsToPath(fallback),
    midX: Math.abs(x1 - x2) < 1 ? x1 : (x1 + x2) / 2,
    midY,
  }
}

/**
 * Deterministic vertical-tree layout.
 * - Lane order: gateway config.branches, default rightmost
 * - Card height: content-driven estimate (caller may reflow with measured heights)
 * - No coordinates written to the graph
 */
export function computeE1Layout(fixture: E1Fixture, measuredHeights?: Map<string, number>): E1LayoutModel {
  const graph = cloneGraph(fixture.graph)
  const nodes = nodeMap(graph)
  const startNode = graph.nodes.find((node) => node.type === 'start')
  if (!startNode) {
    return { cards: [], edges: [], branchLabels: [], width: 400, height: 200, focusOrder: [] }
  }

  // Longest-path layer from start.
  const layer = new Map<string, number>()
  for (const node of graph.nodes) layer.set(node.key, 0)
  for (let pass = 0; pass < graph.nodes.length; pass += 1) {
    let changed = false
    for (const edge of graph.edges) {
      const s = layer.get(edge.source) ?? 0
      const t = layer.get(edge.target) ?? 0
      if (s + 1 > t) {
        layer.set(edge.target, s + 1)
        changed = true
      }
    }
    if (!changed) break
  }
  layer.set(startNode.key, 0)

  // Lane assignment: exclusive horizontal strips per branch, ordered by gateway
  // config.branches (default rightmost). Nested gateways reserve contiguous
  // subtree width so a nested condition cannot share a column with a sibling
  // parallel branch (that collision is what made join edges punch through cards).
  const lane = new Map<string, number>()
  const widthMemo = new Map<string, number>()

  /** Exclusive lane-units needed by the region starting at `entryKey` until a join fan-in. */
  const regionWidth = (entryKey: string, visiting: Set<string> = new Set()): number => {
    if (widthMemo.has(entryKey)) return widthMemo.get(entryKey)!
    if (visiting.has(entryKey)) return 1
    visiting.add(entryKey)
    const node = nodes.get(entryKey)
    if (!node) {
      visiting.delete(entryKey)
      return 1
    }
    if (node.type === 'condition' || node.type === 'parallel') {
      const outs = orderedGatewayOutEdges(graph, node)
      let sum = 0
      for (const edge of outs) {
        const indeg = inEdgesOf(graph, edge.target).length
        // Direct edge into a join counts as a single placeholder strip.
        sum += indeg > 1 ? 1 : regionWidth(edge.target, visiting)
      }
      const width = Math.max(1, sum)
      widthMemo.set(entryKey, width)
      visiting.delete(entryKey)
      return width
    }
    const outs = outEdgesOf(graph, entryKey)
    if (outs.length === 0) {
      widthMemo.set(entryKey, 1)
      visiting.delete(entryKey)
      return 1
    }
    // Linear continuation: width is the max over non-join successors (usually one).
    let maxW = 1
    for (const edge of outs) {
      const indeg = inEdgesOf(graph, edge.target).length
      if (indeg > 1) continue
      maxW = Math.max(maxW, regionWidth(edge.target, visiting))
    }
    widthMemo.set(entryKey, maxW)
    visiting.delete(entryKey)
    return maxW
  }

  /**
   * Place `entryKey` into exclusive lanes starting at `laneStart`.
   * Returns the exclusive end lane index (start + width).
   * Join nodes (in-degree > 1) are centered over the parent gateway's strip.
   */
  const placeRegion = (entryKey: string, laneStart: number, gatewayStrip?: { start: number; end: number }): number => {
    const node = nodes.get(entryKey)
    if (!node) return laneStart + 1
    const indeg = inEdgesOf(graph, entryKey).length
    if (indeg > 1 && gatewayStrip) {
      // Join sits on the center of the owning gateway's full strip.
      const mid = (gatewayStrip.start + gatewayStrip.end - 1) / 2
      if (lane.get(entryKey) === undefined) lane.set(entryKey, mid)
      return gatewayStrip.end
    }

    if (node.type === 'condition' || node.type === 'parallel') {
      const outs = orderedGatewayOutEdges(graph, node)
      const widths = outs.map((edge) => {
        const targetIndeg = inEdgesOf(graph, edge.target).length
        return targetIndeg > 1 ? 1 : regionWidth(edge.target)
      })
      const total = Math.max(1, widths.reduce((a, b) => a + b, 0))
      const strip = { start: laneStart, end: laneStart + total }
      // Gateway card centered over its branch strip.
      lane.set(entryKey, (strip.start + strip.end - 1) / 2)
      let cursor = laneStart
      outs.forEach((edge, index) => {
        const w = widths[index] ?? 1
        const targetIndeg = inEdgesOf(graph, edge.target).length
        if (targetIndeg > 1) {
          if (lane.get(edge.target) === undefined) {
            lane.set(edge.target, (strip.start + strip.end - 1) / 2)
          }
        } else {
          placeRegion(edge.target, cursor, strip)
        }
        cursor += w
      })
      // Parallel join always centers on THIS gateway's full strip (nested gateways
      // may have tentatively placed it on their narrower strip while walking outs).
      if (node.type === 'parallel') {
        const joinKey = (node.config as ParallelNodeConfig).joinNodeKey
        if (joinKey) {
          lane.set(joinKey, (strip.start + strip.end - 1) / 2)
          for (const out of outEdgesOf(graph, joinKey)) {
            if (lane.get(out.target) === undefined) placeRegion(out.target, strip.start)
          }
        }
      }
      return strip.end
    }

    // Linear node: single lane, push successors.
    lane.set(entryKey, laneStart)
    for (const edge of outEdgesOf(graph, entryKey)) {
      const targetIndeg = inEdgesOf(graph, edge.target).length
      if (targetIndeg > 1) {
        // Join / rejoin: center on the owning gateway strip when present.
        if (lane.get(edge.target) === undefined) {
          lane.set(
            edge.target,
            gatewayStrip ? (gatewayStrip.start + gatewayStrip.end - 1) / 2 : laneStart,
          )
        }
        // Always continue the spine past the join once (condition rejoins used to
        // stop here, leaving later gateways unplaced at lane 0 — stacked cards).
        const spineStart = gatewayStrip ? gatewayStrip.start : laneStart
        for (const out of outEdgesOf(graph, edge.target)) {
          if (lane.get(out.target) === undefined) placeRegion(out.target, spineStart)
        }
        continue
      }
      placeRegion(edge.target, laneStart, gatewayStrip)
    }
    return laneStart + regionWidth(entryKey)
  }

  placeRegion(startNode.key, 0)

  // Ensure every node has a lane.
  for (const node of graph.nodes) {
    if (lane.get(node.key) === undefined) lane.set(node.key, 0)
  }

  // Normalize lanes to integer ranks 0..N-1 for packing.
  const uniqueLanes = [...new Set([...lane.values()])].sort((a, b) => a - b)
  const laneRank = new Map<number, number>()
  uniqueLanes.forEach((value, index) => laneRank.set(value, index))

  // Per-layer max height for vertical packing (content-driven).
  const byLayer = new Map<number, string[]>()
  for (const node of graph.nodes) {
    const l = layer.get(node.key) ?? 0
    if (!byLayer.has(l)) byLayer.set(l, [])
    byLayer.get(l)!.push(node.key)
  }
  // Within each layer, sort left-to-right by lane rank (gateway config order), NOT nodes[] order.
  for (const [l, keys] of byLayer) {
    keys.sort((a, b) => (laneRank.get(lane.get(a)!) ?? 0) - (laneRank.get(lane.get(b)!) ?? 0))
    byLayer.set(l, keys)
  }

  const focusIdByKey = new Map<string, string>()
  let focusCounter = 0
  // Stable focus ids by layer/lane order (not graph.nodes order).
  const sortedLayers = [...byLayer.keys()].sort((a, b) => a - b)
  for (const l of sortedLayers) {
    for (const key of byLayer.get(l)!) {
      focusIdByKey.set(key, `n${focusCounter}`)
      focusCounter += 1
    }
  }

  // Parallel join pairing.
  const joinOfFork = new Map<string, string>()
  const forkOfJoin = new Map<string, string>()
  for (const node of graph.nodes) {
    if (node.type !== 'parallel') continue
    const config = node.config as ParallelNodeConfig
    if (config.joinNodeKey) {
      joinOfFork.set(node.key, config.joinNodeKey)
      forkOfJoin.set(config.joinNodeKey, node.key)
    }
  }

  const cards: E1CardModel[] = []
  const cardByKey = new Map<string, E1CardModel>()
  const layerHeights = new Map<number, number>()

  for (const l of sortedLayers) {
    let maxH = 0
    for (const key of byLayer.get(l)!) {
      const node = nodes.get(key)!
      const summaryLines = summarizeNode(node, fixture)
      const badges: string[] = []
      if (fixture.readOnly) badges.push('只读')
      if (forkOfJoin.has(key)) {
        const fork = nodes.get(forkOfJoin.get(key)!)
        const mode = (fork?.config as ParallelNodeConfig | undefined)?.joinMode
        badges.push(mode === 'any' ? '任一完成' : '全部完成')
      }
      const height = measuredHeights?.get(key) ?? estimateHeight(summaryLines, badges)
      maxH = Math.max(maxH, height)
      const card: E1CardModel = {
        focusId: focusIdByKey.get(key)!,
        nodeKey: key,
        type: node.type,
        name: node.name?.trim() || typeFallbackName(node.type),
        typeLabel: TYPE_LABEL[node.type],
        summaryLines,
        badges,
        x: 0, // filled after width known
        y: 0,
        width: E1_NODE_WIDTH,
        height,
        isJoin: forkOfJoin.has(key),
        joinModeLabel: forkOfJoin.has(key)
          ? (nodes.get(forkOfJoin.get(key)!)?.config as ParallelNodeConfig).joinMode === 'any'
            ? '任一分支完成后继续，其余分支自动跳过'
            : '所有分支都完成后继续'
          : undefined,
        pairedFocusId: forkOfJoin.has(key)
          ? focusIdByKey.get(forkOfJoin.get(key)!)
          : joinOfFork.has(key)
            ? focusIdByKey.get(joinOfFork.get(key)!)
            : undefined,
      }
      cards.push(card)
      cardByKey.set(key, card)
    }
    layerHeights.set(l, maxH)
  }

  const laneCount = Math.max(1, uniqueLanes.length)
  const contentWidth = laneCount * E1_NODE_WIDTH + (laneCount - 1) * E1_H_GAP
  const width = E1_MARGIN_X * 2 + contentWidth

  // Center each layer's cards by their lane ranks across full width.
  let yCursor = E1_MARGIN_Y
  for (const l of sortedLayers) {
    const keys = byLayer.get(l)!
    const maxH = layerHeights.get(l) ?? 64
    for (const key of keys) {
      const card = cardByKey.get(key)!
      const rank = laneRank.get(lane.get(key)!) ?? 0
      // Map rank into x so lanes align across layers.
      card.x = E1_MARGIN_X + rank * (E1_NODE_WIDTH + E1_H_GAP)
      card.y = yCursor
    }
    yCursor += maxH + E1_V_GAP
  }
  const height = yCursor - E1_V_GAP + E1_MARGIN_Y

  // Branch labels at gateway exits.
  const branchLabels: E1BranchLabelModel[] = []
  let branchFocus = 0
  for (const node of graph.nodes) {
    if (node.type !== 'condition' && node.type !== 'parallel') continue
    const ordered = orderedGatewayOutEdges(graph, node)
    const gatewayFocusId = focusIdByKey.get(node.key)!
    const gatewayCard = cardByKey.get(node.key)!
    const config = node.config as ConditionNodeConfig | ParallelNodeConfig
    const defaultKey = node.type === 'condition' ? (config as ConditionNodeConfig).defaultEdgeKey : undefined
    ordered.forEach((edge, order) => {
      const isDefault = Boolean(defaultKey && edge.key === defaultKey)
      const ruleIndex = isDefault ? -1 : order
      const priority = isDefault ? undefined : (node.type === 'condition' ? order + 1 : order + 1)
      const label = branchLabelFor(edge.key, node, isDefault ? order : ruleIndex, isDefault, fixture)
      const targetCard = cardByKey.get(edge.target)
      const x = targetCard ? targetCard.x + targetCard.width / 2 : gatewayCard.x + gatewayCard.width / 2
      const y = gatewayCard.y + gatewayCard.height + 10
      branchLabels.push({
        focusId: `b${branchFocus}`,
        gatewayFocusId,
        order,
        priority,
        label,
        isDefault,
        x,
        y,
      })
      branchFocus += 1
    })
  }

  // Edges + insertion midpoints. Orthogonal routes must stay clear of every
  // non-endpoint card — geometric midY alone is not enough when an intermediate
  // layer sits between source and target (or when a same-column card blocks a
  // straight vertical join edge).
  const edges: E1EdgeModel[] = []
  let edgeFocus = 0
  for (const edge of graph.edges) {
    const sourceCard = cardByKey.get(edge.source)
    const targetCard = cardByKey.get(edge.target)
    if (!sourceCard || !targetCard) continue
    const x1 = sourceCard.x + sourceCard.width / 2
    const y1 = sourceCard.y + sourceCard.height
    const x2 = targetCard.x + targetCard.width / 2
    const y2 = targetCard.y
    const routed = routeOrthogonalEdge(x1, y1, x2, y2, cards, sourceCard.focusId, targetCard.focusId)
    const sourceNode = nodes.get(edge.source)!
    const insertable = sourceNode.type !== 'end' && !fixture.readOnly
    const sourceName = sourceCard.name
    // Branch metadata for gateway outs.
    let branchLabel: string | undefined
    let branchPriority: number | undefined
    let isDefaultBranch: boolean | undefined
    if (sourceNode.type === 'condition' || sourceNode.type === 'parallel') {
      const ordered = orderedGatewayOutEdges(graph, sourceNode)
      const order = ordered.findIndex((item) => item.key === edge.key)
      const defaultKey =
        sourceNode.type === 'condition'
          ? (sourceNode.config as ConditionNodeConfig).defaultEdgeKey
          : undefined
      isDefaultBranch = Boolean(defaultKey && edge.key === defaultKey)
      branchPriority = isDefaultBranch || order < 0 ? undefined : order + 1
      branchLabel = branchLabelFor(
        edge.key,
        sourceNode,
        isDefaultBranch ? order : order,
        Boolean(isDefaultBranch),
        fixture,
      )
    }
    edges.push({
      focusId: `e${edgeFocus}`,
      edgeKey: edge.key,
      sourceFocusId: sourceCard.focusId,
      targetFocusId: targetCard.focusId,
      sourceNodeKey: edge.source,
      targetNodeKey: edge.target,
      path: routed.path,
      midX: routed.midX,
      midY: routed.midY,
      insertable,
      ariaLabel: insertable ? `在「${sourceName}」之后插入节点` : `连线：从「${sourceName}」到「${targetCard.name}」`,
      branchLabel,
      branchPriority,
      isDefaultBranch,
    })
    edgeFocus += 1
  }

  // Keyboard focus order: top-to-bottom, left-to-right by layout.
  const focusOrder = [...cards]
    .sort((a, b) => (a.y - b.y) || (a.x - b.x))
    .map((card) => card.focusId)

  return { cards, edges, branchLabels, width, height, focusOrder }
}

function typeFallbackName(type: ApprovalNodeType): string {
  switch (type) {
    case 'start':
      return '发起'
    case 'end':
      return '结束'
    case 'approval':
      return '未命名审批'
    case 'cc':
      return '未命名抄送'
    case 'condition':
      return '未命名条件'
    case 'parallel':
      return '未命名并行'
    default:
      return '未命名节点'
  }
}

/** Axis-aligned rect intersection (strict area > 0). */
export function rectsOverlap(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
  epsilon = 0.5,
): boolean {
  return (
    a.x + a.w > b.x + epsilon &&
    b.x + b.w > a.x + epsilon &&
    a.y + a.h > b.y + epsilon &&
    b.y + b.h > a.y + epsilon
  )
}

/** Does the polyline pass through the interior of a card (not at endpoints)? */
export function polylineHitsRect(
  points: Array<{ x: number; y: number }>,
  rect: { x: number; y: number; w: number; h: number },
  pad = 1,
): boolean {
  const r = { x: rect.x + pad, y: rect.y + pad, w: rect.w - pad * 2, h: rect.h - pad * 2 }
  if (r.w <= 0 || r.h <= 0) return false
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[i]!
    const p1 = points[i + 1]!
    if (segmentIntersectsRect(p0, p1, r)) {
      // Ignore pure attachment at the top/bottom edge centers.
      const attachesTop =
        Math.abs(p0.y - rect.y) <= pad + 2 || Math.abs(p1.y - rect.y) <= pad + 2
      const attachesBottom =
        Math.abs(p0.y - (rect.y + rect.h)) <= pad + 2 ||
        Math.abs(p1.y - (rect.y + rect.h)) <= pad + 2
      const nearVerticalEdge =
        Math.abs(p0.x - (rect.x + rect.w / 2)) <= pad + 2 ||
        Math.abs(p1.x - (rect.x + rect.w / 2)) <= pad + 2
      if ((attachesTop || attachesBottom) && nearVerticalEdge && i === 0) continue
      if ((attachesTop || attachesBottom) && nearVerticalEdge && i === points.length - 2) continue
      // Interior hit.
      const mid = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 }
      if (pointInRect(mid, r)) return true
      if (pointInRect(p0, r) && !(attachesTop || attachesBottom)) return true
      if (pointInRect(p1, r) && !(attachesTop || attachesBottom)) return true
    }
  }
  return false
}

function pointInRect(p: { x: number; y: number }, r: { x: number; y: number; w: number; h: number }): boolean {
  return p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h
}

function segmentIntersectsRect(
  p0: { x: number; y: number },
  p1: { x: number; y: number },
  r: { x: number; y: number; w: number; h: number },
): boolean {
  // Liang-Barsky style quick reject via bounding boxes + sample.
  if (pointInRect(p0, r) || pointInRect(p1, r)) return true
  const minX = Math.min(p0.x, p1.x)
  const maxX = Math.max(p0.x, p1.x)
  const minY = Math.min(p0.y, p1.y)
  const maxY = Math.max(p0.y, p1.y)
  if (maxX < r.x || minX > r.x + r.w || maxY < r.y || minY > r.y + r.h) return false
  // Sample the segment.
  for (let t = 0; t <= 1; t += 0.05) {
    const x = p0.x + (p1.x - p0.x) * t
    const y = p0.y + (p1.y - p0.y) * t
    if (pointInRect({ x, y }, r)) return true
  }
  return false
}

export function parseSvgPathPoints(path: string): Array<{ x: number; y: number }> {
  const points: Array<{ x: number; y: number }> = []
  const re = /[ML]\s*([-\d.]+)\s+([-\d.]+)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(path))) {
    points.push({ x: Number(match[1]), y: Number(match[2]) })
  }
  return points
}
