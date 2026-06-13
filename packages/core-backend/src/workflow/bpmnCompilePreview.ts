import { redactValue } from '../multitable/automation-log-redact'
import type { AutomationAction, AutomationActionType } from '../multitable/automation-actions'
import {
  normalizeConditionGroupInput,
  type AutomationCondition,
  type ConditionGroup,
} from '../multitable/automation-conditions'
import type { WorkflowDefinition } from './WorkflowDesigner'

export type BpmnCompilePreviewInput =
  | {
      mode: 'visual'
      workflowId?: string
      sourceVersion?: number
      visual: WorkflowDefinition
    }
  | {
      mode: 'bpmn_xml'
      workflowId?: string
      sourceVersion?: number
      bpmnXml: string
    }

export interface BpmnCompilePreviewMapping {
  bpmnElementId: string
  bpmnElementType: string
  target: 'automation' | 'approval' | 'structural'
  targetKind: string
}

export interface BpmnCompilePreviewGap {
  bpmnElementId: string
  bpmnElementType: string
  reason: string
  requiredRung?: 'A6-3-3' | 'A6-3-5' | 'W7' | 'public-webhook' | 'unsupported'
}

export interface BpmnCompilePreview {
  source: {
    workflowId?: string
    mode: 'visual' | 'bpmn_xml'
    sourceVersion?: number
  }
  supported: boolean
  automationPreview?: {
    actions: unknown[]
    requiresExecutionMode: 'workflow_job_v1'
  }
  approvalPreview?: {
    formSchema?: unknown
    approvalGraph?: unknown
    runtimeGraphPreview?: unknown
  }
  mappingReport: BpmnCompilePreviewMapping[]
  gapReport: BpmnCompilePreviewGap[]
  warnings: string[]
}

interface NormalizedNode {
  id: string
  type: string
  name?: string
  properties: Record<string, unknown>
}

interface NormalizedEdge {
  id: string
  source: string
  target: string
  label?: string
  condition?: string
  type?: string
}

interface NormalizedDefinition {
  nodes: NormalizedNode[]
  edges: NormalizedEdge[]
}

interface CompileState {
  actions: Array<{ sourceNodeId: string; action: AutomationAction }>
  approvalPreview: BpmnCompilePreview['approvalPreview']
  mappings: BpmnCompilePreviewMapping[]
  gaps: BpmnCompilePreviewGap[]
  warnings: string[]
  consumedNodes: Set<string>
  order: Map<string, number>
  source: BpmnCompilePreview['source']
}

interface Graph {
  nodes: Map<string, NormalizedNode>
  outgoing: Map<string, NormalizedEdge[]>
  incoming: Map<string, NormalizedEdge[]>
}

const STRUCTURAL_NODE_TYPES = new Set(['startEvent', 'endEvent'])
const CATCH_NODE_TYPES = new Set(['intermediateCatchEvent'])
const UNSUPPORTED_NODE_TYPES = new Set([
  'scriptTask',
  'inclusiveGateway',
  'eventBasedGateway',
  'boundaryEvent',
  'subProcess',
  'callActivity',
])

const SERVICE_ACTION_TYPES = new Set<AutomationActionType>([
  'update_record',
  'create_record',
  'send_webhook',
  'send_notification',
  'send_email',
  'send_dingtalk_group_message',
  'send_dingtalk_person_message',
  'lock_record',
  'wait_for_callback',
  'start_approval',
])

const CONDITION_BRANCH_PATH_ACTION_TYPES = new Set<AutomationActionType>([
  'update_record',
  'create_record',
  'send_webhook',
  'send_notification',
  'send_email',
  'send_dingtalk_group_message',
  'send_dingtalk_person_message',
  'lock_record',
])

const PARALLEL_BRANCH_PATH_ACTION_TYPES = new Set<AutomationActionType>([
  'update_record',
  'send_notification',
])

const XML_UNSUPPORTED_SCOPE_NODE_TYPES = new Set(['subProcess', 'callActivity'])

export function compileBpmnPreview(input: BpmnCompilePreviewInput): BpmnCompilePreview {
  const source = buildSource(input)
  const normalized = input.mode === 'visual'
    ? normalizeVisualDefinition(input.visual)
    : normalizeBpmnXml(input.bpmnXml)

  if ('gap' in normalized) {
    return finalizePreview({
      source,
      supported: false,
      automationPreview: {
        actions: [],
        requiresExecutionMode: 'workflow_job_v1',
      },
      mappingReport: [],
      gapReport: [normalized.gap],
      warnings: [],
    })
  }

  const graph = buildGraph(normalized)
  const state: CompileState = {
    actions: [],
    approvalPreview: undefined,
    mappings: [],
    gaps: [],
    warnings: [],
    consumedNodes: new Set(),
    order: buildNodeOrder(normalized, graph),
    source,
  }

  for (const node of sortedNodes(normalized.nodes)) {
    if (node.type === 'exclusiveGateway') {
      compileExclusiveGateway(node, graph, state)
    }
  }

  for (const node of sortedNodes(normalized.nodes)) {
    if (node.type === 'parallelGateway' && !state.consumedNodes.has(node.id)) {
      compileParallelGateway(node, graph, state)
    }
  }

  for (const node of sortedNodes(normalized.nodes)) {
    if (state.consumedNodes.has(node.id)) continue
    compileStandaloneNode(node, graph, state)
  }

  return finalizePreview({
    source,
    supported: state.gaps.length === 0,
    automationPreview: {
      actions: automationActionsFromState(state),
      requiresExecutionMode: 'workflow_job_v1',
    },
    ...(state.approvalPreview ? { approvalPreview: state.approvalPreview } : {}),
    mappingReport: state.mappings,
    gapReport: state.gaps,
    warnings: state.warnings,
  })
}

