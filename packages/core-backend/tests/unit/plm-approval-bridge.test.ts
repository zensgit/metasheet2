import { describe, expect, it } from 'vitest'

import {
  createPlmApprovalBridgePreview,
  toPlatformApprovalBridgeRecord,
} from '../../src/federation/plm-approval-bridge'

describe('PLM approval bridge mapping', () => {
  it('maps a PLM approval into a platform approval bridge record', () => {
    const mapped = toPlatformApprovalBridgeRecord({
      id: 'eco-1001',
      title: 'ECO-1001',
      status: 'pending',
      product_id: 'prod-88',
      product_number: 'PN-88',
      product_name: 'Servo Housing',
      requester_id: 'user-1',
      requester_name: 'Adele',
      created_at: '2026-03-08T00:00:00.000Z',
    })

    expect(mapped).toEqual({
      externalSystem: 'plm',
      externalApprovalId: 'eco-1001',
      businessKey: 'plm:product:prod-88',
      workflowKey: 'plm-eco-review',
      title: 'ECO-1001',
      status: 'pending',
      subject: {
        productId: 'prod-88',
        productNumber: 'PN-88',
        productName: 'Servo Housing',
      },
      requester: {
        id: 'user-1',
        name: 'Adele',
      },
      policy: {
        rejectCommentRequired: true,
        sourceOfTruth: 'plm',
      },
      metadata: {
        source_type: 'eco',
        source_stage: 'review',
        created_at: '2026-03-08T00:00:00.000Z',
        updated_at: undefined,
      },
    })
  })

  it('builds a compact bridge preview for UI and bridge design docs', () => {
    const preview = createPlmApprovalBridgePreview({
      id: 'eco-1002',
      product_number: 'PN-89',
      product_name: 'Rotor',
      requester_id: 'user-2',
    })

    expect(preview).toEqual({
      key: 'plm:eco-1002',
      workflowKey: 'plm-eco-review',
      businessKey: 'plm:approval:eco-1002',
      title: 'PN-89',
      status: 'pending',
      subjectLabel: 'PN-89 / Rotor',
      requesterLabel: 'user-2',
      policy: {
        rejectCommentRequired: true,
        sourceOfTruth: 'plm',
      },
    })
  })

  it('requires a source id', () => {
    expect(() => toPlatformApprovalBridgeRecord({ id: '' })).toThrow('PLM approval bridge requires a source id')
  })

  // Wave 2 WP2 contract: the bridge must pin externalSystem='plm' on every
  // record because ApprovalBridgeService.upsertPlmMirror forwards this value
  // as the `source_system` column on INSERT. The unified Inbox filter
  // (sourceSystem=plm) relies on every bridged row carrying this literal.
  it('Wave 2 WP2: pins externalSystem to the "plm" literal for every bridged record', () => {
    const minimal = toPlatformApprovalBridgeRecord({ id: 'eco-wp2-min' })
    expect(minimal.externalSystem).toBe('plm')

    const complete = toPlatformApprovalBridgeRecord({
      id: 'eco-wp2-full',
      title: 'ECO-WP2',
      status: 'approved',
      type: 'eco',
      stage: 'review',
      product_id: 'prod-wp2',
      product_number: 'PN-WP2',
      product_name: 'Module',
      requester_id: 'user-wp2',
      requester_name: 'Tester',
      created_at: '2026-04-21T00:00:00.000Z',
      updated_at: '2026-04-21T01:00:00.000Z',
      version: 3,
    })
    expect(complete.externalSystem).toBe('plm')
    expect(complete.policy.sourceOfTruth).toBe('plm')
  })
})
