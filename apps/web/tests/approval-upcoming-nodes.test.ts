import { describe, expect, it } from 'vitest'
import type { ApprovalGraph, UnifiedApprovalHistoryDTO } from '../src/types/approval'
import { buildUpcomingNodes } from '../src/approvals/upcomingNodes'
import {
  buildApprovalProgress,
  expectedApproverUserIds,
  fixedApproverUserIds,
  type ApprovalProgressInput,
} from '../src/approvals/approvalProgress'
import { DETAIL_EN, DETAIL_ZH } from '../src/views/approval/approvalDetailLabels'

// UX B2-08 — pure graph-walk contract for the approval detail view's "upcoming nodes" preview.
// Mirrors the fixture style already used by `approval-graph-layout.test.ts`.

const LINEAR: ApprovalGraph = {
  nodes: [
    { key: 'start', type: 'start', name: '发起', config: {} },
    { key: 'approval_1', type: 'approval', name: '部门主管审批', config: { assigneeSources: [{ kind: 'direct_manager' }] } },
    { key: 'approval_2', type: 'approval', name: '财务审批', config: { assigneeSources: [{ kind: 'static_user' as const, userIds: ['user_finance'] }] } },
    { key: 'end', type: 'end', name: '结束', config: {} },
  ],
  edges: [
    { key: 'e1', source: 'start', target: 'approval_1' },
    { key: 'e2', source: 'approval_1', target: 'approval_2' },
    { key: 'e3', source: 'approval_2', target: 'end' },
  ],
}

// start → cond → {high, low} → join → end (a rejoin — same topology style as
// `approval-graph-layout.test.ts`'s REJOIN fixture).
const REJOIN: ApprovalGraph = {
  nodes: [
    { key: 'start', type: 'start', config: {} },
    { key: 'approval_1', type: 'approval', name: '部门主管审批', config: { assigneeSources: [{ kind: 'direct_manager' }] } },
    { key: 'cond', type: 'condition', name: '金额分支', config: { branches: [{ edgeKey: 'e-high', rules: [] }], defaultEdgeKey: 'e-low' } },
    { key: 'high', type: 'approval', name: '高额审批', config: { assigneeSources: [{ kind: 'dept_head' }] } },
    { key: 'low', type: 'approval', name: '低额审批', config: { assigneeSources: [{ kind: 'requester' }] } },
    { key: 'join', type: 'approval', name: '汇总审批', config: { assigneeSources: [{ kind: 'requester' }] } },
    { key: 'end', type: 'end', name: '结束', config: {} },
  ],
  edges: [
    { key: 'e-s', source: 'start', target: 'approval_1' },
    { key: 'e-a-c', source: 'approval_1', target: 'cond' },
    { key: 'e-high', source: 'cond', target: 'high' },
    { key: 'e-low', source: 'cond', target: 'low' },
    { key: 'e-h-j', source: 'high', target: 'join' },
    { key: 'e-l-j', source: 'low', target: 'join' },
    { key: 'e-j-e', source: 'join', target: 'end' },
  ],
}

// start → a1 → par (fans into b1/b2) → join → end.
const PARALLEL: ApprovalGraph = {
  nodes: [
    { key: 'start', type: 'start', config: {} },
    { key: 'approval_1', type: 'approval', name: '前置审批', config: { assigneeSources: [{ kind: 'direct_manager' }] } },
    { key: 'par', type: 'parallel', name: '并行网关', config: { branches: ['b1', 'b2'], joinMode: 'all', joinNodeKey: 'join' } },
    { key: 'b1', type: 'approval', name: '法务审批', config: { assigneeSources: [{ kind: 'dept_head' }] } },
    { key: 'b2', type: 'approval', name: '合规审批', config: { assigneeSources: [{ kind: 'dept_head' }] } },
    { key: 'join', type: 'approval', name: '汇总审批', config: { assigneeSources: [{ kind: 'requester' }] } },
    { key: 'end', type: 'end', name: '结束', config: {} },
  ],
  edges: [
    { key: 'e-s', source: 'start', target: 'approval_1' },
    { key: 'e-a-p', source: 'approval_1', target: 'par' },
    { key: 'e-p-b1', source: 'par', target: 'b1' },
    { key: 'e-p-b2', source: 'par', target: 'b2' },
    { key: 'e-b1-j', source: 'b1', target: 'join' },
    { key: 'e-b2-j', source: 'b2', target: 'join' },
    { key: 'e-j-e', source: 'join', target: 'end' },
  ],
}

