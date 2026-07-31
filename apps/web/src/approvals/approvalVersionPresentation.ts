import type { ApprovalEdge, ApprovalGraph, ApprovalNode, FormField } from '../types/approval'

const APPROVAL_NODE_TYPE_LABELS: Readonly<Record<string, string>> = {
  start: '发起',
  approval: '审批',
  condition: '条件分支',
  parallel: '并行分支',
  cc: '抄送',
  end: '结束',
}

export function approvalNodeTypeLabel(type: string): string {
  return APPROVAL_NODE_TYPE_LABELS[type] ?? '流程节点'
}

export function approvalFieldDisplayLabel(field: FormField): string {
  return field.label?.trim() || '未命名字段'
}

export function approvalNodeDisplayLabel(node: ApprovalNode | undefined): string {
  if (!node) return '流程节点'
  return node.name?.trim() || approvalNodeTypeLabel(node.type)
}

export function approvalEdgeDisplayLabel(edge: ApprovalEdge, graph: ApprovalGraph): string {
  const nodes = new Map(graph.nodes.map((node) => [node.key, node]))
  return `${approvalNodeDisplayLabel(nodes.get(edge.source))} → ${approvalNodeDisplayLabel(nodes.get(edge.target))}`
}
