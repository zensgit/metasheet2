/**
 * 智能存储服务
 * 根据操作分类智能选择存储策略，优化存储空间
 */

import { OperationClassifier, OperationClass, ClassificationResult } from './OperationClassifier'
import { CompressionService } from './CompressionService'

export interface StorageResult {
  success: boolean
  historyId: string
  storageStrategy: string
  originalSize: number
  storedSize: number
  compressionRatio: number
  snapshotId?: string
}

export interface HistoryData {
  id?: string
  spreadsheetId: string
  operationType: string
  operatorId?: string
  operatorName?: string
  description?: string
  changes?: any[]
  snapshot?: any
  metadata?: any
  timestamp?: Date
}

export class IntelligentStorageService {
  private compressionService: CompressionService
  private storageMap: Map<string, HistoryData>

  constructor() {
    this.compressionService = new CompressionService()
    this.storageMap = new Map()
  }

  /**
   * 智能存储历史记录
   */
  async storeHistoryRecord(historyData: HistoryData): Promise<StorageResult> {
    try {
      // 估算数据大小
      const dataSize = OperationClassifier.estimateStorageSize(historyData)

      // 分类操作
      const classification = OperationClassifier.classify(
        historyData.operationType,
        historyData.changes?.length || 0,
        dataSize,
        historyData.metadata
      )

      console.log(`智能存储: ${historyData.operationType}
        分类: ${classification.class}
        策略: ${classification.storageStrategy}
        大小: ${dataSize} bytes`)

      // 根据分类选择存储策略
      let result: StorageResult

      switch (classification.storageStrategy) {
        case 'FULL':
          result = await this.storeFull(historyData, dataSize)
          break
        case 'COMPRESSED':
          result = await this.storeCompressed(historyData, dataSize, classification)
          break
        case 'SNAPSHOT_ONLY':
          result = await this.storeSnapshotOnly(historyData, dataSize, classification)
          break
        default:
          result = await this.storeFull(historyData, dataSize)
      }

      return result
    } catch (error) {
      console.error('智能存储失败:', error)
      // 降级到基础存储
      return await this.storeFull(historyData, 0)
    }
  }

  /**
   * 完整存储（轻量级操作）
   */
  private async storeFull(historyData: HistoryData, dataSize: number): Promise<StorageResult> {
    const historyId = this.generateId()

    // 直接存储到内存（实际应用中应存储到数据库）
    this.storageMap.set(historyId, {
      ...historyData,
      id: historyId,
      timestamp: new Date()
    })

    return {
      success: true,
      historyId,
      storageStrategy: 'FULL_DETAIL',
      originalSize: dataSize,
      storedSize: dataSize,
      compressionRatio: 100
    }
  }

  /**
   * 压缩存储（中等操作）
   */
  private async storeCompressed(
    historyData: HistoryData,
    dataSize: number,
    classification: ClassificationResult
  ): Promise<StorageResult> {
    const historyId = this.generateId()

    // 压缩数据
    const compressed = await this.compressionService.compress({
      changes: historyData.changes || [],
      snapshot: historyData.snapshot
    })

    // 存储压缩后的数据
    this.storageMap.set(historyId, {
      ...historyData,
      id: historyId,
      timestamp: new Date(),
      _compressed: true,
      _compressedData: compressed.data
    })

    return {
      success: true,
      historyId,
      storageStrategy: 'COMPRESSED_DETAIL',
      originalSize: compressed.originalSize,
      storedSize: compressed.compressedSize,
      compressionRatio: compressed.ratio
    }
  }

  /**
   * 仅快照存储（重量级操作）
   */
  private async storeSnapshotOnly(
    historyData: HistoryData,
    dataSize: number,
    classification: ClassificationResult
  ): Promise<StorageResult> {
    const historyId = this.generateId()
    const snapshotId = `snapshot_${this.generateId()}`

    // 创建快照（简化实现）
    const snapshot = {
      id: snapshotId,
      spreadsheetId: historyData.spreadsheetId,
      data: historyData.snapshot || historyData.changes,
      createdAt: new Date(),
      type: 'operation'
    }

    // 仅存储快照引用
    this.storageMap.set(historyId, {
      id: historyId,
      spreadsheetId: historyData.spreadsheetId,
      operationType: historyData.operationType,
      operatorId: historyData.operatorId,
      operatorName: historyData.operatorName,
      description: historyData.description,
      snapshotId,
      timestamp: new Date(),
      _snapshotData: snapshot
    })

    return {
      success: true,
      historyId,
      storageStrategy: 'SNAPSHOT_ONLY',
      originalSize: dataSize,
      storedSize: 1024, // 快照引用的固定开销
      compressionRatio: dataSize > 0 ? Math.round(1024 / dataSize * 100) : 100,
      snapshotId
    }
  }

  /**
   * 检索历史记录
   */
  async retrieveHistoryRecord(historyId: string): Promise<HistoryData | null> {
    const record = this.storageMap.get(historyId)
    if (!record) return null

    // 如果是压缩数据，先解压
    if ((record as any)._compressed) {
      const decompressed = await this.compressionService.decompress(
        (record as any)._compressedData
      )
      return {
        ...record,
        changes: decompressed.changes,
        snapshot: decompressed.snapshot
      }
    }

    // 如果是快照引用，获取快照数据
    if ((record as any)._snapshotData) {
      return {
        ...record,
        snapshot: (record as any)._snapshotData
      }
    }

    return record
  }

  /**
   * 获取存储统计
   */
  getStorageStats(): {
    totalRecords: number
    totalSize: number
    strategies: Record<string, number>
  } {
    let totalSize = 0
    const strategies: Record<string, number> = {
      full: 0,
      compressed: 0,
      snapshot: 0
    }

    this.storageMap.forEach(record => {
      totalSize += OperationClassifier.estimateStorageSize(record)

      if ((record as any)._compressed) {
        strategies.compressed++
      } else if ((record as any)._snapshotData) {
        strategies.snapshot++
      } else {
        strategies.full++
      }
    })

    return {
      totalRecords: this.storageMap.size,
      totalSize,
      strategies
    }
  }

  /**
   * 清理过期记录
   */
  async cleanupOldRecords(daysToKeep: number = 30): Promise<number> {
    const cutoffDate = new Date()
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep)

    let deletedCount = 0
    const toDelete: string[] = []

    this.storageMap.forEach((record, id) => {
      if (record.timestamp && record.timestamp < cutoffDate) {
        toDelete.push(id)
      }
    })

    toDelete.forEach(id => {
      this.storageMap.delete(id)
      deletedCount++
    })

    return deletedCount
  }

  /**
   * 生成唯一ID
   */
  private generateId(): string {
    return `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  }
}