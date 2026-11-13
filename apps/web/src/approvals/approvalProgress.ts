import type {
  ApprovalGraph,
  ApprovalNode,
  ApprovalNodeConfig,
  FormSchema,
  HandlerNodeConfig,
  ParallelNodeConfig,
  UnifiedApprovalHistoryDTO,
} from '../types/approval'
import { nodeAssigneeSourceSummary } from './assigneeSource'
import { buildUpcomingNodes } from './upcomingNodes'

/**
 * 流程进度 (process progress) for the approval detail page: one row per step, in order —
 * start, the steps already done, the step(s) open now, then the steps still ahead.
 *
 * Front-end only. It reads what the detail page already holds: the history rows (each carries the
 * node it was written at, `metadata.nodeKey`), the current node key(s) and seats, and the template
 * graph the page already loaded. No new request.
 *
 *   - Done: history rows grouped by node, in the order the nodes were first reached. A node's
 *     result is its last decision (approve / reject / return / handle); the people are the actors
 *     of those decision rows, as the timeline names them. CC, comment, remind, revoke and sign rows
 *     never form a step and name no handler: a withdrawal is stated by the end row, and `sign` rows
 *     are written by the engine (seats cancelled after another seat decided, a skipped
 *     auto-approval notice), not by a person deciding. A node reached twice (after a return) shows
 *     once.
 *   - Current: one row per open node; the people are the page's own current-seat labels (role
 *     seats and the cancel-round wording included), passed in by the view.
 *   - Ahead: the same forward walk the timeline's upcoming list uses (`buildUpcomingNodes`). It
 *     stops at a condition node ("by condition", never a guessed branch) and at a parallel
 *     fan-out. Inside a parallel region the walk resumes from the region's join node when a
 *     parallel node encloses every open branch (the innermost one when nested; none when two
 *     enclose them equally). Nodes still ahead inside a branch are not listed. Every row ahead is
 *     marked expected. Its people are user names only when the caller passes `expectedUserName`
 *     (the view does so only for the instance's own frozen version) and EVERY configured user
 *     resolves; otherwise the existing count-only source summary. Never an id.
 *
 * Known limits (also stated in the PR): an ordinary member's page walks the live template; nothing
 * past a condition node is shown; dynamic sources (manager, department head, ...) show their kind
 * only; only the loaded history page is read.
 *
 * This module carries no user-facing literal: every word comes from `labels` (the detail page's
 * label table), so it holds in both locales.
 */

export type ApprovalProgressState = 'start' | 'done' | 'current' | 'expected' | 'branch' | 'parallel' | 'end'

export interface ApprovalProgressStep {
  key: string
  state: ApprovalProgressState
  name: string
  stateLabel: string
  /** Done: the last decision's label. Concluded end: the instance status label. */
  outcome: string
  /** Already prefixed and joined, e.g. the handler line. Empty when there is nothing to name. */
  people: string
  /** ISO timestamp for start / done / concluded end; the view formats it. */
  at: string | null
  /** Current: wait / mode. Branch and parallel: the honest summary of what follows. */
  note: string
}

export interface ApprovalProgressLabels {
  progressStartNode: string
  progressStateStarted: string
  progressStateDone: string
  progressStateCurrent: string
  progressStateExpected: string
  progressStateBranch: string
  progressStateParallel: string
  progressStateEnded: string
  progressEndNode: string
  progressRequester: string
  progressHandledBy: string
  progressCurrentHandler: string
  progressExpectedHandler: string
  progressParallelNext: string
  progressListSeparator: string
}

