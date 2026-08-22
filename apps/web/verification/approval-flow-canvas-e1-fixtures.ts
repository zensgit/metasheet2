// E1 approval-flow renderer spike fixtures only.
// Lives under verification/ (not production). Coordinates never enter these graphs.
import type {
  ApprovalEdge,
  ApprovalGraph,
  ApprovalNode,
  ConditionBranch,
  ConditionNodeConfig,
  ParallelNodeConfig,
} from '../src/types/approval'

export type E1FixtureId =
  | 'linear'
  | 'condition'
  | 'condition-priority-swapped'
  | 'parallel-all'
  | 'parallel-any'
  | 'long-labels'
  | 'readonly-legacy'
  | 'readonly-timeout'
  | 'readonly-threshold'
  | 'mixed-100'

export interface E1Fixture {
  id: E1FixtureId
  /** Business title shown in the harness chrome (never an internal key). */
  title: string
  graph: ApprovalGraph
  /** When true the spike renders a read-only fidelity banner and blocks mutations. */
  readOnly?: boolean
  /** User-facing reason; no codes, no raw keys. */
  readOnlyReason?: string
  /**
   * Optional display labels for branch exit edges (business language only).
   * Used for the long-label fixture; layout still orders by gateway config.
   */
  branchDisplayLabels?: Record<string, string>
}

const approval = (
  key: string,
  name: string,
  summaryKind: 'manager' | 'dept' | 'role' | 'requester' | 'users' = 'manager',
): ApprovalNode => {
  const sources =
    summaryKind === 'manager'
      ? [{ kind: 'direct_manager' as const }]
      : summaryKind === 'dept'
        ? [{ kind: 'dept_head' as const }]
        : summaryKind === 'role'
          ? [{ kind: 'static_role' as const, roleIds: ['finance'] }]
          : summaryKind === 'requester'
            ? [{ kind: 'requester' as const }]
            : [{ kind: 'static_user' as const, userIds: ['u1', 'u2', 'u3'] }]
  return {
    key,
    type: 'approval',
    name,
    config: {
      assigneeSources: sources,
      approvalMode: summaryKind === 'users' ? 'all' : 'single',
      emptyAssigneePolicy: 'error',
    },
  }
}

const cc = (key: string, name: string): ApprovalNode => ({
  key,
  type: 'cc',
  name,
  config: { targetType: 'role', targetIds: ['managers'] },
})

const start = (): ApprovalNode => ({ key: 'start', type: 'start', name: '发起', config: {} })
const end = (key = 'end'): ApprovalNode => ({ key, type: 'end', name: '结束', config: {} })

function edge(key: string, source: string, target: string): ApprovalEdge {
  return { key, source, target }
}

/** Linear: start → approval → cc → end */
export const FIXTURE_LINEAR: E1Fixture = {
  id: 'linear',
  title: '线性流程',
  graph: {
    // Intentionally odd nodes[] order to prove layout follows edges, not array order.
    nodes: [
      end(),
      cc('cc_1', '抄送相关人'),
      approval('approval_1', '主管审批', 'manager'),
      start(),
    ],
    edges: [
      edge('e-start-approval', 'start', 'approval_1'),
      edge('e-approval-cc', 'approval_1', 'cc_1'),
      edge('e-cc-end', 'cc_1', 'end'),
    ],
  },
}

/**
 * Condition with two ordered rule branches + default rightmost.
 * nodes[] places high before mid, but config.branches places mid before high
 * so lane order must be mid → high → default.
 */
