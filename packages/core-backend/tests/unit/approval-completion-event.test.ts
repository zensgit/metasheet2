import { describe, expect, it, vi } from 'vitest'

import {
  approvalCompletionEventTypeForOutcome,
  buildApprovalCompletionEvent,
  emitApprovalCompletionEvent,
} from '../../src/services/ApprovalCompletionEvent'
import { eventBus } from '../../src/integration/events/event-bus'

describe('ApprovalCompletionEvent', () => {
  it('maps terminal outcomes to stable completion event types', () => {
    expect(approvalCompletionEventTypeForOutcome('approved')).toBe('approval.approved')
    expect(approvalCompletionEventTypeForOutcome('rejected')).toBe('approval.rejected')
    expect(approvalCompletionEventTypeForOutcome('revoked')).toBe('approval.revoked')
    expect(approvalCompletionEventTypeForOutcome('cancelled')).toBe('approval.cancelled')
  })

  it('builds a minimal v1 payload with stable identifiers and requester id only', () => {
    const event = buildApprovalCompletionEvent({
      occurredAt: new Date('2026-06-09T12:00:00.000Z'),
      instance: {
        id: 'apr-1',
        request_no: 'AP-100001',
        template_id: 'tpl-1',
        template_version_id: 'ver-1',
        published_definition_id: 'pub-1',
        business_key: 'travel-request',
        workflow_key: 'approval-product-template',
        requester_snapshot: {
          id: 'requester-1',
          name: 'Requester One',
          email: 'requester@example.test',
          department: 'Finance',
        },
      },
      transition: {
        action: 'approve',
        fromStatus: 'pending',
        toStatus: 'approved',
        fromVersion: 2,
        toVersion: 3,
        nodeKey: 'approval_1',
      },
      actor: {
        id: 'manager-1',
        name: 'Manager One',
      },
    })

    expect(event).toEqual({
      version: 1,
      eventId: 'approval:apr-1:3:approval.approved',
      eventType: 'approval.approved',
      occurredAt: '2026-06-09T12:00:00.000Z',
      source: 'approval-product',
      approval: {
        instanceId: 'apr-1',
        requestNo: 'AP-100001',
        templateId: 'tpl-1',
        templateVersionId: 'ver-1',
        publishedDefinitionId: 'pub-1',
        businessKey: 'travel-request',
        workflowKey: 'approval-product-template',
      },
      transition: {
        action: 'approve',
        fromStatus: 'pending',
        toStatus: 'approved',
        fromVersion: 2,
        toVersion: 3,
        nodeKey: 'approval_1',
      },
      actor: {
        id: 'manager-1',
        name: 'Manager One',
      },
      requester: {
        id: 'requester-1',
      },
    })

    const serialized = JSON.stringify(event)
    expect(serialized).not.toContain('requester@example.test')
    expect(serialized).not.toContain('Finance')
  })

  it('omits form, comment, and request transport data from rejected events', () => {
    const event = buildApprovalCompletionEvent({
      instance: {
        id: 'apr-sensitive',
        request_no: 'AP-100002',
        template_id: 'tpl-sensitive',
        template_version_id: 'ver-sensitive',
        published_definition_id: 'pub-sensitive',
        business_key: 'sensitive-business',
        workflow_key: 'approval-product-template',
        requester_snapshot: {
          id: 'requester-2',
          email: 'private@example.test',
        },
        // Extra fields can exist on row-shaped objects at runtime; the event
        // builder intentionally reads only its minimal allowlist.
        form_snapshot: {
          salary: 900000,
          token: 'secret-token',
        },
        comment: 'contains private rejection notes',
        ip: '203.0.113.55',
        user_agent: 'SensitiveBrowser/1.0',
      } as never,
      transition: {
        action: 'reject',
        fromStatus: 'pending',
        toStatus: 'rejected',
        fromVersion: 4,
        toVersion: 5,
        nodeKey: 'approval_2',
      },
      actor: {
        id: 'manager-2',
        name: null,
      },
      occurredAt: new Date('2026-06-09T12:01:00.000Z'),
    })

    expect(event.eventType).toBe('approval.rejected')
    expect(event.eventId).toBe('approval:apr-sensitive:5:approval.rejected')
    expect(event.actor).toEqual({ id: 'manager-2', name: null })
    expect(event.requester).toEqual({ id: 'requester-2' })
    const serialized = JSON.stringify(event)
    expect(serialized).not.toContain('private@example.test')
    expect(serialized).not.toContain('secret-token')
    expect(serialized).not.toContain('private rejection notes')
    expect(serialized).not.toContain('203.0.113.55')
    expect(serialized).not.toContain('SensitiveBrowser')
  })

  it('guards listener failures so approval flows can continue after commit', () => {
    const emitSpy = vi.spyOn(eventBus, 'emit').mockImplementation(() => {
      throw new Error('listener failed')
    })

    expect(() => emitApprovalCompletionEvent(buildApprovalCompletionEvent({
      instance: { id: 'apr-guarded' },
      transition: {
        action: 'revoke',
        fromStatus: 'pending',
        toStatus: 'revoked',
        fromVersion: 8,
        toVersion: 9,
        nodeKey: 'approval_1',
      },
    }))).not.toThrow()

    expect(emitSpy).toHaveBeenCalledWith(
      'approval.revoked',
      expect.objectContaining({
        eventId: 'approval:apr-guarded:9:approval.revoked',
      }),
    )
  })
})