describe('buildUpcomingNodes', () => {
  it('linear chain: returns every node after current, in order, ending at `end`', () => {
    const upcoming = buildUpcomingNodes(LINEAR, 'approval_1')
    expect(upcoming.map((n) => n.key)).toEqual(['approval_2', 'end'])
    expect(upcoming[0]).toEqual({
      key: 'approval_2',
      name: '财务审批',
      assigneeSummary: '指定用户（1 人）',
      isConditional: false,
    })
    expect(upcoming[1]).toEqual({
      key: 'end',
      name: '结束',
      assigneeSummary: '流程结束',
      isConditional: false,
    })
  })

  // Discriminating negative for the P3 fix (assigneeSource.ts's requesterFacingSourceSummary):
  // a static_user source with raw-id-shaped ids must render as a COUNT, never the ids themselves,
  // through the exact same real render chain (buildUpcomingNodes -> nodeAssigneeSourceSummary) the
  // approval detail view's "upcoming nodes" timeline uses. Positive control: the count IS shown.
  it('static_user source with raw-id-shaped ids: the summary is a count, never the raw ids (P3)', () => {
    const graph: ApprovalGraph = {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        { key: 'approval_1', type: 'approval', name: '成员审批', config: { assigneeSources: [{ kind: 'static_user' as const, userIds: ['user_9', 'user_42'] }] } },
        { key: 'end', type: 'end', name: '结束', config: {} },
      ],
      edges: [
        { key: 'e1', source: 'start', target: 'approval_1' },
        { key: 'e2', source: 'approval_1', target: 'end' },
      ],
    }
    const upcoming = buildUpcomingNodes(graph, 'start')
    const summary = upcoming[0].assigneeSummary
    // Positive control: a count IS shown.
    expect(summary).toBe('指定用户（2 人）')
    // Negative: neither raw id renders.
    expect(summary).not.toContain('user_9')
    expect(summary).not.toContain('user_42')
  })

  // Second, independent discriminating negative for the P3 fix — the LEGACY
  // assigneeType/assigneeIds shape (no `assigneeSources` present, so this exercises
  // `nodeAssigneeSourceSummary`'s other branch, not `requesterFacingSourceSummary` above). Gate
  // report's exact cited line (`assigneeSource.ts:75`).
  it('legacy assigneeType/assigneeIds source with raw-id-shaped ids: the summary is a count, never the raw ids (P3)', () => {
    const graph: ApprovalGraph = {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        { key: 'approval_1', type: 'approval', name: '成员审批', config: { assigneeType: 'user', assigneeIds: ['user_9', 'user_42'] } },
        { key: 'end', type: 'end', name: '结束', config: {} },
      ],
      edges: [
        { key: 'e1', source: 'start', target: 'approval_1' },
        { key: 'e2', source: 'approval_1', target: 'end' },
      ],
    }
    const upcoming = buildUpcomingNodes(graph, 'start')
    const summary = upcoming[0].assigneeSummary
    // Positive control: a count IS shown.
    expect(summary).toBe('指定成员（2 人）')
    // Negative: neither raw id renders.
    expect(summary).not.toContain('user_9')
    expect(summary).not.toContain('user_42')
  })

  it('current at the last approval node before end: walk still resolves through to `end`', () => {
    const upcoming = buildUpcomingNodes(LINEAR, 'approval_2')
    expect(upcoming.map((n) => n.key)).toEqual(['end'])
  })

  it('current AT end: nothing further (empty)', () => {
    expect(buildUpcomingNodes(LINEAR, 'end')).toEqual([])
  })

  it('current key not present in the graph at all: empty, no throw', () => {
    expect(buildUpcomingNodes(LINEAR, 'does_not_exist')).toEqual([])
  })

  it('condition node ahead: includes ONE honest entry, isConditional true, no fabricated branch', () => {
    const upcoming = buildUpcomingNodes(REJOIN, 'approval_1')
    expect(upcoming.map((n) => n.key)).toEqual(['cond'])
    expect(upcoming[0]).toEqual({
      key: 'cond',
      name: '金额分支',
      assigneeSummary: '按条件进入后续分支',
      isConditional: true,
    })
    // Neither branch (`high`/`low`) — nor the rejoin (`join`) — is fabricated past the condition.
    expect(upcoming.some((n) => n.key === 'high' || n.key === 'low' || n.key === 'join')).toBe(false)
  })

  it('current key IS the condition node itself: no single honest "next" to report (empty)', () => {
    expect(buildUpcomingNodes(REJOIN, 'cond')).toEqual([])
  })

  it('parallel fan-out ahead: includes ONE honest entry, isConditional false, no fabricated branch', () => {
    const upcoming = buildUpcomingNodes(PARALLEL, 'approval_1')
    expect(upcoming.map((n) => n.key)).toEqual(['par'])
    expect(upcoming[0]).toEqual({
      key: 'par',
      name: '并行网关',
      assigneeSummary: '进入并行分支',
      isConditional: false,
    })
    expect(upcoming.some((n) => n.key === 'b1' || n.key === 'b2' || n.key === 'join')).toBe(false)
  })

  it('a dangling edge (target not in graph.nodes) stops the walk without throwing', () => {
    const dangling: ApprovalGraph = {
      nodes: [
        { key: 'start', type: 'start', config: {} },
        { key: 'approval_1', type: 'approval', name: '审批', config: {} },
      ],
      edges: [
        { key: 'e1', source: 'start', target: 'approval_1' },
        { key: 'e2', source: 'approval_1', target: 'missing_node' },
      ],
    }
    expect(buildUpcomingNodes(dangling, 'approval_1')).toEqual([])
  })

  it('a cycle does not infinite-loop (defensive visited guard)', () => {
    const cyclic: ApprovalGraph = {
      nodes: [
        { key: 'a', type: 'approval', name: 'A', config: {} },
        { key: 'b', type: 'approval', name: 'B', config: {} },
      ],
      edges: [
        { key: 'e1', source: 'a', target: 'b' },
        { key: 'e2', source: 'b', target: 'a' },
      ],
    }
    const upcoming = buildUpcomingNodes(cyclic, 'a')
    expect(upcoming.map((n) => n.key)).toEqual(['b'])
  })

  it('falls back to the node key when a node has no name', () => {
    const noName: ApprovalGraph = {
      nodes: [
        { key: 'a1', type: 'approval', config: {} },
        { key: 'a2', type: 'approval', config: {} },
      ],
      edges: [{ key: 'e1', source: 'a1', target: 'a2' }],
    }
    expect(buildUpcomingNodes(noName, 'a1')[0].name).toBe('a2')
  })
})