function buildConditionFixture(id: E1FixtureId, branchOrder: ['mid', 'high'] | ['high', 'mid']): E1Fixture {
  const midBranch: ConditionBranch = {
    edgeKey: 'e-mid',
    conjunction: 'and',
    rules: [{ fieldId: 'amount', operator: 'gte', value: 100 }],
  }
  const highBranch: ConditionBranch = {
    edgeKey: 'e-high',
    conjunction: 'and',
    rules: [{ fieldId: 'amount', operator: 'gte', value: 1000 }],
  }
  const branches = branchOrder[0] === 'mid' ? [midBranch, highBranch] : [highBranch, midBranch]
  return {
    id,
    title: id === 'condition' ? '条件分支优先级' : '条件分支优先级（对调）',
    graph: {
      nodes: [
        start(),
        {
          key: 'cond_1',
          type: 'condition',
          name: '金额判断',
          config: {
            branches,
            defaultEdgeKey: 'e-default',
          } satisfies ConditionNodeConfig,
        },
        // nodes array deliberately lists high before mid (opposite of default config order).
        approval('app_high', '高层审批', 'dept'),
        approval('app_mid', '中层审批', 'manager'),
        approval('app_default', '默认审批', 'role'),
        end(),
      ],
      edges: [
        edge('e-start-cond', 'start', 'cond_1'),
        edge('e-high', 'cond_1', 'app_high'),
        edge('e-mid', 'cond_1', 'app_mid'),
        edge('e-default', 'cond_1', 'app_default'),
        edge('e-high-end', 'app_high', 'end'),
        edge('e-mid-end', 'app_mid', 'end'),
        edge('e-default-end', 'app_default', 'end'),
      ],
    },
    branchDisplayLabels: {
      'e-mid': '金额大于等于一百',
      'e-high': '金额大于等于一千',
      'e-default': '默认分支（其他情况）',
    },
  }
}

export const FIXTURE_CONDITION = buildConditionFixture('condition', ['mid', 'high'])
export const FIXTURE_CONDITION_PRIORITY_SWAPPED = buildConditionFixture('condition-priority-swapped', [
  'high',
  'mid',
])

/**
 * Parallel with ≥3 branches, one nested condition inside a branch, no nested parallel.
 * joinMode variant controlled by argument.
 */
function buildParallelFixture(id: 'parallel-all' | 'parallel-any', joinMode: 'all' | 'any'): E1Fixture {
  return {
    id,
    title: joinMode === 'all' ? '并行全部完成' : '并行任一完成',
    graph: {
      nodes: [
        start(),
        {
          key: 'parallel_1',
          type: 'parallel',
          name: '多部门会签',
          config: {
            // Config order is C → A → B; nodes[] later lists A,B,C differently.
            branches: ['e-fork-c', 'e-fork-a', 'e-fork-b'],
            joinMode,
            joinNodeKey: 'join_1',
          } satisfies ParallelNodeConfig,
        },
        approval('app_a', '财务审批', 'role'),
        approval('app_b', '法务审批', 'dept'),
        // Branch C hosts a nested condition (allowed); no nested parallel.
        {
          key: 'cond_nested',
          type: 'condition',
          name: '紧急程度',
          config: {
            branches: [
              {
                edgeKey: 'e-urgent',
                rules: [{ fieldId: 'urgent', operator: 'eq', value: true }],
              },
              {
                edgeKey: 'e-normal',
                rules: [{ fieldId: 'urgent', operator: 'eq', value: false }],
              },
            ],
            defaultEdgeKey: 'e-cond-default',
          } satisfies ConditionNodeConfig,
        },
        approval('app_urgent', '加急处理', 'manager'),
        approval('app_normal', '常规处理', 'requester'),
        approval('app_cond_default', '其他处理', 'users'),
        { key: 'join_1', type: 'approval', name: '汇总合并', config: { approvalMode: 'single', assigneeSources: [{ kind: 'requester' }] } },
        end(),
      ],
      edges: [
        edge('e-start-p', 'start', 'parallel_1'),
        edge('e-fork-a', 'parallel_1', 'app_a'),
        edge('e-fork-b', 'parallel_1', 'app_b'),
        edge('e-fork-c', 'parallel_1', 'cond_nested'),
        edge('e-a-join', 'app_a', 'join_1'),
        edge('e-b-join', 'app_b', 'join_1'),
        edge('e-urgent', 'cond_nested', 'app_urgent'),
        edge('e-normal', 'cond_nested', 'app_normal'),
        edge('e-cond-default', 'cond_nested', 'app_cond_default'),
        edge('e-urgent-join', 'app_urgent', 'join_1'),
        edge('e-normal-join', 'app_normal', 'join_1'),
        edge('e-cond-default-join', 'app_cond_default', 'join_1'),
        edge('e-join-end', 'join_1', 'end'),
      ],
    },
    branchDisplayLabels: {
      'e-fork-a': '财务分支',
      'e-fork-b': '法务分支',
      'e-fork-c': '紧急判断分支',
      'e-urgent': '加急',
      'e-normal': '常规',
      'e-cond-default': '默认分支（其他情况）',
    },
  }
}

