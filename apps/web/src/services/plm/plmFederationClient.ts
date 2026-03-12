import {
  createPlmFederationClient,
  type ClientResponse,
  type RequestClient,
} from '@metasheet/sdk/client'
import { apiGet, apiPost } from '../../utils/api'

type LocalizedFallback = {
  english: string
  localized: string
}

type LocalizedFallbackKey =
  | 'listProducts'
  | 'getProduct'
  | 'getBom'
  | 'listDocuments'
  | 'getCadProperties'
  | 'getCadViewState'
  | 'getCadReview'
  | 'getCadHistory'
  | 'getCadMeshStats'
  | 'getCadDiff'
  | 'updateCadProperties'
  | 'updateCadViewState'
  | 'updateCadReview'
  | 'listApprovals'
  | 'getApprovalHistory'
  | 'approveApproval'
  | 'rejectApproval'
  | 'getWhereUsed'
  | 'getBomCompareSchema'
  | 'compareBom'
  | 'listSubstitutes'
  | 'addSubstitute'
  | 'removeSubstitute'

const LOCALIZED_FALLBACKS: Record<LocalizedFallbackKey, LocalizedFallback> = {
  listProducts: { english: 'Failed to load PLM products', localized: '搜索失败' },
  getProduct: { english: 'Failed to load PLM product', localized: '加载产品失败' },
  getBom: { english: 'Failed to load PLM BOM', localized: '加载 BOM 失败' },
  listDocuments: { english: 'Failed to load PLM documents', localized: '加载文档失败' },
  getCadProperties: { english: 'Failed to load PLM CAD properties', localized: '加载属性失败' },
  getCadViewState: { english: 'Failed to load PLM CAD view state', localized: '加载视图状态失败' },
  getCadReview: { english: 'Failed to load PLM CAD review', localized: '加载评审失败' },
  getCadHistory: { english: 'Failed to load PLM CAD history', localized: '加载历史失败' },
  getCadMeshStats: { english: 'Failed to load PLM CAD mesh stats', localized: '加载网格统计失败' },
  getCadDiff: { english: 'Failed to load PLM CAD diff', localized: '加载差异失败' },
  updateCadProperties: { english: 'Failed to update PLM CAD properties', localized: '更新属性失败' },
  updateCadViewState: { english: 'Failed to update PLM CAD view state', localized: '更新视图状态失败' },
  updateCadReview: { english: 'Failed to update PLM CAD review', localized: '提交评审失败' },
  listApprovals: { english: 'Failed to load PLM approvals', localized: '加载审批失败' },
  getApprovalHistory: { english: 'Failed to load PLM approval history', localized: '加载审批记录失败' },
  approveApproval: { english: 'Failed to approve PLM approval', localized: '审批通过失败' },
  rejectApproval: { english: 'Failed to reject PLM approval', localized: '审批拒绝失败' },
  getWhereUsed: { english: 'Failed to load PLM where-used data', localized: '查询 where-used 失败' },
  getBomCompareSchema: { english: 'Failed to load PLM BOM compare schema', localized: '加载 BOM 对比字段失败' },
  compareBom: { english: 'Failed to compare PLM BOMs', localized: 'BOM 对比失败' },
  listSubstitutes: { english: 'Failed to load PLM substitutes', localized: '查询替代件失败' },
  addSubstitute: { english: 'Failed to add PLM substitute', localized: '新增替代件失败' },
  removeSubstitute: { english: 'Failed to remove PLM substitute', localized: '删除替代件失败' },
}

const request = async <T = unknown>(
  method: string,
  path: string,
  body?: unknown,
): Promise<ClientResponse<T>> => {
  if (method === 'GET') {
    return {
      status: 200,
      json: await apiGet<T>(path),
    }
  }
  if (method === 'POST') {
    return {
      status: 200,
      json: await apiPost<T>(path, body),
    }
  }
  throw new Error(`Unsupported PLM request method: ${method}`)
}

async function withLocalizedFallback<T>(
  key: LocalizedFallbackKey,
  action: Promise<T>,
): Promise<T> {
  try {
    return await action
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    const fallback = LOCALIZED_FALLBACKS[key]
    if (!message || message === fallback.english) {
      throw new Error(fallback.localized)
    }
    throw error
  }
}

export const plmRequestClient = {
  request,
  requestWithRetry: request,
} satisfies RequestClient