export interface ApprovalProgressInput {
  status: string
  requesterName: string
  createdAt: string | null
  updatedAt: string | null
  history: readonly UnifiedApprovalHistoryDTO[]
  graph: ApprovalGraph | null
  formSchema: FormSchema | null
  /** Every node with an open seat right now (parallel branches included). */
  currentNodeKeys: readonly string[]
  inParallelRegion: boolean
  /** Cancel round: no person is named anywhere in the progress. */
  namesWithheld: boolean
  isZh: boolean
  labels: ApprovalProgressLabels
  /** Fallback node name when the graph does not name the node. Must not return the node key. */
  nodeName: (nodeKey: string) => string
  actorName: (row: UnifiedApprovalHistoryDTO) => string
  actionLabel: (row: UnifiedApprovalHistoryDTO) => string
  /** Concluded instance status label (end row). */
  statusLabel: string
  /** The view's current-seat labels for one open node. */
  currentHandlers: (nodeKey: string) => string[]
  /** Wait / mode note for one open node. */
  currentNote: (nodeKey: string) => string
  /** User-name lookup for steps ahead, or `null` when names must not be shown there. */
  expectedUserName: ((userId: string) => string | null) | null
}

// `revoke`: the withdrawer is not the open node's handler and that node never completed; the end
// row states the withdrawal. `sign`: engine-written rows only (cancelled seats, skipped-auto-approval
// notices); the decision is the person's own row written beside it.
const NON_STEP_ACTIONS = new Set(['created', 'cc', 'comment', 'remind', 'revoke', 'sign'])
const DECISION_ACTIONS = new Set(['approve', 'reject', 'return', 'handle'])

function graphNode(graph: ApprovalGraph | null, nodeKey: string): ApprovalNode | undefined {
  return graph?.nodes.find((node) => node.key === nodeKey)
}

function stepName(input: ApprovalProgressInput, nodeKey: string): string {
  const node = graphNode(input.graph, nodeKey)
  const named = typeof node?.name === 'string' ? node.name.trim() : ''
  if (named) return named
  // Not in the graph, or unnamed there: the view's fallback (never the node key).
  return input.nodeName(nodeKey)
}

function rowNodeKey(row: UnifiedApprovalHistoryDTO): string | null {
  const key = row.metadata?.nodeKey
  return typeof key === 'string' && key.trim() ? key : null
}

function timeOf(row: UnifiedApprovalHistoryDTO): number | null {
  if (!row.occurredAt) return null
  const ms = Date.parse(row.occurredAt)
  return Number.isNaN(ms) ? null : ms
}

/**
 * History arrives newest first. Oldest first here: by time when every row has one (ties keep the
 * server order), otherwise the server order reversed.
 */
function chronological(history: readonly UnifiedApprovalHistoryDTO[]): UnifiedApprovalHistoryDTO[] {
  const indexed = history.map((row, index) => ({ row, index, time: timeOf(row) }))
  if (indexed.every((entry) => entry.time !== null)) {
    return indexed
      .sort((a, b) => (a.time! - b.time!) || (b.index - a.index))
      .map((entry) => entry.row)
  }
  return indexed.reverse().map((entry) => entry.row)
}

function uniqueJoined(values: readonly string[], separator: string): string {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    const trimmed = value.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out.join(separator)
}

/**
 * The configured user ids of an approval / handler node whose EVERY source is a fixed user list
 * (or the legacy user shape). Any other source mix returns `[]`: its people cannot be named ahead.
 */
export function fixedApproverUserIds(node: ApprovalNode | undefined): string[] {
  if (!node || (node.type !== 'approval' && node.type !== 'handler')) return []
  const cfg = node.config as ApprovalNodeConfig | HandlerNodeConfig
  const sources = cfg.assigneeSources ?? []
  const out: string[] = []
  if (sources.length > 0) {
    for (const source of sources) {
      if (source.kind !== 'static_user') return []
      out.push(...source.userIds)
    }
    return out
  }
  const legacy = cfg as ApprovalNodeConfig
  if (legacy.assigneeType === 'user' && Array.isArray(legacy.assigneeIds)) out.push(...legacy.assigneeIds)
  return out
}

/**
 * The parallel node that encloses every open branch, picked as the innermost when nested; `null`
 * when none (or the graph names no join). Region = nodes reachable from the fan-out before its join.
 */