export const FIXTURE_PARALLEL_ALL = buildParallelFixture('parallel-all', 'all')
export const FIXTURE_PARALLEL_ANY = buildParallelFixture('parallel-any', 'any')

// Exactly 80 / 40 CJK characters for the long-label fixture (code-point length).
const LONG_NODE_80 = `${'超长节点名称截断验证文案'.repeat(8)}`.slice(0, 80) // 10*8=80
const LONG_BRANCH_40 = `${'超长分支标签截断验证'.repeat(4)}`.slice(0, 40) // 10*4=40

export const FIXTURE_LONG_LABELS: E1Fixture = {
  id: 'long-labels',
  title: '超长文案',
  graph: {
    nodes: [
      start(),
      {
        key: 'approval_long',
        type: 'approval',
        name: LONG_NODE_80,
        config: {
          assigneeSources: [
            { kind: 'static_user', userIds: ['u1', 'u2', 'u3'] },
            { kind: 'static_role', roleIds: ['finance', 'legal'] },
            { kind: 'direct_manager' },
          ],
          approvalMode: 'all',
          emptyAssigneePolicy: 'error',
        },
      },
      {
        key: 'cond_long',
        type: 'condition',
        name: '长分支名条件',
        config: {
          branches: [
            {
              edgeKey: 'e-long-a',
              rules: [{ fieldId: 'amount', operator: 'gt', value: 1 }],
            },
            {
              edgeKey: 'e-long-b',
              rules: [{ fieldId: 'amount', operator: 'gt', value: 2 }],
            },
          ],
          defaultEdgeKey: 'e-long-default',
        },
      },
      approval('app_la', '分支甲审批', 'manager'),
      approval('app_lb', '分支乙审批', 'dept'),
      approval('app_ld', '默认审批', 'role'),
      end(),
    ],
    edges: [
      edge('e-start-long', 'start', 'approval_long'),
      edge('e-long-cond', 'approval_long', 'cond_long'),
      edge('e-long-a', 'cond_long', 'app_la'),
      edge('e-long-b', 'cond_long', 'app_lb'),
      edge('e-long-default', 'cond_long', 'app_ld'),
      edge('e-la-end', 'app_la', 'end'),
      edge('e-lb-end', 'app_lb', 'end'),
      edge('e-ld-end', 'app_ld', 'end'),
    ],
  },
  branchDisplayLabels: {
    'e-long-a': LONG_BRANCH_40,
    'e-long-b': `${'另一超长分支标签截断'.repeat(4)}`.slice(0, 40),
    'e-long-default': '默认分支（其他情况）',
  },
}

/** Unknown legacy config keys → read-only fidelity surface. */
export const FIXTURE_READONLY_LEGACY: E1Fixture = {
  id: 'readonly-legacy',
  title: '旧版未知配置（只读）',
  readOnly: true,
  readOnlyReason: '包含当前版本无法安全编辑的历史配置，已切换为只读以保护原文。',
  graph: {
    nodes: [
      start(),
      {
        key: 'approval_legacy',
        type: 'approval',
        name: '历史审批',
        config: {
          assigneeSources: [{ kind: 'direct_manager' }],
          approvalMode: 'single',
          emptyAssigneePolicy: 'error',
          // Unknown forward-compat field — must never be flattened by the spike.
          legacyHandlerProfile: { version: 3, opaque: true },
        } as ApprovalNode['config'],
      },
      end(),
    ],
    edges: [
      edge('e-start-legacy', 'start', 'approval_legacy'),
      edge('e-legacy-end', 'approval_legacy', 'end'),
    ],
  },
}