function buildSource(input: BpmnCompilePreviewInput): BpmnCompilePreview['source'] {
  return {
    mode: input.mode,
    ...(input.workflowId ? { workflowId: input.workflowId } : {}),
    ...(typeof input.sourceVersion === 'number' ? { sourceVersion: input.sourceVersion } : {}),
  }
}

function normalizeVisualDefinition(visual: WorkflowDefinition): NormalizedDefinition {
  return {
    nodes: visual.nodes.map((node) => ({
      id: node.id,
      type: node.type,
      name: node.name,
      properties: {
        ...(node.data.properties ?? {}),
        ...(node.data.formKey ? { formKey: node.data.formKey } : {}),
        ...(node.data.assignee ? { assignee: node.data.assignee } : {}),
        ...(node.data.candidateUsers ? { candidateUsers: node.data.candidateUsers } : {}),
        ...(node.data.candidateGroups ? { candidateGroups: node.data.candidateGroups } : {}),
        ...(node.data.serviceClass ? { serviceClass: node.data.serviceClass } : {}),
        ...(node.data.condition ? { condition: node.data.condition } : {}),
        ...(node.data.timerDefinition ? { timerDefinition: node.data.timerDefinition } : {}),
        ...(node.data.messageRef ? { messageRef: node.data.messageRef } : {}),
        ...(node.data.signalRef ? { signalRef: node.data.signalRef } : {}),
      },
    })),
    edges: visual.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      ...(edge.label ? { label: edge.label } : {}),
      ...(edge.condition ? { condition: edge.condition } : {}),
      ...(edge.type ? { type: edge.type } : {}),
    })),
  }
}

function normalizeBpmnXml(xml: string): NormalizedDefinition | { gap: BpmnCompilePreviewGap } {
  if (!isLikelyBalancedXml(xml)) {
    return {
      gap: {
        bpmnElementId: '__bpmn_xml__',
        bpmnElementType: 'bpmn_xml',
        reason: 'Invalid BPMN XML',
        requiredRung: 'unsupported',
      },
    }
  }

  const nodes = parseXmlNodes(xml)
  const edges = parseXmlSequenceFlows(xml)
  if (nodes.length === 0 && edges.length === 0) {
    return {
      gap: {
        bpmnElementId: '__bpmn_xml__',
        bpmnElementType: 'bpmn_xml',
        reason: 'Invalid BPMN XML',
        requiredRung: 'unsupported',
      },
    }
  }

  return { nodes, edges }
}

function parseXmlNodes(xml: string): NormalizedNode[] {
  const nodeTypes = [
    'startEvent',
    'endEvent',
    'serviceTask',
    'userTask',
    'scriptTask',
    'exclusiveGateway',
    'parallelGateway',
    'intermediateCatchEvent',
    'inclusiveGateway',
    'eventBasedGateway',
    'boundaryEvent',
    'subProcess',
    'callActivity',
  ]
  const unsupportedRanges = findUnsupportedXmlScopeRanges(xml)
  const out: NormalizedNode[] = []
  const seen = new Set<string>()

  for (const type of nodeTypes) {
    const paired = new RegExp(`<(?:[A-Za-z_][\\w.-]*:)?${type}\\b([^>]*)>([\\s\\S]*?)<\\/(?:[A-Za-z_][\\w.-]*:)?${type}>`, 'g')
    const selfClosing = new RegExp(`<(?:[A-Za-z_][\\w.-]*:)?${type}\\b([^>]*)\\/>`, 'g')
    for (const match of xml.matchAll(paired)) {
      if (!XML_UNSUPPORTED_SCOPE_NODE_TYPES.has(type) && isIndexInsideRange(match.index ?? -1, unsupportedRanges)) continue
      const node = nodeFromXmlMatch(type, match[1] ?? '', match[2] ?? '')
      if (node && !seen.has(node.id)) {
        seen.add(node.id)
        out.push(node)
      }
    }
    for (const match of xml.matchAll(selfClosing)) {
      if (!XML_UNSUPPORTED_SCOPE_NODE_TYPES.has(type) && isIndexInsideRange(match.index ?? -1, unsupportedRanges)) continue
      const node = nodeFromXmlMatch(type, match[1] ?? '', '')
      if (node && !seen.has(node.id)) {
        seen.add(node.id)
        out.push(node)
      }
    }
  }

  return out
}

