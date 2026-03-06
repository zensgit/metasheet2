export type OperationClass = 'LIGHTWEIGHT' | 'MEDIUM' | 'HEAVYWEIGHT'
export type StorageStrategy = 'FULL' | 'COMPRESSED' | 'SNAPSHOT_ONLY'
export type OperationPattern = 'bulk' | 'random' | 'sequential'

export interface ClassificationResult {
  class: OperationClass
  storageStrategy: StorageStrategy
  compressionNeeded: boolean
  snapshotNeeded: boolean
  estimatedSize: number
}

export interface OperationPatternInput {
  type?: string
  affectedRows?: number
  timestamp: Date | string
}

export interface PatternAnalysis {
  pattern: OperationPattern
  recommendation: string
}

const OPERATION_WEIGHTS: Record<string, number> = {
  cell_edit: 1,
  cell_format: 1,
  row_add: 2,
  row_delete: 2,
  column_add: 2,
  column_delete: 2,
  cell_comment: 1,
  bulk_edit: 5,
  bulk_delete: 5,
  column_rename: 4,
  formula_update: 4,
  filter_apply: 3,
  sort_apply: 3,
  import_data: 10,
  bulk_import: 10,
  table_restructure: 9,
  mass_delete: 8,
  snapshot_create: 7,
  version_restore: 8,
}

const SIZE_THRESHOLDS = {
  SMALL: 1024,
  MEDIUM: 10 * 1024,
  LARGE: 100 * 1024,
} as const

const ROW_THRESHOLDS = {
  FEW: 10,
  MODERATE: 100,
  MANY: 1000,
} as const

export class OperationClassifier {
  static classify(
    operationType: string,
    affectedRows: number,
    estimatedSize: number,
    _metadata?: unknown,
  ): ClassificationResult {
    const normalizedType = operationType.toLowerCase()
    const baseWeight = OPERATION_WEIGHTS[normalizedType] ?? 5
    const sizeScore = this.calculateSizeScore(estimatedSize)
    const rowScore = this.calculateRowScore(affectedRows)
    const totalScore = baseWeight + sizeScore + rowScore

    let operationClass: OperationClass
    let storageStrategy: StorageStrategy
    let compressionNeeded = false
    let snapshotNeeded = false

    if (totalScore <= 5) {
      operationClass = 'LIGHTWEIGHT'
      storageStrategy = 'FULL'
    } else if (totalScore <= 10) {
      operationClass = 'MEDIUM'
      storageStrategy = 'COMPRESSED'
      compressionNeeded = true
    } else {
      operationClass = 'HEAVYWEIGHT'
      storageStrategy = 'SNAPSHOT_ONLY'
      snapshotNeeded = true
    }

    if (normalizedType.includes('import') || normalizedType.includes('bulk')) {
      snapshotNeeded = true
    }

    if (estimatedSize > SIZE_THRESHOLDS.MEDIUM) {
      compressionNeeded = true
    }

    return {
      class: operationClass,
      storageStrategy,
      compressionNeeded,
      snapshotNeeded,
      estimatedSize,
    }
  }

  static estimateStorageSize(data: unknown): number {
    try {
      return JSON.stringify(data).length
    } catch {
      return 0
    }
  }

  static analyzePattern(operations: OperationPatternInput[]): PatternAnalysis {
    if (!operations.length) {
      return {
        pattern: 'random',
        recommendation: '无操作记录',
      }
    }

    const bulkCount = operations.filter((operation) => {
      return operation.type?.includes('bulk') || (operation.affectedRows ?? 0) > 100
    }).length

    if (bulkCount > operations.length / 2) {
      return {
        pattern: 'bulk',
        recommendation: '建议使用快照存储策略',
      }
    }

    const timestamps = operations.map((operation) => new Date(operation.timestamp).getTime())
    let isSequential = true

    for (let index = 1; index < timestamps.length; index += 1) {
      if (timestamps[index] - timestamps[index - 1] > 60 * 1000) {
        isSequential = false
        break
      }
    }

    if (isSequential) {
      return {
        pattern: 'sequential',
        recommendation: '建议合并连续操作',
      }
    }

    return {
      pattern: 'random',
      recommendation: '标准存储策略',
    }
  }

  private static calculateSizeScore(estimatedSize: number): number {
    if (estimatedSize < SIZE_THRESHOLDS.SMALL) {
      return 0
    }

    if (estimatedSize < SIZE_THRESHOLDS.MEDIUM) {
      return 2
    }

    if (estimatedSize < SIZE_THRESHOLDS.LARGE) {
      return 4
    }

    return 6
  }

  private static calculateRowScore(affectedRows: number): number {
    if (affectedRows < ROW_THRESHOLDS.FEW) {
      return 0
    }

    if (affectedRows < ROW_THRESHOLDS.MODERATE) {
      return 2
    }

    if (affectedRows < ROW_THRESHOLDS.MANY) {
      return 3
    }

    return 5
  }
}
