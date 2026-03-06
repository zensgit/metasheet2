import { CompressionService } from './CompressionService'
import { OperationClassifier, type StorageStrategy } from './OperationClassifier'

export interface SnapshotData {
  id: string
  spreadsheetId: string
  data: unknown
  createdAt: Date
  type: 'operation'
}

export interface HistoryData {
  id?: string
  spreadsheetId: string
  operationType: string
  operatorId?: string
  operatorName: string
  description: string
  timestamp?: Date
  storageStrategy?: StorageStrategy | string
  changes?: unknown[]
  snapshot?: unknown
  metadata?: unknown
  snapshotId?: string
}

export interface StoreHistoryResult {
  success: boolean
  historyId: string
  storageStrategy: 'FULL_DETAIL' | 'COMPRESSED_DETAIL' | 'SNAPSHOT_ONLY'
  originalSize: number
  storedSize: number
  compressionRatio: number
  snapshotId?: string
}

export interface StorageStats {
  totalRecords: number
  totalSize: number
  strategies: {
    full: number
    compressed: number
    snapshot: number
  }
}

interface CompressedHistoryPayload {
  changes?: unknown[]
  snapshot?: unknown
}

interface StoredHistoryRecord extends HistoryData {
  id: string
  timestamp: Date
  storageStrategy: StorageStrategy
  _compressed?: boolean
  _compressedData?: string
  _snapshotData?: SnapshotData
}

export class IntelligentStorageService {
  private readonly compressionService = new CompressionService()
  private readonly storageMap = new Map<string, StoredHistoryRecord>()

  async storeHistoryRecord(record: HistoryData): Promise<StoreHistoryResult> {
    try {
      const estimatedSize = OperationClassifier.estimateStorageSize(record)
      const classification = OperationClassifier.classify(
        record.operationType,
        record.changes?.length ?? 0,
        estimatedSize,
        record.metadata,
      )

      console.log(`智能存储: ${record.operationType}
        分类: ${classification.class}
        策略: ${classification.storageStrategy}
        大小: ${estimatedSize} bytes`)

      switch (classification.storageStrategy) {
        case 'FULL':
          return await this.storeFull(record, estimatedSize)
        case 'COMPRESSED':
          return await this.storeCompressed(record)
        case 'SNAPSHOT_ONLY':
          return await this.storeSnapshotOnly(record, estimatedSize)
        default:
          return await this.storeFull(record, estimatedSize)
      }
    } catch (error) {
      console.error('智能存储失败:', error)
      return await this.storeFull(record, OperationClassifier.estimateStorageSize(record))
    }
  }

  async retrieveHistoryRecord(historyId: string): Promise<HistoryData | null> {
    const record = this.storageMap.get(historyId)
    if (!record) {
      return null
    }

    if (record._compressed && record._compressedData) {
      const restored = await this.compressionService.decompress<CompressedHistoryPayload>(record._compressedData)
      return {
        ...this.toPublicRecord(record),
        changes: restored.changes,
        snapshot: restored.snapshot,
      }
    }

    if (record._snapshotData) {
      return {
        ...this.toPublicRecord(record),
        snapshot: record._snapshotData,
      }
    }

    return this.toPublicRecord(record)
  }

  getStorageStats(): StorageStats {
    let totalSize = 0
    const strategies = {
      full: 0,
      compressed: 0,
      snapshot: 0,
    }

    for (const record of this.storageMap.values()) {
      totalSize += OperationClassifier.estimateStorageSize(record)

      if (record._compressed) {
        strategies.compressed += 1
      } else if (record._snapshotData) {
        strategies.snapshot += 1
      } else {
        strategies.full += 1
      }
    }

    return {
      totalRecords: this.storageMap.size,
      totalSize,
      strategies,
    }
  }

  async cleanupOldRecords(retentionDays = 30): Promise<number> {
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - retentionDays)

    let removedCount = 0
    const expiredIds: string[] = []

    for (const [historyId, record] of this.storageMap.entries()) {
      if (record.timestamp < cutoff) {
        expiredIds.push(historyId)
      }
    }

    for (const historyId of expiredIds) {
      this.storageMap.delete(historyId)
      removedCount += 1
    }

    return removedCount
  }

  private async storeFull(record: HistoryData, originalSize: number): Promise<StoreHistoryResult> {
    const historyId = this.generateId()
    this.storageMap.set(historyId, {
      ...record,
      id: historyId,
      timestamp: new Date(),
      storageStrategy: 'FULL',
    })

    return {
      success: true,
      historyId,
      storageStrategy: 'FULL_DETAIL',
      originalSize,
      storedSize: originalSize,
      compressionRatio: 100,
    }
  }

  private async storeCompressed(record: HistoryData): Promise<StoreHistoryResult> {
    const historyId = this.generateId()
    const compressed = await this.compressionService.compress<CompressedHistoryPayload>({
      changes: record.changes ?? [],
      snapshot: record.snapshot,
    })

    this.storageMap.set(historyId, {
      ...record,
      id: historyId,
      timestamp: new Date(),
      storageStrategy: 'COMPRESSED',
      _compressed: true,
      _compressedData: compressed.data,
    })

    return {
      success: true,
      historyId,
      storageStrategy: 'COMPRESSED_DETAIL',
      originalSize: compressed.originalSize,
      storedSize: compressed.compressedSize,
      compressionRatio: compressed.ratio,
    }
  }

  private async storeSnapshotOnly(record: HistoryData, originalSize: number): Promise<StoreHistoryResult> {
    const historyId = this.generateId()
    const snapshotId = `snapshot_${this.generateId()}`
    const snapshot: SnapshotData = {
      id: snapshotId,
      spreadsheetId: record.spreadsheetId,
      data: record.snapshot ?? record.changes,
      createdAt: new Date(),
      type: 'operation',
    }

    this.storageMap.set(historyId, {
      id: historyId,
      spreadsheetId: record.spreadsheetId,
      operationType: record.operationType,
      operatorId: record.operatorId,
      operatorName: record.operatorName,
      description: record.description,
      snapshotId,
      timestamp: new Date(),
      storageStrategy: 'SNAPSHOT_ONLY',
      _snapshotData: snapshot,
    })

    return {
      success: true,
      historyId,
      storageStrategy: 'SNAPSHOT_ONLY',
      originalSize,
      storedSize: 1024,
      compressionRatio: originalSize > 0 ? Math.round((1024 / originalSize) * 100) : 100,
      snapshotId,
    }
  }

  private toPublicRecord(record: StoredHistoryRecord): HistoryData {
    const { _compressed, _compressedData, _snapshotData, ...publicRecord } = record
    void _compressed
    void _compressedData
    void _snapshotData
    return publicRecord
  }

  private generateId(): string {
    return `${Date.now()}_${Math.random().toString(36).slice(2, 11)}`
  }
}