function findUnsupportedXmlScopeRanges(xml: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = []
  for (const type of XML_UNSUPPORTED_SCOPE_NODE_TYPES) {
    const paired = new RegExp(`<(?:[A-Za-z_][\\w.-]*:)?${type}\\b[^>]*>[\\s\\S]*?<\\/(?:[A-Za-z_][\\w.-]*:)?${type}>`, 'g')
    for (const match of xml.matchAll(paired)) {
      ranges.push({ start: match.index ?? 0, end: (match.index ?? 0) + (match[0]?.length ?? 0) })
    }
  }
  return ranges
}

function isIndexInsideRange(index: number, ranges: Array<{ start: number; end: number }>): boolean {
  return index >= 0 && ranges.some((range) => index > range.start && index < range.end)
}

function nodeFromXmlMatch(type: string, attrText: string, body: string): NormalizedNode | null {
  const attrs = parseXmlAttributes(attrText)
  const id = stringValue(attrs.id)
  if (!id) return null
  const properties: Record<string, unknown> = { ...attrs }
  if (typeof attrs.config === 'string') {
    const parsed = parseJsonRecord(attrs.config)
    if (parsed) properties.config = parsed
  }
  if (typeof attrs.automationConfig === 'string') {
    const parsed = parseJsonRecord(attrs.automationConfig)
    if (parsed) properties.automationConfig = parsed
  }
  if (typeof attrs.approvalPreview === 'string') {
    const parsed = parseJsonRecord(attrs.approvalPreview)
    if (parsed) properties.approvalPreview = parsed
  }
  if (body.includes('messageEventDefinition')) properties.messageRef = stringValue(attrs.messageRef) ?? 'message'
  if (body.includes('signalEventDefinition')) properties.signalRef = stringValue(attrs.signalRef) ?? 'signal'
  if (body.includes('timerEventDefinition')) properties.timerDefinition = true
  return {
    id,
    type,
    name: stringValue(attrs.name),
    properties,
  }
}

function parseXmlSequenceFlows(xml: string): NormalizedEdge[] {
  const edges: NormalizedEdge[] = []
  const paired = /<(?:[A-Za-z_][\w.-]*:)?sequenceFlow\b([^>]*)>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?sequenceFlow>/g
  const selfClosing = /<(?:[A-Za-z_][\w.-]*:)?sequenceFlow\b([^>]*)\/>/g

  for (const match of xml.matchAll(paired)) {
    const edge = edgeFromXmlMatch(match[1] ?? '', match[2] ?? '')
    if (edge) edges.push(edge)
  }
  for (const match of xml.matchAll(selfClosing)) {
    const edge = edgeFromXmlMatch(match[1] ?? '', '')
    if (edge) edges.push(edge)
  }

  return edges
}

function edgeFromXmlMatch(attrText: string, body: string): NormalizedEdge | null {
  const attrs = parseXmlAttributes(attrText)
  const id = stringValue(attrs.id)
  const source = stringValue(attrs.sourceRef)
  const target = stringValue(attrs.targetRef)
  if (!id || !source || !target) return null
  const condition = extractConditionExpression(body) ?? stringValue(attrs.condition)
  return {
    id,
    source,
    target,
    ...(stringValue(attrs.name) ? { label: stringValue(attrs.name) } : {}),
    ...(condition ? { condition } : {}),
    ...(attrs.isDefault === 'true' || attrs.default === 'true' ? { type: 'default' } : {}),
  }
}

function parseXmlAttributes(attrText: string): Record<string, unknown> {
  const attrs: Record<string, unknown> = {}
  const attrPattern = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
  for (const match of attrText.matchAll(attrPattern)) {
    const key = localName(match[1] ?? '')
    attrs[key] = decodeXmlEntities(match[2] ?? match[3] ?? '')
  }
  return attrs
}

function extractConditionExpression(body: string): string | null {
  const match = body.match(/<(?:[A-Za-z_][\w.-]*:)?conditionExpression\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?conditionExpression>/)
  if (!match) return null
  return decodeXmlEntities(stripXmlTags(match[1] ?? '').trim())
}

function buildGraph(definition: NormalizedDefinition): Graph {
  const nodes = new Map(definition.nodes.map((node) => [node.id, node]))
  const outgoing = new Map<string, NormalizedEdge[]>()
  const incoming = new Map<string, NormalizedEdge[]>()
  for (const edge of definition.edges) {
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge])
    incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), edge])
  }
  for (const [key, edges] of outgoing) outgoing.set(key, sortEdges(edges))
  for (const [key, edges] of incoming) incoming.set(key, sortEdges(edges))
  return { nodes, outgoing, incoming }
}

