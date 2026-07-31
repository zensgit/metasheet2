import type {
  ApprovalGraph,
  ConditionNodeConfig,
  FormSchema,
} from '../types/approval'
import type { ApprovalRoutePreviewNode } from './api'

export interface RoutePreviewConditionDecision {
  nodeKey: string
  nodeLabel: string
  matched: string
  skipped: string[]
}

export interface RoutePreviewHighlight {
  nodeKeys: Set<string>
  edgeKeys: Set<string>
  decisions: RoutePreviewConditionDecision[]
  complete: boolean
}

interface GraphPath {
  nodeKeys: string[]
  edgeKeys: string[]
}

function findUniquePath(graph: ApprovalGraph, source: string, target: string): GraphPath | null {
  if (source === target) return { nodeKeys: [source], edgeKeys: [] }
  const outgoing = new Map<string, typeof graph.edges>()
  for (const edge of graph.edges) {
    const edges = outgoing.get(edge.source) ?? []
    edges.push(edge)
    outgoing.set(edge.source, edges)
  }

  const paths: GraphPath[] = []
  const visit = (nodeKey: string, seen: Set<string>, nodeKeys: string[], edgeKeys: string[]) => {
    if (paths.length > 1) return
    for (const edge of outgoing.get(nodeKey) ?? []) {
      if (seen.has(edge.target)) continue
      const nextNodes = [...nodeKeys, edge.target]
      const nextEdges = [...edgeKeys, edge.key]
      if (edge.target === target) {
        paths.push({ nodeKeys: nextNodes, edgeKeys: nextEdges })
        continue
      }
      const nextSeen = new Set(seen)
      nextSeen.add(edge.target)
      visit(edge.target, nextSeen, nextNodes, nextEdges)
    }
  }

  visit(source, new Set([source]), [source], [])
  return paths.length === 1 ? paths[0]! : null
}

function fieldLabel(schema: FormSchema, fieldId: string): string {
  const label = schema.fields.find((field) => field.id === fieldId)?.label?.trim()
  return label || '未命名字段'
}

function valueLabel(value: unknown): string {
  if (value === undefined || value === null || value === '') return '空值'
  if (typeof value === 'boolean') return value ? '是' : '否'
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') return `「${value}」`
  if (Array.isArray(value)) return value.map(valueLabel).join('、')
  return '已配置值'
}

function conditionValueLabel(schema: FormSchema, fieldId: string, value: unknown): string {
  const field = schema.fields.find((candidate) => candidate.id === fieldId)
  if (!field) return '已配置值'
  if (field.type === 'user') {
    return Array.isArray(value) ? `已配置成员（${value.length}）` : '已配置成员'
  }
  if (field.type === 'select' || field.type === 'multi-select') {
    const values = Array.isArray(value) ? value : [value]
    if (values.length === 0 || values.every((entry) => entry === undefined || entry === null || entry === '')) {
      return '空值'
    }
    return values.map((entry) => {
      const option = field.options?.find((candidate) => candidate.value === entry)
      return option?.label?.trim() || '已配置选项'
    }).join('、')
  }
  if (field.type === 'attachment' || field.type === 'detail' || field.type === 'record-link') {
    return '已配置值'
  }
  return valueLabel(value)
}

function conditionBranchLabel(
  config: ConditionNodeConfig,
  edgeKey: string,
  schema: FormSchema,
): string {
  const branch = config.branches.find((candidate) => candidate.edgeKey === edgeKey)
  if (!branch) return config.defaultEdgeKey === edgeKey ? '默认分支' : '条件分支'
  if (branch.formula) return '公式条件'
  if (branch.rules.length === 0) return '条件分支'
  const joiner = branch.conjunction === 'or' ? ' 或 ' : ' 且 '
  return branch.rules.map((rule) => {
    const operator = {
      eq: '=',
      neq: '≠',
      gt: '>',
      gte: '≥',
      lt: '<',
      lte: '≤',
      in: '属于',
      isEmpty: '为空',
    }[rule.operator]
    return rule.operator === 'isEmpty'
      ? `${fieldLabel(schema, rule.fieldId)} 为空`
      : `${fieldLabel(schema, rule.fieldId)} ${operator} ${conditionValueLabel(schema, rule.fieldId, rule.value)}`
  }).join(joiner)
}

/**
 * Maps the route-preview response back onto the saved graph without re-evaluating any rule.
 * A segment is highlighted only when the response anchor has one unique graph path. Ambiguous
 * reconvergence stays node-only so the renderer never invents a branch decision.
 */
export function deriveRoutePreviewHighlight(
  graph: ApprovalGraph,
  route: ApprovalRoutePreviewNode[],
  truncated: boolean,
  schema: FormSchema,
): RoutePreviewHighlight {
  const graphNodeKeys = new Set(graph.nodes.map((node) => node.key))
  const nodeKeys = new Set<string>()
  const edgeKeys = new Set<string>()
  let complete = true
  const start = graph.nodes.find((node) => node.type === 'start')?.key
  const end = graph.nodes.find((node) => node.type === 'end')?.key

  if (start) nodeKeys.add(start)
  for (const item of route) {
    if (graphNodeKeys.has(item.nodeKey)) nodeKeys.add(item.nodeKey)
    else complete = false
  }

  if (start) {
    for (const item of route) {
      if (!graphNodeKeys.has(item.nodeKey)) continue
      const path = findUniquePath(graph, start, item.nodeKey)
      if (!path) {
        complete = false
        continue
      }
      path.nodeKeys.forEach((key) => nodeKeys.add(key))
      path.edgeKeys.forEach((key) => edgeKeys.add(key))
    }
  } else {
    complete = false
  }

  if (!truncated && end) {
    const source = route.length > 0 ? route[route.length - 1]!.nodeKey : start
    if (source && graphNodeKeys.has(source)) {
      const path = findUniquePath(graph, source, end)
      if (path) {
        path.nodeKeys.forEach((key) => nodeKeys.add(key))
        path.edgeKeys.forEach((key) => edgeKeys.add(key))
      } else {
        complete = false
      }
    }
  } else if (truncated) {
    complete = false
  }

  const decisions = graph.nodes.flatMap<RoutePreviewConditionDecision>((node) => {
    if (node.type !== 'condition' || !nodeKeys.has(node.key)) return []
    const outgoing = graph.edges.filter((edge) => edge.source === node.key)
    const matched = outgoing.filter((edge) => edgeKeys.has(edge.key))
    if (matched.length !== 1) return []
    const config = node.config as ConditionNodeConfig
    return [{
      nodeKey: node.key,
      nodeLabel: node.name?.trim() || '条件判断',
      matched: conditionBranchLabel(config, matched[0]!.key, schema),
      skipped: outgoing
        .filter((edge) => edge.key !== matched[0]!.key)
        .map((edge) => conditionBranchLabel(config, edge.key, schema)),
    }]
  })

  return { nodeKeys, edgeKeys, decisions, complete }
}