// =========================================================================
// 流程进度 (approvalProgress.ts) — the detail page's one-row-per-step progress list. Kept in this
// already-wired spec, beside the walk it reuses, so it runs in both web lanes without new wiring.
// The mounted proofs are in approval-e2e-lifecycle.spec.ts (「流程进度」).
// =========================================================================
const PROGRESS_LINEAR: ApprovalGraph = {
  nodes: [
    { key: 'start', type: 'start', name: '发起', config: {} },
    { key: 'a1', type: 'approval', name: '部门审批', config: { assigneeSources: [{ kind: 'direct_manager' }] } },
    { key: 'a2', type: 'approval', name: '财务审批', config: { assigneeSources: [{ kind: 'static_user', userIds: ['user_fin'] }], approvalMode: 'all' } },
    { key: 'a3', type: 'approval', name: '总经理审批', config: { assigneeSources: [{ kind: 'static_user', userIds: ['user_gm', 'user_vp'] }] } },
    { key: 'cc1', type: 'cc', name: '抄送行政', config: { targetType: 'user', targetIds: ['user_admin'] } },
    { key: 'end', type: 'end', name: '结束', config: {} },
  ],
  edges: [
    { key: 'e1', source: 'start', target: 'a1' },
    { key: 'e2', source: 'a1', target: 'a2' },
    { key: 'e3', source: 'a2', target: 'a3' },
    { key: 'e4', source: 'a3', target: 'cc1' },
    { key: 'e5', source: 'cc1', target: 'end' },
  ],
}

function progressRow(id: string, action: string, actorName: string, occurredAt: string | null, nodeKey?: string, extra: Record<string, unknown> = {}): UnifiedApprovalHistoryDTO {
  return {
    id, action, actorId: `actor_${id}`, actorName, comment: null, fromStatus: 'pending', toStatus: 'pending',
    occurredAt, metadata: nodeKey ? { nodeKey, ...extra } : { ...extra },
  }
}

const ACTION_ZH: Record<string, string> = { approve: '通过', reject: '驳回', return: '退回', handle: '办理', created: '发起', sign: '签字', revoke: '撤回' }

