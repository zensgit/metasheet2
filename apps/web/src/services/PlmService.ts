import { localizedPlmFederationClient as plmClient } from './plm/plmFederationClient'

export type PlmListResponse<T = Record<string, unknown>> = {
  items: T[]
  total?: number
  limit?: number
  offset?: number
}

export interface SearchProductsParams {
  query?: string
  itemType?: string
  limit?: number
  offset?: number
}

export interface GetProductParams {
  itemType?: string
  itemNumber?: string
}

export interface GetBomParams {
  depth?: number
  effectiveAt?: string
}

export interface ListDocumentsParams {
  productId: string
  role?: string
}

export interface ListApprovalsParams {
  productId?: string
  status?: string
}

export interface WhereUsedParams {
  itemId: string
  recursive?: boolean
  maxLevels?: number
}

export interface BomCompareParams {
  leftId: string
  rightId: string
  leftType?: 'item' | 'version'
  rightType?: 'item' | 'version'
  maxLevels?: number
  compareMode?: string
  lineKey?: string
  includeChildFields?: boolean
  includeSubstitutes?: boolean
  includeEffectivity?: boolean
  includeRelationshipProps?: string[]
  effectiveAt?: string
}

export interface AddSubstituteParams {
  bomLineId: string
  substituteItemId: string
  properties?: Record<string, unknown>
}

export interface RemoveSubstituteParams {
  bomLineId: string
  substituteId: string
}

export interface CadDiffParams {
  fileId: string
  otherFileId: string
}

export interface UpdateCadPayload {
  fileId: string
  payload: Record<string, unknown>
}

export interface ApprovalActionParams {
  approvalId: string
  version: number
  comment?: string
  reason?: string
}

class PlmService {
  async searchProducts<T = Record<string, unknown>>(params: SearchProductsParams): Promise<PlmListResponse<T>> {
    return plmClient.listProducts<T>({
      query: params.query,
      itemType: params.itemType,
      limit: params.limit ?? 10,
      offset: params.offset ?? 0,
    })
  }

  async getProduct<T = Record<string, unknown>>(id: string, params: GetProductParams = {}): Promise<T> {
    return plmClient.getProduct<T>(id, {
      itemType: params.itemType,
      itemNumber: params.itemNumber,
    })
  }

  async getBom<T = Record<string, unknown>>(productId: string, params: GetBomParams = {}): Promise<PlmListResponse<T>> {
    return plmClient.getBom<T>(productId, {
      depth: params.depth,
      effectiveAt: params.effectiveAt,
    })
  }

  async listDocuments<T = Record<string, unknown>>(params: ListDocumentsParams): Promise<PlmListResponse<T>> {
    return plmClient.listDocuments<T>({
      productId: params.productId,
      role: params.role,
      limit: 100,
      offset: 0,
    })
  }

  async getCadProperties<T = Record<string, unknown>>(fileId: string): Promise<T> {
    return plmClient.getCadProperties<T>(fileId)
  }

  async getCadViewState<T = Record<string, unknown>>(fileId: string): Promise<T> {
    return plmClient.getCadViewState<T>(fileId)
  }

  async getCadReview<T = Record<string, unknown>>(fileId: string): Promise<T> {
    return plmClient.getCadReview<T>(fileId)
  }

  async getCadHistory<T = Record<string, unknown>>(fileId: string): Promise<T> {
    return plmClient.getCadHistory<T>(fileId)
  }

  async getCadMeshStats<T = Record<string, unknown>>(fileId: string): Promise<T> {
    return plmClient.getCadMeshStats<T>(fileId)
  }

  async getCadDiff<T = Record<string, unknown>>(params: CadDiffParams): Promise<T> {
    return plmClient.getCadDiff<T>({
      fileId: params.fileId,
      otherFileId: params.otherFileId,
    })
  }

  async updateCadProperties<T = Record<string, unknown>>(params: UpdateCadPayload): Promise<T> {
    return plmClient.updateCadProperties<T>({
      fileId: params.fileId,
      payload: params.payload,
    })
  }

  async updateCadViewState<T = Record<string, unknown>>(params: UpdateCadPayload): Promise<T> {
    return plmClient.updateCadViewState<T>({
      fileId: params.fileId,
      payload: params.payload,
    })
  }

  async updateCadReview<T = Record<string, unknown>>(params: UpdateCadPayload): Promise<T> {
    return plmClient.updateCadReview<T>({
      fileId: params.fileId,
      payload: params.payload,
    })
  }

  async listApprovals<T = Record<string, unknown>>(params: ListApprovalsParams = {}): Promise<PlmListResponse<T>> {
    return plmClient.listApprovals<T>({
      productId: params.productId,
      status: params.status,
      limit: 100,
      offset: 0,
    })
  }

  async getApprovalHistory<T = Record<string, unknown>>(approvalId: string): Promise<{ items?: T[] }> {
    return plmClient.getApprovalHistory<T>(approvalId)
  }

  async approveApproval<T = Record<string, unknown>>(params: ApprovalActionParams): Promise<T> {
    return plmClient.approveApproval<T>({
      approvalId: params.approvalId,
      version: params.version,
      comment: params.comment,
    })
  }

  async rejectApproval<T = Record<string, unknown>>(params: ApprovalActionParams): Promise<T> {
    return plmClient.rejectApproval<T>({
      approvalId: params.approvalId,
      version: params.version,
      reason: params.reason,
      comment: params.comment,
    })
  }

  async getWhereUsed<T = Record<string, unknown>>(params: WhereUsedParams): Promise<T> {
    return plmClient.getWhereUsed<T>({
      itemId: params.itemId,
      recursive: params.recursive,
      maxLevels: params.maxLevels,
    })
  }

  async getBomCompareSchema<T = Record<string, unknown>>(): Promise<T> {
    return plmClient.getBomCompareSchema<T>()
  }

  async getBomCompare<T = Record<string, unknown>>(params: BomCompareParams): Promise<T> {
    return plmClient.compareBom<T>({
      leftId: params.leftId,
      rightId: params.rightId,
      leftType: params.leftType ?? 'item',
      rightType: params.rightType ?? 'item',
      maxLevels: params.maxLevels,
      compareMode: params.compareMode,
      lineKey: params.lineKey,
      includeChildFields: params.includeChildFields,
      includeSubstitutes: params.includeSubstitutes,
      includeEffectivity: params.includeEffectivity,
      includeRelationshipProps: params.includeRelationshipProps,
      effectiveAt: params.effectiveAt,
    })
  }

  async listSubstitutes<T = Record<string, unknown>>(bomLineId: string): Promise<T> {
    return plmClient.listSubstitutes<T>(bomLineId)
  }

  async addSubstitute<T = Record<string, unknown>>(params: AddSubstituteParams): Promise<T> {
    return plmClient.addSubstitute<T>({
      bomLineId: params.bomLineId,
      substituteItemId: params.substituteItemId,
      properties: params.properties,
    })
  }

  async removeSubstitute<T = Record<string, unknown>>(params: RemoveSubstituteParams): Promise<T> {
    return plmClient.removeSubstitute<T>({
      bomLineId: params.bomLineId,
      substituteId: params.substituteId,
    })
  }
}

export const plmService = new PlmService()