function compileStandaloneNode(node: NormalizedNode, graph: Graph, state: CompileState): void {
  if (STRUCTURAL_NODE_TYPES.has(node.type)) {
    addMapping(state, node, 'structural', node.type)
    state.consumedNodes.add(node.id)
    return
  }
  if (node.type === 'serviceTask') {
    const action = automationActionFromServiceTask(node)
    if (!action) {
      addGap(state, node, 'Service task does not declare a supported automation action shape', 'unsupported')
      return
    }
    state.actions.push({ sourceNodeId: node.id, action })
    addMapping(state, node, 'automation', action.type)
    state.consumedNodes.add(node.id)
    return
  }
  if (node.type === 'userTask') {
    const preview = approvalPreviewFromUserTask(node)
    if (!preview) {
      addGap(state, node, 'User task does not declare a supported approval preview shape', 'unsupported')
      return
    }
    state.approvalPreview = mergeApprovalPreview(state.approvalPreview, preview)
    addMapping(state, node, 'approval', 'user_task')
    state.consumedNodes.add(node.id)
    return
  }
  if (CATCH_NODE_TYPES.has(node.type)) {
    addCatchEventGap(state, node)
    return
  }
  if (UNSUPPORTED_NODE_TYPES.has(node.type)) {
    addGap(state, node, `Unsupported BPMN element${node.name ? `: ${node.name}` : ''}`, 'unsupported')
    if (isGatewayNodeType(node.type)) consumeGatewaySubgraph(node, graph, state)
    return
  }
  if (node.type === 'exclusiveGateway' || node.type === 'parallelGateway') {
    addGap(state, node, `${node.type} is not representable by the A6-4a conservative mapping`, 'unsupported')
    consumeGatewaySubgraph(node, graph, state)
    return
  }
  addGap(state, node, `Unsupported BPMN element type: ${node.type}`, 'unsupported')
}

function compileExclusiveGateway(node: NormalizedNode, graph: Graph, state: CompileState): void {
  const outgoing = graph.outgoing.get(node.id) ?? []
  if (outgoing.length < 2) return

  const defaultEdge = findDefaultEdge(node, outgoing)
  if (!defaultEdge) {
    addGap(state, node, 'Exclusive gateway requires one default path to map to condition_branch', 'unsupported')
    consumeGatewaySubgraph(node, graph, state)
    return
  }

  const branches: Array<{
    key: string
    label?: string
    conditions: ConditionGroup
    actions: AutomationAction[]
  }> = []
  const branchKeys = new Set<string>()
  const consumedInGateway = new Set<string>([node.id])

  for (const edge of outgoing) {
    if (edge.id === defaultEdge.id) continue
    const condition = conditionGroupFromEdge(edge)
    if (!condition) {
      addGap(state, node, `Exclusive gateway path ${edge.id} has no representable condition`, 'unsupported')
      consumeGatewaySubgraph(node, graph, state)
      return
    }
    const path = compileLinearAutomationPath(edge.target, null, graph, CONDITION_BRANCH_PATH_ACTION_TYPES)
    if (path.ok === false) {
      addGap(state, node, `Exclusive gateway path ${edge.id} is not representable: ${path.reason}`, path.requiredRung)
      consumeGatewaySubgraph(node, graph, state)
      return
    }
    path.consumedNodeIds.forEach((id) => consumedInGateway.add(id))
    const key = uniqueBranchKey(edge.target, branchKeys)
    branches.push({
      key,
      ...(edge.label ? { label: edge.label } : {}),
      conditions: condition,
      actions: path.actions,
    })
  }

  const defaultPath = compileLinearAutomationPath(defaultEdge.target, null, graph, CONDITION_BRANCH_PATH_ACTION_TYPES)
  if (defaultPath.ok === false) {
    addGap(state, node, `Exclusive gateway default path is not representable: ${defaultPath.reason}`, defaultPath.requiredRung)
    consumeGatewaySubgraph(node, graph, state)
    return
  }
  defaultPath.consumedNodeIds.forEach((id) => consumedInGateway.add(id))

  const defaultBranchKey = uniqueBranchKey(`default_${defaultEdge.target}`, branchKeys)
  state.actions.push({
    sourceNodeId: node.id,
    action: {
      type: 'condition_branch',
      config: {
        branches,
        defaultBranch: {
          key: defaultBranchKey,
          ...(defaultEdge.label ? { label: defaultEdge.label } : {}),
          actions: defaultPath.actions,
        },
      },
    },
  })
  addMapping(state, node, 'automation', 'condition_branch')
  for (const id of consumedInGateway) state.consumedNodes.add(id)
}