// A history row in the shape the history endpoint sends: metadata carries only the keys it projects
// (here `nodeKey`, plus `autoApproved` where the server sets it), and the actor id is as written.
function wireRow(id: string, action: string, actorId: string, actorName: string | null, occurredAt: string, metadata: Record<string, unknown>): UnifiedApprovalHistoryDTO {
  return { id, action, actorId, actorName, comment: null, fromStatus: 'pending', toStatus: 'pending', occurredAt, metadata }
}

// The detail page's actor naming for system rows (historyActorName), reduced to what these cases need.
function viewLikeActorName(row: UnifiedApprovalHistoryDTO): string {
  if (row.metadata?.autoApproved) return '系统自动审批'
  if (row.actorId === 'system:auto-approval') return '系统自动审批'
  if (row.actorId === 'system') return '系统'
  return row.actorName ?? '系统'
}

function progressInput(overrides: Partial<ApprovalProgressInput> = {}): ApprovalProgressInput {
  return {
    status: 'pending',
    requesterName: '张三',
    createdAt: '2026-10-01T01:00:00.000Z',
    updatedAt: '2026-10-02T01:00:00.000Z',
    // Newest first, as the history endpoint returns it.
    history: [
      progressRow('h3', 'remind', '张三', '2026-10-02T03:00:00.000Z', 'a2'),
      progressRow('h2', 'approve', '李四', '2026-10-02T01:00:00.000Z', 'a1'),
      progressRow('h1', 'created', '张三', '2026-10-01T01:00:00.000Z', 'start'),
    ],
    graph: PROGRESS_LINEAR,
    formSchema: null,
    currentNodeKeys: ['a2'],
    inParallelRegion: false,
    namesWithheld: false,
    isZh: true,
    labels: DETAIL_ZH,
    nodeName: () => '审批节点',
    actorName: (row) => row.actorName ?? '系统',
    actionLabel: (row) => ACTION_ZH[row.action] ?? row.action,
    statusLabel: '已通过',
    currentHandlers: (nodeKey) => (nodeKey === 'a2' ? ['王五'] : []),
    currentNote: () => '已等待 1 天',
    expectedUserName: null,
    ...overrides,
  }
}