/** timeout present → read-only fidelity for this spike. */
export const FIXTURE_READONLY_TIMEOUT: E1Fixture = {
  id: 'readonly-timeout',
  title: '超时策略（只读）',
  readOnly: true,
  readOnlyReason: '节点含超时策略，本 spike 只读展示以验证保真，不提供就地编辑。',
  graph: {
    nodes: [
      start(),
      {
        key: 'approval_timeout',
        type: 'approval',
        name: '限时审批',
        config: {
          assigneeSources: [{ kind: 'dept_head' }],
          approvalMode: 'single',
          emptyAssigneePolicy: 'error',
          timeout: { durationHours: 24, action: 'remind' },
        } as ApprovalNode['config'],
      },
      end(),
    ],
    edges: [
      edge('e-start-timeout', 'start', 'approval_timeout'),
      edge('e-timeout-end', 'approval_timeout', 'end'),
    ],
  },
}

/** approvalThreshold present → read-only fidelity for this spike. */
export const FIXTURE_READONLY_THRESHOLD: E1Fixture = {
  id: 'readonly-threshold',
  title: '通过阈值（只读）',
  readOnly: true,
  readOnlyReason: '节点含通过阈值策略，本 spike 只读展示以验证保真，不提供就地编辑。',
  graph: {
    nodes: [
      start(),
      {
        key: 'approval_threshold',
        type: 'approval',
        name: '会签阈值',
        config: {
          assigneeSources: [{ kind: 'static_user', userIds: ['u1', 'u2', 'u3', 'u4'] }],
          approvalMode: 'all',
          emptyAssigneePolicy: 'error',
          approvalThreshold: { type: 'count', value: 2 },
        } as ApprovalNode['config'],
      },
      end(),
    ],
    edges: [
      edge('e-start-threshold', 'start', 'approval_threshold'),
      edge('e-threshold-end', 'approval_threshold', 'end'),
    ],
  },
}