function compileParallelGateway(node: NormalizedNode, graph: Graph, state: CompileState): void {
  const outgoing = graph.outgoing.get(node.id) ?? []
  const incoming = graph.incoming.get(node.id) ?? []
  if (outgoing.length < 2) return
  if (incoming.length > 1) return

  const branchKeys = new Set<string>()
  const branches: Array<{ key: string; label?: string; actions: AutomationAction[] }> = []
  const consumedInGateway = new Set<string>([node.id])
  let joinId: string | null = null

  for (const edge of outgoing) {
    const path = compilePathToParallelJoin(edge.target, graph)
    if (path.ok === false) {
      addGap(state, node, `Parallel gateway branch ${edge.id} is not representable: ${path.reason}`, path.requiredRung)
      consumeGatewaySubgraph(node, graph, state)
      return
    }
    if (!joinId) {
      joinId = path.joinId
    } else if (joinId !== path.joinId) {
      addGap(state, node, 'Parallel gateway branches do not converge on the same join', 'unsupported')
      consumeGatewaySubgraph(node, graph, state)
      return
    }
    path.consumedNodeIds.forEach((id) => consumedInGateway.add(id))
    const key = uniqueBranchKey(edge.target, branchKeys)
    branches.push({
      key,
      ...(edge.label ? { label: edge.label } : {}),
      actions: path.actions,
    })
  }

  if (!joinId || branches.length < 2) {
    addGap(state, node, 'Parallel gateway requires at least two branches and a matching join', 'unsupported')
    consumeGatewaySubgraph(node, graph, state)
    return
  }

  const join = graph.nodes.get(joinId)
  if (join) {
    addMapping(state, join, 'structural', 'parallel_join')
    consumedInGateway.add(join.id)
  }

  state.actions.push({
    sourceNodeId: node.id,
    action: {
      type: 'parallel_branch',
      config: {
        joinMode: 'all',
        branches,
      },
    },
  })
  addMapping(state, node, 'automation', 'parallel_branch')
  for (const id of consumedInGateway) state.consumedNodes.add(id)
}

function consumeGatewaySubgraph(node: NormalizedNode, graph: Graph, state: CompileState): void {
  const stack = [node.id]
  const seen = new Set<string>()
  while (stack.length > 0) {
    const currentId = stack.pop()
    if (!currentId || seen.has(currentId)) continue
    seen.add(currentId)
    state.consumedNodes.add(currentId)
    const current = graph.nodes.get(currentId)
    if (current && current.id !== node.id) addSubgraphGapIfNeeded(state, current, graph)
    for (const edge of graph.outgoing.get(currentId) ?? []) {
      stack.push(edge.target)
    }
  }
}

function addSubgraphGapIfNeeded(state: CompileState, node: NormalizedNode, graph: Graph): void {
  if (STRUCTURAL_NODE_TYPES.has(node.type) || node.type === 'serviceTask') return
  if (node.type === 'userTask' && approvalPreviewFromUserTask(node)) return
  if (CATCH_NODE_TYPES.has(node.type)) {
    addCatchEventGap(state, node)
    return
  }
  if (UNSUPPORTED_NODE_TYPES.has(node.type)) {
    addGap(state, node, `Unsupported BPMN element${node.name ? `: ${node.name}` : ''}`, 'unsupported')
    return
  }
  if (node.type === 'exclusiveGateway' || node.type === 'parallelGateway') {
    if (node.type === 'parallelGateway' && (graph.incoming.get(node.id) ?? []).length > 1) return
    addGap(state, node, `${node.type} is not representable inside a failed gateway subgraph`, 'unsupported')
    return
  }
  addGap(state, node, `Unsupported BPMN element type: ${node.type}`, 'unsupported')
}

function compileLinearAutomationPath(
  startNodeId: string,
  stopNodeId: string | null,
  graph: Graph,
  allowedActionTypes: Set<AutomationActionType>,
): { ok: true; actions: AutomationAction[]; consumedNodeIds: string[] } | { ok: false; reason: string; requiredRung: BpmnCompilePreviewGap['requiredRung'] } {
  const actions: AutomationAction[] = []
  const consumedNodeIds: string[] = []
  const seen = new Set<string>()
  let currentId: string | null = startNodeId

  while (currentId) {
    if (stopNodeId && currentId === stopNodeId) return { ok: true, actions, consumedNodeIds }
    if (seen.has(currentId)) return { ok: false, reason: `cycle at ${currentId}`, requiredRung: 'unsupported' }
    seen.add(currentId)

    const node = graph.nodes.get(currentId)
    if (!node) return { ok: false, reason: `missing node ${currentId}`, requiredRung: 'unsupported' }
    if (node.type === 'endEvent') {
      consumedNodeIds.push(node.id)
      return { ok: true, actions, consumedNodeIds }
    }
    if (node.type !== 'serviceTask') {
      return {
        ok: false,
        reason: `${node.type} is not a supported automation path node`,
        requiredRung: node.type === 'intermediateCatchEvent' ? catchEventRung(node) : 'unsupported',
      }
    }

    const action = automationActionFromServiceTask(node)
    if (!action) return { ok: false, reason: `service task ${node.id} has no supported action config`, requiredRung: 'unsupported' }
    if (!allowedActionTypes.has(action.type)) {
      return { ok: false, reason: `service task ${node.id} action ${action.type} is not supported in this branch context`, requiredRung: 'unsupported' }
    }
    actions.push(action)
    consumedNodeIds.push(node.id)

    const outgoing = graph.outgoing.get(node.id) ?? []
    if (outgoing.length === 0) return { ok: true, actions, consumedNodeIds }
    if (outgoing.length > 1) return { ok: false, reason: `service task ${node.id} has multiple outgoing paths`, requiredRung: 'unsupported' }
    currentId = outgoing[0]?.target ?? null
  }

  return { ok: true, actions, consumedNodeIds }
}