describe('buildApprovalProgress (流程进度)', () => {
  it('linear pending: start, done (actor + time + result), current (handler), then expected steps to the end', () => {
    const steps = buildApprovalProgress(progressInput())
    expect(steps.map((step) => [step.state, step.key])).toEqual([
      ['start', '__start'],
      ['done', 'a1'],
      ['current', 'a2'],
      ['expected', 'a3'],
      ['expected', 'cc1'],
      ['expected', 'end'],
    ])
    expect(steps[0]).toMatchObject({ name: '发起', stateLabel: '已提交', people: '发起人：张三', at: '2026-10-01T01:00:00.000Z' })
    expect(steps[1]).toMatchObject({ name: '部门审批', stateLabel: '已完成', outcome: '通过', people: '处理人：李四', at: '2026-10-02T01:00:00.000Z' })
    expect(steps[2]).toMatchObject({ name: '财务审批', stateLabel: '进行中', people: '当前处理人：王五', note: '已等待 1 天' })
    // Without a name lookup, a step ahead keeps the count-only source summary.
    expect(steps[3]).toMatchObject({ name: '总经理审批', stateLabel: '预计', people: '预计处理人：指定用户（2 人）' })
    expect(steps[4]).toMatchObject({ name: '抄送行政', people: '预计处理人：抄送成员' })
    expect(steps[5]).toMatchObject({ name: '结束', stateLabel: '预计', people: '' })
    // A remind row at the open node is not a step; no id anywhere.
    const text = JSON.stringify(steps)
    for (const id of ['user_gm', 'user_vp', 'user_admin', 'user_fin', 'actor_h2']) expect(text).not.toContain(id)
  })

  it('steps ahead show user names only when every configured user resolves (all or the count)', () => {
    const all = buildApprovalProgress(progressInput({
      expectedUserName: (id) => ({ user_gm: '赵六', user_vp: '钱八' } as Record<string, string>)[id] ?? null,
    }))
    expect(all.find((step) => step.key === 'a3')?.people).toBe('预计处理人：赵六、钱八')
    // A cc step is never named ahead (only approval / handler nodes with fixed users are).
    expect(all.find((step) => step.key === 'cc1')?.people).toBe('预计处理人：抄送成员')

    const partial = buildApprovalProgress(progressInput({
      expectedUserName: (id) => (id === 'user_gm' ? '赵六' : null),
    }))
    expect(partial.find((step) => step.key === 'a3')?.people).toBe('预计处理人：指定用户（2 人）')
    expect(JSON.stringify(partial)).not.toContain('赵六')
  })

  it('stops at a condition node with the honest summary, never a guessed branch', () => {
    const steps = buildApprovalProgress(progressInput({
      graph: REJOIN,
      history: [],
      currentNodeKeys: ['approval_1'],
      currentHandlers: () => ['王五'],
    }))
    expect(steps.map((step) => step.state)).toEqual(['start', 'current', 'branch'])
    expect(steps[2]).toMatchObject({ key: 'cond', name: '金额分支', stateLabel: '按条件分支', note: '按条件进入后续分支' })
    const text = JSON.stringify(steps)
    for (const name of ['高额审批', '低额审批', '汇总审批']) expect(text).not.toContain(name)
  })

  it('parallel region: each open branch is marked, then the walk resumes from the join node', () => {
    const steps = buildApprovalProgress(progressInput({
      graph: PARALLEL,
      history: [progressRow('h2', 'approve', '李四', '2026-10-02T01:00:00.000Z', 'approval_1')],
      currentNodeKeys: ['b1', 'b2'],
      inParallelRegion: true,
      currentHandlers: (nodeKey) => (nodeKey === 'b1' ? ['孙七'] : ['周九']),
    }))
    expect(steps.map((step) => [step.state, step.key])).toEqual([
      ['start', '__start'],
      ['done', 'approval_1'],
      ['current', 'b1'],
      ['current', 'b2'],
      ['expected', 'join'],
      ['expected', 'end'],
    ])
    expect(steps[2]).toMatchObject({ stateLabel: '进行中 · 并行分支', people: '当前处理人：孙七' })
    expect(steps[3]).toMatchObject({ stateLabel: '进行中 · 并行分支', people: '当前处理人：周九' })
    expect(steps[4]).toMatchObject({ name: '汇总审批', people: '预计处理人：发起人' })
  })

  it('parallel region without a resolvable join: one honest marker and nothing guessed after it', () => {
    const noJoin: ApprovalGraph = {
      ...PARALLEL,
      nodes: PARALLEL.nodes.map((node) => (node.key === 'par' ? { ...node, config: { branches: ['b1', 'b2'], joinMode: 'all', joinNodeKey: 'missing' } } : node)),
    }
    const steps = buildApprovalProgress(progressInput({
      graph: noJoin, history: [], currentNodeKeys: ['b1', 'b2'], inParallelRegion: true, currentHandlers: () => [],
    }))
    expect(steps.map((step) => step.state)).toEqual(['start', 'current', 'current', 'parallel'])
    expect(steps[3]).toMatchObject({ stateLabel: '预计', note: '各并行分支完成后继续' })
    expect(JSON.stringify(steps)).not.toContain('汇总审批')
  })

  it('cancel round: no person is named anywhere; the open step carries the wording passed in, unprefixed', () => {
    const steps = buildApprovalProgress(progressInput({
      namesWithheld: true,
      currentHandlers: () => ['撤销申请审批中'],
      expectedUserName: () => '不应出现',
    }))
    expect(steps[0].people).toBe('')
    expect(steps.find((step) => step.state === 'done')?.people).toBe('')
    expect(steps.find((step) => step.state === 'current')?.people).toBe('撤销申请审批中')
    const text = JSON.stringify(steps)
    for (const name of ['张三', '李四', '不应出现', '当前处理人']) expect(text).not.toContain(name)
  })

  it('a concluded instance: done steps then one end row with the status label; nothing open or ahead', () => {
    const steps = buildApprovalProgress(progressInput({
      status: 'approved',
      history: [
        progressRow('h3', 'approve', '王五', '2026-10-03T01:00:00.000Z', 'a2'),
        progressRow('h2', 'approve', '李四', '2026-10-02T01:00:00.000Z', 'a1'),
      ],
      currentNodeKeys: [],
      updatedAt: '2026-10-03T01:00:00.000Z',
    }))
    expect(steps.map((step) => [step.state, step.key])).toEqual([
      ['start', '__start'], ['done', 'a1'], ['done', 'a2'], ['end', '__end'],
    ])
    expect(steps[3]).toMatchObject({ name: '结束', stateLabel: '已结束', outcome: '已通过', at: '2026-10-03T01:00:00.000Z' })
  })

  it('groups by node in first-reached order: cc / comment / remind rows are not steps, a revisited node shows once', () => {
    const steps = buildApprovalProgress(progressInput({
      status: 'rejected',
      // Oldest first on purpose: order comes from the times, not the array position.
      history: [
        progressRow('h1', 'approve', '李四', '2026-10-02T01:00:00.000Z', 'a1'),
        progressRow('h2', 'comment', '路人', '2026-10-02T02:00:00.000Z', 'a2'),
        progressRow('h3', 'return', '王五', '2026-10-02T03:00:00.000Z', 'a2'),
        progressRow('h4', 'cc', '系统', '2026-10-02T03:30:00.000Z', 'cc1'),
        progressRow('h5', 'approve', '李四', '2026-10-02T04:00:00.000Z', 'a1'),
        progressRow('h7', 'reject', '王五', '2026-10-02T05:00:00.000Z', 'a2'),
      ],
      currentNodeKeys: [],
    }))
    expect(steps.map((step) => step.key)).toEqual(['__start', 'a1', 'a2', '__end'])
    expect(steps[1]).toMatchObject({ outcome: '通过', people: '处理人：李四', at: '2026-10-02T04:00:00.000Z' })
    expect(steps[2]).toMatchObject({ outcome: '驳回', people: '处理人：王五' })
    expect(JSON.stringify(steps)).not.toContain('路人')
    expect(JSON.stringify(steps)).not.toContain('系统')
  })

  it('a seat cancelled by the engine after another seat approved (same time, either order) is not a decision: the node reads 通过 by the person only', () => {
    // The approve row and the engine's cancel row are written together and share one timestamp;
    // the endpoint has no secondary sort key, so both orders must read the same.
    const approve = wireRow('h5', 'approve', 'user_li', '李四', '2026-10-02T04:00:00.000Z', { nodeKey: 'a1' })
    const cancelled = wireRow('h6', 'sign', 'system', 'System', '2026-10-02T04:00:00.000Z', { nodeKey: 'a1' })
    for (const tie of [[cancelled, approve], [approve, cancelled]]) {
      const steps = buildApprovalProgress(progressInput({
        status: 'pending',
        history: [...tie, wireRow('h1', 'created', 'user_zhang', '张三', '2026-10-01T01:00:00.000Z', { nodeKey: 'start' })],
        currentNodeKeys: ['a2'],
        actorName: viewLikeActorName,
      }))
      expect(steps.map((step) => [step.state, step.key]).slice(0, 3)).toEqual([['start', '__start'], ['done', 'a1'], ['current', 'a2']])
      expect(steps[1]).toMatchObject({ outcome: '通过', people: '处理人：李四', at: '2026-10-02T04:00:00.000Z' })
      const text = JSON.stringify(steps)
      for (const word of ['系统', 'System', '签字']) expect(text).not.toContain(word)
    }
  })

  it('a skipped-auto-approval notice is not a decision: the person who then approves is the only handler', () => {
    const steps = buildApprovalProgress(progressInput({
      status: 'approved',
      history: [
        wireRow('h3', 'approve', 'user_wang', '王五', '2026-10-03T01:00:00.000Z', { nodeKey: 'a2' }),
        wireRow('h2', 'sign', 'system:auto-approval', null, '2026-10-02T02:00:00.000Z', { nodeKey: 'a2', autoApproved: true }),
        wireRow('h1', 'approve', 'user_li', '李四', '2026-10-02T01:00:00.000Z', { nodeKey: 'a1' }),
      ],
      currentNodeKeys: [],
      actorName: viewLikeActorName,
    }))
    expect(steps.map((step) => step.key)).toEqual(['__start', 'a1', 'a2', '__end'])
    expect(steps[2]).toMatchObject({ outcome: '通过', people: '处理人：王五', at: '2026-10-03T01:00:00.000Z' })
    const text = JSON.stringify(steps)
    for (const word of ['系统', '系统自动审批', 'System', '签字']) expect(text).not.toContain(word)
  })

  it('a withdrawn instance: the node it waited at is not a done step, and the requester is named only as the requester', () => {
    const steps = buildApprovalProgress(progressInput({
      status: 'revoked',
      history: [
        wireRow('h3', 'revoke', 'user_zhang', '张三', '2026-10-03T01:00:00.000Z', { nodeKey: 'a2' }),
        wireRow('h2', 'approve', 'user_li', '李四', '2026-10-02T01:00:00.000Z', { nodeKey: 'a1' }),
        wireRow('h1', 'created', 'user_zhang', '张三', '2026-10-01T01:00:00.000Z', { nodeKey: 'start' }),
      ],
      currentNodeKeys: [],
      statusLabel: '已撤回',
      updatedAt: '2026-10-03T01:00:00.000Z',
      actorName: viewLikeActorName,
    }))
    expect(steps.map((step) => step.key)).toEqual(['__start', 'a1', '__end'])
    expect(steps[0].people).toBe('发起人：张三')
    expect(steps[1]).toMatchObject({ outcome: '通过', people: '处理人：李四' })
    expect(steps[2]).toMatchObject({ state: 'end', stateLabel: '已结束', outcome: '已撤回', at: '2026-10-03T01:00:00.000Z' })
    for (const step of steps.slice(1)) expect(JSON.stringify(step)).not.toContain('张三')
    expect(steps.some((step) => step.outcome === '撤回')).toBe(false)
  })

  it('without a graph: history and open steps still render (node names from the fallback), nothing ahead', () => {
    const steps = buildApprovalProgress(progressInput({ graph: null }))
    expect(steps.map((step) => step.state)).toEqual(['start', 'done', 'current'])
    expect(steps[1].name).toBe('审批节点')
  })

  it('English labels: no CJK from the module itself', () => {
    const CJK = /[　-〿一-鿿＀-￯]/
    const steps = buildApprovalProgress(progressInput({
      isZh: false,
      labels: DETAIL_EN,
      requesterName: 'Ann',
      graph: {
        nodes: PROGRESS_LINEAR.nodes.map((node) => ({ ...node, name: `Node ${node.key}` })),
        edges: PROGRESS_LINEAR.edges,
      },
      history: [progressRow('h2', 'approve', 'Bob', '2026-10-02T01:00:00.000Z', 'a1')],
      actionLabel: () => 'Approved',
      currentHandlers: () => ['Cal'],
      currentNote: () => 'Waiting 1 day',
      expectedUserName: (id) => (id === 'user_gm' ? 'Dee' : id === 'user_vp' ? 'Eve' : null),
    }))
    expect(JSON.stringify(steps)).not.toMatch(CJK)
    expect(steps.find((step) => step.key === 'a3')?.people).toBe('Expected: Dee, Eve')
  })
})