export function createLocalizedPlmFederationClient(client: RequestClient = plmRequestClient) {
  const rawClient = createPlmFederationClient(client)

  return {
    listProducts: <T = Record<string, unknown>>(params?: Parameters<typeof rawClient.listProducts<T>>[0]) =>
      withLocalizedFallback('listProducts', rawClient.listProducts<T>(params)),
    getProduct: <T = Record<string, unknown>>(productId: string, params?: Parameters<typeof rawClient.getProduct<T>>[1]) =>
      withLocalizedFallback('getProduct', rawClient.getProduct<T>(productId, params)),
    getBom: <T = Record<string, unknown>>(productId: string, params?: Parameters<typeof rawClient.getBom<T>>[1]) =>
      withLocalizedFallback('getBom', rawClient.getBom<T>(productId, params)),
    listDocuments: <T = Record<string, unknown>>(params: Parameters<typeof rawClient.listDocuments<T>>[0]) =>
      withLocalizedFallback('listDocuments', rawClient.listDocuments<T>(params)),
    getCadProperties: <T = Record<string, unknown>>(fileId: string) =>
      withLocalizedFallback('getCadProperties', rawClient.getCadProperties<T>(fileId)),
    getCadViewState: <T = Record<string, unknown>>(fileId: string) =>
      withLocalizedFallback('getCadViewState', rawClient.getCadViewState<T>(fileId)),
    getCadReview: <T = Record<string, unknown>>(fileId: string) =>
      withLocalizedFallback('getCadReview', rawClient.getCadReview<T>(fileId)),
    getCadHistory: <T = Record<string, unknown>>(fileId: string) =>
      withLocalizedFallback('getCadHistory', rawClient.getCadHistory<T>(fileId)),
    getCadMeshStats: <T = Record<string, unknown>>(fileId: string) =>
      withLocalizedFallback('getCadMeshStats', rawClient.getCadMeshStats<T>(fileId)),
    getCadDiff: <T = Record<string, unknown>>(params: Parameters<typeof rawClient.getCadDiff<T>>[0]) =>
      withLocalizedFallback('getCadDiff', rawClient.getCadDiff<T>(params)),
    updateCadProperties: <T = Record<string, unknown>>(params: Parameters<typeof rawClient.updateCadProperties<T>>[0]) =>
      withLocalizedFallback('updateCadProperties', rawClient.updateCadProperties<T>(params)),
    updateCadViewState: <T = Record<string, unknown>>(params: Parameters<typeof rawClient.updateCadViewState<T>>[0]) =>
      withLocalizedFallback('updateCadViewState', rawClient.updateCadViewState<T>(params)),
    updateCadReview: <T = Record<string, unknown>>(params: Parameters<typeof rawClient.updateCadReview<T>>[0]) =>
      withLocalizedFallback('updateCadReview', rawClient.updateCadReview<T>(params)),
    listApprovals: <T = Record<string, unknown>>(params?: Parameters<typeof rawClient.listApprovals<T>>[0]) =>
      withLocalizedFallback('listApprovals', rawClient.listApprovals<T>(params)),
    getApprovalHistory: <T = Record<string, unknown>>(approvalId: string) =>
      withLocalizedFallback('getApprovalHistory', rawClient.getApprovalHistory<T>(approvalId)),
    approveApproval: <T = Record<string, unknown>>(params: Parameters<typeof rawClient.approveApproval<T>>[0]) =>
      withLocalizedFallback('approveApproval', rawClient.approveApproval<T>(params)),
    rejectApproval: <T = Record<string, unknown>>(params: Parameters<typeof rawClient.rejectApproval<T>>[0]) =>
      withLocalizedFallback('rejectApproval', rawClient.rejectApproval<T>(params)),
    getWhereUsed: <T = Record<string, unknown>>(params: Parameters<typeof rawClient.getWhereUsed<T>>[0]) =>
      withLocalizedFallback('getWhereUsed', rawClient.getWhereUsed<T>(params)),
    getBomCompareSchema: <T = Record<string, unknown>>() =>
      withLocalizedFallback('getBomCompareSchema', rawClient.getBomCompareSchema<T>()),
    compareBom: <T = Record<string, unknown>>(params: Parameters<typeof rawClient.compareBom<T>>[0]) =>
      withLocalizedFallback('compareBom', rawClient.compareBom<T>(params)),
    listSubstitutes: <T = Record<string, unknown>>(bomLineId: string) =>
      withLocalizedFallback('listSubstitutes', rawClient.listSubstitutes<T>(bomLineId)),
    addSubstitute: <T = Record<string, unknown>>(params: Parameters<typeof rawClient.addSubstitute<T>>[0]) =>
      withLocalizedFallback('addSubstitute', rawClient.addSubstitute<T>(params)),
    removeSubstitute: <T = Record<string, unknown>>(params: Parameters<typeof rawClient.removeSubstitute<T>>[0]) =>
      withLocalizedFallback('removeSubstitute', rawClient.removeSubstitute<T>(params)),
  }
}

export const localizedPlmFederationClient = createLocalizedPlmFederationClient()