function enclosingJoinKey(graph: ApprovalGraph, openKeys: readonly string[]): string | null {
  const outgoing = new Map<string, string[]>()
  for (const edge of graph.edges) {
    if (!outgoing.has(edge.source)) outgoing.set(edge.source, [])
    outgoing.get(edge.source)!.push(edge.target)
  }
  const nodeKeys = new Set(graph.nodes.map((node) => node.key))
  let best: { join: string; size: number } | null = null
  let tie = false
  for (const node of graph.nodes) {
    if (node.type !== 'parallel') continue
    const join = (node.config as ParallelNodeConfig | undefined)?.joinNodeKey
    if (typeof join !== 'string' || !nodeKeys.has(join)) continue
    const region = new Set<string>()
    const queue = [...(outgoing.get(node.key) ?? [])]
    while (queue.length > 0 && region.size <= graph.nodes.length) {
      const next = queue.shift()!
      if (next === join || region.has(next)) continue
      region.add(next)
      queue.push(...(outgoing.get(next) ?? []))
    }
    if (!openKeys.every((key) => region.has(key))) continue
    if (!best || region.size < best.size) {
      best = { join, size: region.size }
      tie = false
    } else if (region.size === best.size && join !== best.join) {
      tie = true
    }
  }
  return best && !tie ? best.join : null
}

type WalkInput = Pick<ApprovalProgressInput, 'graph' | 'currentNodeKeys' | 'inParallelRegion' | 'formSchema' | 'isZh'>

/** The nodes ahead of the open step(s), nearest first — the same walk the timeline's list uses. */
function nodesAhead(input: WalkInput): { keys: string[]; summaries: Map<string, string>; parallelUnresolved: boolean } {
  const graph = input.graph
  const summaries = new Map<string, string>()
  const keys: string[] = []
  if (!graph || input.currentNodeKeys.length === 0) return { keys, summaries, parallelUnresolved: false }
  let from: string
  if (input.inParallelRegion || input.currentNodeKeys.length > 1) {
    const join = enclosingJoinKey(graph, input.currentNodeKeys)
    if (!join) return { keys, summaries, parallelUnresolved: true }
    const joinNode = graphNode(graph, join)!
    keys.push(join)
    // The join node itself, summarized the same way the walk summarizes every other node.
    summaries.set(join, nodeAssigneeSourceSummary(joinNode, input.formSchema, input.isZh))
    if (joinNode.type === 'end' || joinNode.type === 'condition' || joinNode.type === 'parallel') return { keys, summaries, parallelUnresolved: false }
    from = join
  } else {
    from = input.currentNodeKeys[0]!
  }
  for (const item of buildUpcomingNodes(graph, from, input.formSchema, input.isZh)) {
    if (keys.includes(item.key)) break
    keys.push(item.key)
    summaries.set(item.key, item.assigneeSummary)
  }
  return { keys, summaries, parallelUnresolved: false }
}

/** User ids the steps ahead could be named by (for the view's resolver watch). */
export function expectedApproverUserIds(input: WalkInput): string[] {
  const { keys } = nodesAhead(input)
  const out: string[] = []
  for (const key of keys) out.push(...fixedApproverUserIds(graphNode(input.graph, key)))
  return Array.from(new Set(out))
}

function expectedNames(input: ApprovalProgressInput, node: ApprovalNode | undefined): string | null {
  const lookup = input.expectedUserName
  if (!lookup || input.namesWithheld) return null
  const ids = Array.from(new Set(fixedApproverUserIds(node)))
  if (ids.length === 0) return null
  const names: string[] = []
  for (const id of ids) {
    const resolved = lookup(id)
    // All or nothing: one unresolved user keeps the whole step on the count-only summary.
    if (!resolved) return null
    names.push(resolved)
  }
  return uniqueJoined(names, input.labels.progressListSeparator)
}