describe('fixedApproverUserIds / expectedApproverUserIds', () => {
  it('names only nodes whose every source is a fixed user list (or the legacy user shape)', () => {
    expect(fixedApproverUserIds(PROGRESS_LINEAR.nodes.find((node) => node.key === 'a3'))).toEqual(['user_gm', 'user_vp'])
    expect(fixedApproverUserIds({ key: 'x', type: 'approval', config: { assigneeType: 'user', assigneeIds: ['user_legacy'] } })).toEqual(['user_legacy'])
    expect(fixedApproverUserIds({ key: 'x', type: 'approval', config: { assigneeType: 'role', assigneeIds: ['role_a'] } })).toEqual([])
    expect(fixedApproverUserIds({
      key: 'x', type: 'approval',
      config: { assigneeSources: [{ kind: 'static_user', userIds: ['user_a'] }, { kind: 'direct_manager' }] },
    })).toEqual([])
    expect(fixedApproverUserIds(PROGRESS_LINEAR.nodes.find((node) => node.key === 'cc1'))).toEqual([])
    expect(fixedApproverUserIds(undefined)).toEqual([])
  })

  it('collects the fixed users of the steps ahead only (not the open one, nothing past a condition)', () => {
    expect(expectedApproverUserIds({ graph: PROGRESS_LINEAR, currentNodeKeys: ['a2'], inParallelRegion: false, formSchema: null, isZh: true }))
      .toEqual(['user_gm', 'user_vp'])
    expect(expectedApproverUserIds({ graph: PROGRESS_LINEAR, currentNodeKeys: ['a3'], inParallelRegion: false, formSchema: null, isZh: true }))
      .toEqual([])
    expect(expectedApproverUserIds({ graph: null, currentNodeKeys: ['a2'], inParallelRegion: false, formSchema: null, isZh: true }))
      .toEqual([])
  })
})