function compilePathToParallelJoin(
  startNodeId: string,
  graph: Graph,
): { ok: true; joinId: string; actions: AutomationAction[]; consumedNodeIds: string[] } | { ok: false; reason: string; requiredRung: BpmnCompilePreviewGap['requiredRung'] } {
  const actions: AutomationAction[] = []
  const consumedNodeIds: string[] = []
  const seen = new Set<string>()
  let currentId: string | null = startNodeId

  while (currentId) {
    if (seen.has(currentId)) return { ok: false, reason: `cycle at ${currentId}`, requiredRung: 'unsupported' }
    seen.add(currentId)

    const node = graph.nodes.get(currentId)
    if (!node) return { ok: false, reason: `missing node ${currentId}`, requiredRung: 'unsupported' }
    if (node.type === 'parallelGateway') {
      const incoming = graph.incoming.get(node.id) ?? []
      if (incoming.length < 2) return { ok: false, reason: `parallel gateway ${node.id} is not a join`, requiredRung: 'unsupported' }
      if (actions.length === 0) return { ok: false, reason: 'parallel branch must contain at least one action', requiredRung: 'unsupported' }
      return { ok: true, joinId: node.id, actions, consumedNodeIds }
    }
    if (node.type !== 'serviceTask') {
      return {
        ok: false,
        reason: `${node.type} is not a supported parallel branch node`,
        requiredRung: node.type === 'intermediateCatchEvent' ? catchEventRung(node) : 'unsupported',
      }
    }
    const action = automationActionFromServiceTask(node)
    if (!action) return { ok: false, reason: `service task ${node.id} has no supported action config`, requiredRung: 'unsupported' }
    if (!PARALLEL_BRANCH_PATH_ACTION_TYPES.has(action.type)) {
      return { ok: false, reason: `service task ${node.id} action ${action.type} is not supported in parallel_branch`, requiredRung: 'unsupported' }
    }
    actions.push(action)
    consumedNodeIds.push(node.id)

    const outgoing = graph.outgoing.get(node.id) ?? []
    if (outgoing.length !== 1) return { ok: false, reason: `service task ${node.id} must lead to one join path`, requiredRung: 'unsupported' }
    currentId = outgoing[0]?.target ?? null
  }

  return { ok: false, reason: 'branch did not reach a parallel join', requiredRung: 'unsupported' }
}

function isGatewayNodeType(type: string): boolean {
  return type === 'exclusiveGateway'
    || type === 'parallelGateway'
    || type === 'inclusiveGateway'
    || type === 'eventBasedGateway'
}

function automationActionFromServiceTask(node: NormalizedNode): AutomationAction | null {
  const direct = node.properties.automationAction
  if (isRecord(direct)) {
    return actionFromTypeAndConfig(direct.type, direct.config)
  }
  const nested = node.properties.action
  if (isRecord(nested)) {
    return actionFromTypeAndConfig(nested.type, nested.config)
  }
  return actionFromTypeAndConfig(
    node.properties.actionType ?? node.properties.automationActionType ?? node.properties.type,
    node.properties.automationConfig ?? node.properties.config,
  )
}

function actionFromTypeAndConfig(typeValue: unknown, configValue: unknown): AutomationAction | null {
  if (typeof typeValue !== 'string') return null
  if (!SERVICE_ACTION_TYPES.has(typeValue as AutomationActionType)) return null
  if (!isRecord(configValue)) return null
  if (!automationActionConfigIsSupported(typeValue as AutomationActionType, configValue)) return null
  return {
    type: typeValue as AutomationActionType,
    config: { ...configValue },
  }
}

function automationActionConfigIsSupported(type: AutomationActionType, config: Record<string, unknown>): boolean {
  switch (type) {
    case 'update_record':
      return isRecord(config.fields)
    case 'create_record':
      return Boolean(stringValue(config.sheetId)) && isRecord(config.data)
    case 'send_webhook':
      return Boolean(stringValue(config.url))
    case 'send_notification':
      return stringArray(config.userIds).length > 0 && Boolean(stringValue(config.message))
    case 'send_email':
      return stringArray(config.recipients).length > 0
        && Boolean(stringValue(config.subjectTemplate))
        && Boolean(stringValue(config.bodyTemplate))
    case 'send_dingtalk_group_message':
      return Boolean(stringValue(config.titleTemplate)) && Boolean(stringValue(config.bodyTemplate))
    case 'send_dingtalk_person_message':
      return stringArray(config.userIds).length > 0
        && Boolean(stringValue(config.titleTemplate))
        && Boolean(stringValue(config.bodyTemplate))
    case 'lock_record':
      return typeof config.locked === 'boolean'
    case 'wait_for_callback':
      return config.reason === undefined || config.reason === 'external_event'
    case 'start_approval':
      return Boolean(stringValue(config.templateId))
        && nonEmptyStringRecord(config.formDataMapping)
        && requesterConfigIsSupported(config.requester)
    case 'condition_branch':
    case 'parallel_branch':
      return false
    default:
      return false
  }
}

