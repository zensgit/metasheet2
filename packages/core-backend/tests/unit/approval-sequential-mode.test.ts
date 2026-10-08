import { describe, expect, it } from 'vitest'
import {
  applySequentialQueueMetadata,
  inheritSequentialQueueMetadata,
  promoteNextSequentialQueueAssignment,
  readSequentialQueueMetadata,
} from '../../src/services/approval-sequential-mode'
import {
  isOperationAllowedAtNode,
  resolveEffectiveNodeOperations,
} from '../../src/services/approval-effective-node-operations'

const assignments = [
  { assignmentType: 'user' as const, assigneeId: 'u-b', nodeKey: 'review', sourceStep: 1 },
  { assignmentType: 'user' as const, assigneeId: 'u-a', nodeKey: 'review', sourceStep: 1 },
  { assignmentType: 'role' as const, assigneeId: 'finance', nodeKey: 'review', sourceStep: 1 },
]

describe('approval sequential mode', () => {
  it('stamps resolver order without sorting and activates only the first seat (G-15)', () => {
    expect(applySequentialQueueMetadata(assignments, 'sequential')).toEqual([
      expect.objectContaining({ assigneeId: 'u-b', metadata: { sequentialQueue: { position: 1, length: 3, state: 'active' } } }),
      expect.objectContaining({ assigneeId: 'u-a', metadata: { sequentialQueue: { position: 2, length: 3, state: 'queued' } } }),
      expect.objectContaining({ assigneeId: 'finance', metadata: { sequentialQueue: { position: 3, length: 3, state: 'queued' } } }),
    ])

    expect(applySequentialQueueMetadata(assignments, 'all')).toEqual(assignments)
  })

  it('parses persisted queue metadata without coercion', () => {
    expect(readSequentialQueueMetadata({ sequentialQueue: { position: 1, length: 2, state: 'active' } }))
      .toEqual({ position: 1, length: 2, state: 'active' })
    for (const invalid of [
      null,
      { sequentialQueue: { position: '1', length: 2, state: 'active' } },
      { sequentialQueue: { position: 0, length: 2, state: 'active' } },
      { sequentialQueue: { position: 3, length: 2, state: 'queued' } },
      { sequentialQueue: { position: 1, length: 2, state: 'waiting' } },
    ]) {
      expect(readSequentialQueueMetadata(invalid)).toBeNull()
    }
  })

  it('promotes the next contiguous queued seat and rejects incomplete or duplicate queues', () => {
    const queued = applySequentialQueueMetadata(assignments, 'sequential').slice(1).map((assignment) => ({
      ...assignment,
      metadata: {
        ...assignment.metadata,
        sequentialQueue: { ...assignment.metadata.sequentialQueue, state: 'queued' as const },
      },
    }))
    expect(promoteNextSequentialQueueAssignment(queued)).toEqual([
      expect.objectContaining({ assigneeId: 'u-a', metadata: { sequentialQueue: { position: 2, length: 3, state: 'active' } } }),
      expect.objectContaining({ assigneeId: 'finance', metadata: { sequentialQueue: { position: 3, length: 3, state: 'queued' } } }),
    ])
    expect(promoteNextSequentialQueueAssignment([queued[1]])).toEqual([
      expect.objectContaining({ assigneeId: 'finance', metadata: { sequentialQueue: { position: 3, length: 3, state: 'active' } } }),
    ])
    expect(promoteNextSequentialQueueAssignment([{ ...queued[0], metadata: { sequentialQueue: { position: 1, length: 3, state: 'queued' } } }])).toBeNull()
    expect(promoteNextSequentialQueueAssignment([queued[0], { ...queued[1], metadata: queued[0].metadata }])).toBeNull()
  })

  it('carries exactly one active queue slot across a handover and rejects malformed sources', () => {
    const active = { sequentialQueue: { position: 2, length: 3, state: 'active' } }
    expect(inheritSequentialQueueMetadata([active], { adminReassign: true })).toEqual({
      adminReassign: true,
      sequentialQueue: active.sequentialQueue,
    })
    expect(inheritSequentialQueueMetadata([{}], { adminReassign: true })).toEqual({ adminReassign: true })
    expect(inheritSequentialQueueMetadata([
      active,
      { sequentialQueue: { position: 3, length: 3, state: 'active' } },
    ])).toBeNull()
    expect(inheritSequentialQueueMetadata([active, {}], { adminReassign: true })).toBeNull()
    expect(inheritSequentialQueueMetadata([
      { sequentialQueue: { position: 2, length: 3, state: 'queued' } },
    ])).toBeNull()
    expect(inheritSequentialQueueMetadata([
      { sequentialQueue: { position: '2', length: 3, state: 'active' } },
    ])).toBeNull()
  })

  it('keeps transfer and return but denies add/reduce sign for a sequential node', () => {
    const graph = {
      nodes: [{ key: 'review', config: { approvalMode: 'sequential' } }],
    }
    expect(isOperationAllowedAtNode(graph, 'review', 'allowTransfer')).toBe(true)
    expect(isOperationAllowedAtNode(graph, 'review', 'allowReturn')).toBe(true)
    expect(isOperationAllowedAtNode(graph, 'review', 'allowAddSign')).toBe(false)
    expect(isOperationAllowedAtNode(graph, 'review', 'allowReduceSign')).toBe(false)
    expect(resolveEffectiveNodeOperations(graph, ['review'], {})).toMatchObject({
      allowTransfer: true,
      allowAddSign: false,
      allowReduceSign: false,
      allowReturn: true,
    })
  })
})