export function buildApprovalProgress(input: ApprovalProgressInput): ApprovalProgressStep[] {
  const { labels } = input
  const sep = labels.progressListSeparator
  const steps: ApprovalProgressStep[] = []
  const ordered = chronological(input.history)
  const startKeys = new Set((input.graph?.nodes ?? []).filter((node) => node.type === 'start').map((node) => node.key))
  const pending = input.status === 'pending'
  const openKeys = new Set(pending ? input.currentNodeKeys : [])

  const createdRow = ordered.find((row) => row.action === 'created')
  steps.push({
    key: '__start',
    state: 'start',
    name: labels.progressStartNode,
    stateLabel: labels.progressStateStarted,
    outcome: '',
    people: !input.namesWithheld && input.requesterName.trim() ? `${labels.progressRequester}${input.requesterName.trim()}` : '',
    at: createdRow?.occurredAt ?? input.createdAt,
    note: '',
  })

  const groups = new Map<string, UnifiedApprovalHistoryDTO[]>()
  for (const row of ordered) {
    if (NON_STEP_ACTIONS.has(row.action)) continue
    const nodeKey = rowNodeKey(row)
    if (!nodeKey || startKeys.has(nodeKey) || openKeys.has(nodeKey)) continue
    if (!groups.has(nodeKey)) groups.set(nodeKey, [])
    groups.get(nodeKey)!.push(row)
  }
  for (const [nodeKey, rows] of groups) {
    const decisions = rows.filter((row) => DECISION_ACTIONS.has(row.action))
    if (decisions.length === 0) continue
    const last = decisions[decisions.length - 1]!
    const people = input.namesWithheld ? '' : uniqueJoined(decisions.map((row) => input.actorName(row)), sep)
    steps.push({
      key: nodeKey,
      state: 'done',
      name: stepName(input, nodeKey),
      stateLabel: labels.progressStateDone,
      outcome: input.actionLabel(last),
      people: people ? `${labels.progressHandledBy}${people}` : '',
      at: last.occurredAt ?? null,
      note: '',
    })
  }

  if (!pending) {
    steps.push({
      key: '__end',
      state: 'end',
      name: labels.progressEndNode,
      stateLabel: labels.progressStateEnded,
      outcome: input.statusLabel,
      people: '',
      at: input.updatedAt,
      note: '',
    })
    return steps
  }

  const parallel = input.inParallelRegion || input.currentNodeKeys.length > 1
  for (const nodeKey of input.currentNodeKeys) {
    const handlers = uniqueJoined(input.currentHandlers(nodeKey), sep)
    steps.push({
      key: nodeKey,
      state: 'current',
      name: stepName(input, nodeKey),
      stateLabel: parallel ? `${labels.progressStateCurrent} · ${labels.progressStateParallel}` : labels.progressStateCurrent,
      outcome: '',
      // The cancel-round wording is not a person, so it carries no handler prefix.
      people: handlers ? (input.namesWithheld ? handlers : `${labels.progressCurrentHandler}${handlers}`) : '',
      at: null,
      note: input.currentNote(nodeKey),
    })
  }

  const ahead = nodesAhead(input)
  if (ahead.parallelUnresolved) {
    steps.push({
      key: '__parallel-next',
      state: 'parallel',
      name: labels.progressStateParallel,
      stateLabel: labels.progressStateExpected,
      outcome: '',
      people: '',
      at: null,
      note: labels.progressParallelNext,
    })
    return steps
  }
  for (const key of ahead.keys) {
    const node = graphNode(input.graph, key)
    const summary = ahead.summaries.get(key) ?? ''
    if (node?.type === 'condition') {
      steps.push({ key, state: 'branch', name: stepName(input, key), stateLabel: labels.progressStateBranch, outcome: '', people: '', at: null, note: summary })
      break
    }
    if (node?.type === 'parallel') {
      steps.push({ key, state: 'parallel', name: stepName(input, key), stateLabel: labels.progressStateParallel, outcome: '', people: '', at: null, note: summary })
      break
    }
    if (node?.type === 'end') {
      steps.push({ key, state: 'expected', name: stepName(input, key), stateLabel: labels.progressStateExpected, outcome: '', people: '', at: null, note: '' })
      break
    }
    const names = expectedNames(input, node)
    const who = names ?? summary
    steps.push({
      key,
      state: 'expected',
      name: stepName(input, key),
      stateLabel: labels.progressStateExpected,
      outcome: '',
      people: who ? `${labels.progressExpectedHandler}${who}` : '',
      at: null,
      note: '',
    })
  }
  return steps
}