/** 100-node mixed vertical tree (linear spine + a few gateways). */
function buildMixed100(): E1Fixture {
  const nodes: ApprovalNode[] = [start()]
  const edges: ApprovalEdge[] = []
  let prev = 'start'
  let nodeCount = 1 // start

  // Build until we have exactly 100 nodes including end.
  // Pattern every 12 steps: insert a small condition fan-out (3 branches) then continue.
  let serial = 0
  while (nodeCount < 99) {
    serial += 1
    if (serial % 12 === 0 && nodeCount + 5 <= 99) {
      const condKey = `cond_${serial}`
      const aKey = `a_${serial}`
      const bKey = `b_${serial}`
      const dKey = `d_${serial}`
      const joinKey = `j_${serial}`
      nodes.push({
        key: condKey,
        type: 'condition',
        name: `条件 ${serial}`,
        config: {
          branches: [
            { edgeKey: `e-${condKey}-a`, rules: [{ fieldId: 'amount', operator: 'gt', value: serial }] },
            { edgeKey: `e-${condKey}-b`, rules: [{ fieldId: 'amount', operator: 'lt', value: serial }] },
          ],
          defaultEdgeKey: `e-${condKey}-d`,
        },
      })
      nodes.push(approval(aKey, `分支甲 ${serial}`, 'manager'))
      nodes.push(approval(bKey, `分支乙 ${serial}`, 'dept'))
      nodes.push(approval(dKey, `默认 ${serial}`, 'role'))
      nodes.push(approval(joinKey, `汇合 ${serial}`, 'requester'))
      edges.push(edge(`e-${prev}-${condKey}`, prev, condKey))
      edges.push(edge(`e-${condKey}-a`, condKey, aKey))
      edges.push(edge(`e-${condKey}-b`, condKey, bKey))
      edges.push(edge(`e-${condKey}-d`, condKey, dKey))
      edges.push(edge(`e-${aKey}-${joinKey}`, aKey, joinKey))
      edges.push(edge(`e-${bKey}-${joinKey}`, bKey, joinKey))
      edges.push(edge(`e-${dKey}-${joinKey}`, dKey, joinKey))
      prev = joinKey
      nodeCount += 5
    } else if (serial % 17 === 0 && nodeCount + 5 <= 99) {
      const pKey = `p_${serial}`
      const xKey = `x_${serial}`
      const yKey = `y_${serial}`
      const zKey = `z_${serial}`
      const joinKey = `pj_${serial}`
      nodes.push({
        key: pKey,
        type: 'parallel',
        name: `并行 ${serial}`,
        config: {
          branches: [`e-${pKey}-x`, `e-${pKey}-y`, `e-${pKey}-z`],
          joinMode: serial % 2 === 0 ? 'all' : 'any',
          joinNodeKey: joinKey,
        },
      })
      nodes.push(approval(xKey, `并行甲 ${serial}`, 'manager'))
      nodes.push(approval(yKey, `并行乙 ${serial}`, 'dept'))
      nodes.push(approval(zKey, `并行丙 ${serial}`, 'role'))
      nodes.push(approval(joinKey, `并行合并 ${serial}`, 'requester'))
      edges.push(edge(`e-${prev}-${pKey}`, prev, pKey))
      edges.push(edge(`e-${pKey}-x`, pKey, xKey))
      edges.push(edge(`e-${pKey}-y`, pKey, yKey))
      edges.push(edge(`e-${pKey}-z`, pKey, zKey))
      edges.push(edge(`e-${xKey}-${joinKey}`, xKey, joinKey))
      edges.push(edge(`e-${yKey}-${joinKey}`, yKey, joinKey))
      edges.push(edge(`e-${zKey}-${joinKey}`, zKey, joinKey))
      prev = joinKey
      nodeCount += 5
    } else {
      const key = `n_${serial}`
      const kind = serial % 5 === 0 ? 'cc' : 'approval'
      if (kind === 'cc') {
        nodes.push(cc(key, `抄送 ${serial}`))
      } else {
        nodes.push(approval(key, `审批 ${serial}`, serial % 3 === 0 ? 'dept' : 'manager'))
      }
      edges.push(edge(`e-${prev}-${key}`, prev, key))
      prev = key
      nodeCount += 1
    }
  }

  nodes.push(end())
  edges.push(edge(`e-${prev}-end`, prev, 'end'))
  nodeCount += 1

  if (nodes.length !== 100) {
    // Pad or trim is unexpected; keep honest for the harness.
    // eslint-disable-next-line no-console
    console.warn(`[e1-fixtures] mixed-100 produced ${nodes.length} nodes`)
  }

  return {
    id: 'mixed-100',
    title: '百节点混合图',
    graph: { nodes, edges },
  }
}

export const FIXTURE_MIXED_100 = buildMixed100()

export const ALL_FIXTURES: E1Fixture[] = [
  FIXTURE_LINEAR,
  FIXTURE_CONDITION,
  FIXTURE_CONDITION_PRIORITY_SWAPPED,
  FIXTURE_PARALLEL_ALL,
  FIXTURE_PARALLEL_ANY,
  FIXTURE_LONG_LABELS,
  FIXTURE_READONLY_LEGACY,
  FIXTURE_READONLY_TIMEOUT,
  FIXTURE_READONLY_THRESHOLD,
  FIXTURE_MIXED_100,
]

export function getFixture(id: E1FixtureId): E1Fixture {
  const found = ALL_FIXTURES.find((fixture) => fixture.id === id)
  if (!found) throw new Error(`Unknown E1 fixture: ${id}`)
  return found
}

/** Every internal token that must never appear in DOM text / aria-label / title. */
export function collectInternalTokens(graph: ApprovalGraph): string[] {
  const tokens = new Set<string>()
  for (const node of graph.nodes) {
    tokens.add(node.key)
  }
  for (const edgeItem of graph.edges) {
    tokens.add(edgeItem.key)
    tokens.add(`${edgeItem.source} -> ${edgeItem.target}`)
    tokens.add(`${edgeItem.source}->${edgeItem.target}`)
  }
  return [...tokens]
}
