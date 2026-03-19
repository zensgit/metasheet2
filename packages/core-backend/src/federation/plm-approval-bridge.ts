export interface PlmApprovalBridgeSource {
  id: string
  title?: string
  status?: string
  type?: string
  stage?: string
  product_id?: string
  product_number?: string
  product_name?: string
  requester_id?: string
  requester_name?: string
  created_at?: string
  updated_at?: string
}

export interface PlatformApprovalBridgeRecord {
  externalSystem: 'plm'
  externalApprovalId: string
  businessKey: string
  workflowKey: string
  title: string
  status: string
  subject: {
    productId?: string
    productNumber?: string
    productName?: string
  }
  requester: {
    id?: string
    name?: string
  }
  policy: {
    rejectCommentRequired: boolean
    sourceOfTruth: 'plm'
  }
  metadata: Record<string, unknown>
}

const DEFAULT_WORKFLOW_KEY = 'plm-eco-review'

function normalizeStatus(value: string | undefined): string {
  const normalized = String(value || '').trim().toLowerCase()
  if (!normalized) return 'pending'
  if (normalized === 'approved' || normalized === 'rejected' || normalized === 'pending') {
    return normalized
  }
  return normalized
}

export function toPlatformApprovalBridgeRecord(
  source: PlmApprovalBridgeSource,
): PlatformApprovalBridgeRecord {
  const approvalId = String(source.id || '').trim()
  if (!approvalId) {
    throw new Error('PLM approval bridge requires a source id')
  }

  const productId = source.product_id ? String(source.product_id) : undefined
  const productNumber = source.product_number ? String(source.product_number) : undefined
  const productName = source.product_name ? String(source.product_name) : undefined

  return {
    externalSystem: 'plm',
    externalApprovalId: approvalId,
    businessKey: productId ? `plm:product:${productId}` : `plm:approval:${approvalId}`,
    workflowKey: DEFAULT_WORKFLOW_KEY,
    title: String(source.title || productNumber || approvalId),
    status: normalizeStatus(source.status),
    subject: {
      productId,
      productNumber,
      productName,
    },
    requester: {
      id: source.requester_id ? String(source.requester_id) : undefined,
      name: source.requester_name ? String(source.requester_name) : undefined,
    },
    policy: {
      rejectCommentRequired: true,
      sourceOfTruth: 'plm',
    },
    metadata: {
      source_type: source.type || 'eco',
      source_stage: source.stage || 'review',
      created_at: source.created_at,
      updated_at: source.updated_at,
    },
  }
}

export function createPlmApprovalBridgePreview(source: PlmApprovalBridgeSource) {
  const record = toPlatformApprovalBridgeRecord(source)
  return {
    key: `${record.externalSystem}:${record.externalApprovalId}`,
    workflowKey: record.workflowKey,
    businessKey: record.businessKey,
    title: record.title,
    status: record.status,
    subjectLabel: [record.subject.productNumber, record.subject.productName].filter(Boolean).join(' / ') || record.title,
    requesterLabel: record.requester.name || record.requester.id || '-',
    policy: record.policy,
  }
}