function approvalPreviewFromUserTask(node: NormalizedNode): BpmnCompilePreview['approvalPreview'] | null {
  const direct = node.properties.approvalPreview
  if (isSupportedApprovalPreview(direct)) return { ...direct }
  const formSchema = node.properties.formSchema
  const approvalGraph = node.properties.approvalGraph
  const runtimeGraphPreview = node.properties.runtimeGraphPreview
  const candidate = {
    ...(formSchema ? { formSchema } : {}),
    ...(approvalGraph ? { approvalGraph } : {}),
    ...(runtimeGraphPreview ? { runtimeGraphPreview } : {}),
  }
  if (isSupportedApprovalPreview(candidate)) {
    return {
      ...candidate,
    }
  }
  return null
}

function isSupportedApprovalPreview(value: unknown): value is BpmnCompilePreview['approvalPreview'] {
  if (!isRecord(value)) return false
  const approvalGraph = value.approvalGraph
  const runtimeGraphPreview = value.runtimeGraphPreview
  if (!graphLike(approvalGraph) && !graphLike(runtimeGraphPreview)) return false
  if (value.formSchema !== undefined && !isRecord(value.formSchema) && !Array.isArray(value.formSchema)) return false
  return true
}

function graphLike(value: unknown): boolean {
  if (!isRecord(value)) return false
  return isRecord(value.nodes) || Array.isArray(value.nodes)
}

function mergeApprovalPreview(
  current: BpmnCompilePreview['approvalPreview'],
  next: BpmnCompilePreview['approvalPreview'],
): BpmnCompilePreview['approvalPreview'] {
  return {
    ...(current ?? {}),
    ...(next ?? {}),
  }
}

function findDefaultEdge(node: NormalizedNode, outgoing: NormalizedEdge[]): NormalizedEdge | null {
  const defaultFlow = stringValue(node.properties.defaultFlow) ?? stringValue(node.properties.default)
  const byAttr = defaultFlow ? outgoing.find((edge) => edge.id === defaultFlow || edge.target === defaultFlow) : undefined
  if (byAttr) return byAttr
  const defaults = outgoing.filter((edge) => edge.type === 'default')
  return defaults.length === 1 ? defaults[0] ?? null : null
}

function conditionGroupFromEdge(edge: NormalizedEdge): ConditionGroup | null {
  const raw = edge.condition ?? edge.label
  if (!raw) return null

  const parsedJson = parseJsonValue(raw)
  if (parsedJson !== undefined) {
    const normalized = normalizeConditionInput(parsedJson)
    if (normalized) return normalized
  }

  const parsedExpression = parseSimpleConditionExpression(raw)
  return parsedExpression ? { conjunction: 'AND', conditions: [parsedExpression] } : null
}

function normalizeConditionInput(value: unknown): ConditionGroup | null {
  try {
    if (isConditionGroup(value)) return normalizeConditionGroupInput(value)
    if (isAutomationCondition(value)) return normalizeConditionGroupInput({ conjunction: 'AND', conditions: [value] })
    return null
  } catch {
    return null
  }
}

function parseSimpleConditionExpression(raw: string): AutomationCondition | null {
  const trimmed = raw.trim().replace(/^\$\{\s*/, '').replace(/\s*\}$/, '')
  const match = trimmed.match(/^([A-Za-z_][\w.-]*)\s*(===|==|!==|!=|>=|<=|>|<)\s*(.+)$/)
  if (!match) return null
  const fieldId = match[1]
  const op = match[2]
  const value = parseConditionLiteral(match[3] ?? '')
  const operator = op === '===' || op === '==' ? 'equals'
    : op === '!==' || op === '!=' ? 'not_equals'
      : op === '>' ? 'greater_than'
        : op === '<' ? 'less_than'
          : op === '>=' ? 'greater_or_equal'
            : 'less_or_equal'
  return { fieldId, operator, value }
}

function parseConditionLiteral(raw: string): unknown {
  const value = raw.trim()
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }
  if (value === 'true') return true
  if (value === 'false') return false
  if (value === 'null') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : value
}

function isAutomationCondition(value: unknown): value is AutomationCondition {
  return isRecord(value) && typeof value.fieldId === 'string' && typeof value.operator === 'string'
}

function isConditionGroup(value: unknown): value is ConditionGroup {
  return isRecord(value) && Array.isArray(value.conditions)
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
}

function nonEmptyStringRecord(value: unknown): boolean {
  if (!isRecord(value)) return false
  const entries = Object.entries(value)
  return entries.length > 0 && entries.every(([key, entry]) => key.trim().length > 0 && typeof entry === 'string' && entry.trim().length > 0)
}

function requesterConfigIsSupported(value: unknown): boolean {
  if (value === undefined) return true
  if (!isRecord(value)) return false
  return value.mode === undefined || value.mode === 'trigger_actor' || value.mode === 'rule_creator'
}

function addCatchEventGap(state: CompileState, node: NormalizedNode): void {
  addGap(state, node, `${node.type} requires a separately scoped resume trigger`, catchEventRung(node))
}

function catchEventRung(node: NormalizedNode): BpmnCompilePreviewGap['requiredRung'] {
  if (node.properties.messageRef || node.properties.signalRef) return 'public-webhook'
  if (node.properties.timerDefinition) return 'unsupported'
  return 'public-webhook'
}

function addMapping(
  state: CompileState,
  node: NormalizedNode,
  target: BpmnCompilePreviewMapping['target'],
  targetKind: string,
): void {
  state.mappings.push({
    bpmnElementId: node.id,
    bpmnElementType: node.type,
    target,
    targetKind,
  })
}

function addGap(
  state: CompileState,
  node: NormalizedNode,
  reason: string,
  requiredRung: BpmnCompilePreviewGap['requiredRung'],
): void {
  state.gaps.push({
    bpmnElementId: node.id,
    bpmnElementType: node.type,
    reason,
    ...(requiredRung ? { requiredRung } : {}),
  })
}

function finalizePreview(preview: BpmnCompilePreview): BpmnCompilePreview {
  const sorted: BpmnCompilePreview = {
    ...preview,
    supported: preview.gapReport.length === 0,
    mappingReport: [...preview.mappingReport].sort(compareMapping),
    gapReport: [...preview.gapReport].sort(compareGap),
    warnings: [...preview.warnings].sort(),
  }
  return redactValue(sorted) as BpmnCompilePreview
}

function automationActionsFromState(state: CompileState): AutomationAction[] {
  return [...state.actions]
    .sort((a, b) => orderForNode(state, a.sourceNodeId) - orderForNode(state, b.sourceNodeId)
      || a.sourceNodeId.localeCompare(b.sourceNodeId)
      || a.action.type.localeCompare(b.action.type))
    .map((entry) => entry.action)
}

function orderForNode(state: CompileState, nodeId: string): number {
  return state.order.get(nodeId) ?? Number.MAX_SAFE_INTEGER
}

function buildNodeOrder(definition: NormalizedDefinition, graph: Graph): Map<string, number> {
  const order = new Map<string, number>()
  const queue = sortedNodes(definition.nodes)
    .filter((node) => node.type === 'startEvent')
    .map((node) => node.id)
  if (queue.length === 0) {
    queue.push(...sortedNodes(definition.nodes).map((node) => node.id))
  }
  let index = 0
  while (queue.length > 0) {
    const id = queue.shift()
    if (!id || order.has(id)) continue
    order.set(id, index)
    index += 1
    for (const edge of graph.outgoing.get(id) ?? []) {
      if (!order.has(edge.target)) queue.push(edge.target)
    }
  }
  for (const node of sortedNodes(definition.nodes)) {
    if (!order.has(node.id)) {
      order.set(node.id, index)
      index += 1
    }
  }
  return order
}

function compareMapping(a: BpmnCompilePreviewMapping, b: BpmnCompilePreviewMapping): number {
  return a.bpmnElementId.localeCompare(b.bpmnElementId)
    || a.target.localeCompare(b.target)
    || a.targetKind.localeCompare(b.targetKind)
}

function compareGap(a: BpmnCompilePreviewGap, b: BpmnCompilePreviewGap): number {
  return a.bpmnElementId.localeCompare(b.bpmnElementId)
    || a.bpmnElementType.localeCompare(b.bpmnElementType)
    || a.reason.localeCompare(b.reason)
}

function sortedNodes(nodes: NormalizedNode[]): NormalizedNode[] {
  return [...nodes].sort((a, b) => a.id.localeCompare(b.id))
}

function sortEdges(edges: NormalizedEdge[]): NormalizedEdge[] {
  return [...edges].sort((a, b) => a.id.localeCompare(b.id))
}

function uniqueBranchKey(seed: string, seen: Set<string>): string {
  const base = stableBranchKey(seed)
  let key = base
  let counter = 2
  while (seen.has(key)) {
    const suffix = `_${counter}`
    key = `${base.slice(0, Math.max(1, 64 - suffix.length))}${suffix}`
    counter += 1
  }
  seen.add(key)
  return key
}

function stableBranchKey(seed: string): string {
  const key = seed.trim().replace(/[^A-Za-z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '')
  return (key || 'branch').slice(0, 64)
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function parseJsonRecord(raw: string): Record<string, unknown> | null {
  const parsed = parseJsonValue(raw)
  return isRecord(parsed) ? parsed : null
}

function parseJsonValue(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

function localName(name: string): string {
  return name.includes(':') ? name.split(':').pop() ?? name : name
}

function stripXmlTags(value: string): string {
  return value.replace(/<[^>]+>/g, '')
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function isLikelyBalancedXml(xml: string): boolean {
  if (!xml.includes('<')) return false
  const stack: string[] = []
  const cleaned = xml
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '')
    .replace(/<\?[\s\S]*?\?>/g, '')
  const tagPattern = /<\/?([A-Za-z_][\w.-]*:)?([A-Za-z_][\w.-]*)(?:\s[^<>]*)?>/g
  for (const match of cleaned.matchAll(tagPattern)) {
    const full = match[0] ?? ''
    if (full.startsWith('<!')) continue
    const tag = `${match[1] ?? ''}${match[2] ?? ''}`
    if (full.endsWith('/>')) continue
    if (full.startsWith('</')) {
      if (stack.pop() !== tag) return false
    } else {
      stack.push(tag)
    }
  }
  return stack.length === 0
}
