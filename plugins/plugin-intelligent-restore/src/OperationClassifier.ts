/**
 * 操作分类器
 * 根据操作类型、数据量等因素智能分类操作
 */

export enum OperationClass {
  LIGHTWEIGHT = 'LIGHTWEIGHT',  // 轻量级操作
  MEDIUM = 'MEDIUM',            // 中等操作
  HEAVYWEIGHT = 'HEAVYWEIGHT'   // 重量级操作
}

export interface ClassificationResult {
  class: OperationClass
  storageStrategy: 'FULL' | 'COMPRESSED' | 'SNAPSHOT_ONLY'
  compressionNeeded: boolean
  snapshotNeeded: boolean
  estimatedSize: number
}

export class OperationClassifier {
  // 操作类型权重
  private static readonly OPERATION_WEIGHTS: Record<string, number> = {
    // 轻量级操作 (权重 1-3)
    'cell_edit': 1,
    'cell_format': 1,
    'row_add': 2,
    'row_delete': 2,
    'column_add': 2,
    'column_delete': 2,
    'cell_comment': 1,

    // 中等操作 (权重 4-6)
    'bulk_edit': 5,
    'bulk_delete': 5,
    'column_rename': 4,
    'formula_update': 4,
    'filter_apply': 3,
    'sort_apply': 3,

    // 重量级操作 (权重 7-10)
    'import_data': 10,
    'bulk_import': 10,
    'table_restructure': 9,
    'mass_delete': 8,
    'snapshot_create': 7,
    'version_restore': 8
  }

  // 数据量阈值
  private static readonly SIZE_THRESHOLDS = {
    SMALL: 1024,         // 1KB
    MEDIUM: 10240,       // 10KB
    LARGE: 102400        // 100KB
  }

  // 行数阈值
  private static readonly ROW_THRESHOLDS = {
    FEW: 10,
    MODERATE: 100,
    MANY: 1000
  }

  /**
   * 分类操作
   */
  static classify(
    operationType: string,
    affectedRows: number,
    dataSize: number,
    metadata?: any
  ): ClassificationResult {
    // 计算操作权重
    const operationWeight = this.OPERATION_WEIGHTS[operationType] || 5

    // 计算数据量得分
    const sizeScore = this.calculateSizeScore(dataSize)

    // 计算行数得分
    const rowScore = this.calculateRowScore(affectedRows)

    // 综合得分
    const totalScore = operationWeight + sizeScore + rowScore

    // 根据得分确定分类
    let operationClass: OperationClass
    let storageStrategy: 'FULL' | 'COMPRESSED' | 'SNAPSHOT_ONLY'
    let compressionNeeded = false
    let snapshotNeeded = false

    if (totalScore <= 5) {
      operationClass = OperationClass.LIGHTWEIGHT
      storageStrategy = 'FULL'
    } else if (totalScore <= 10) {
      operationClass = OperationClass.MEDIUM
      storageStrategy = 'COMPRESSED'
      compressionNeeded = true
    } else {
      operationClass = OperationClass.HEAVYWEIGHT
      storageStrategy = 'SNAPSHOT_ONLY'
      snapshotNeeded = true
    }

    // 特殊情况处理
    if (operationType.includes('import') || operationType.includes('bulk')) {
      snapshotNeeded = true
    }

    if (dataSize > this.SIZE_THRESHOLDS.MEDIUM) {
      compressionNeeded = true
    }

    return {
      class: operationClass,
      storageStrategy,
      compressionNeeded,
      snapshotNeeded,
      estimatedSize: dataSize
    }
  }

  /**
   * 计算数据大小得分
   */
  private static calculateSizeScore(dataSize: number): number {
    if (dataSize < this.SIZE_THRESHOLDS.SMALL) {
      return 0
    } else if (dataSize < this.SIZE_THRESHOLDS.MEDIUM) {
      return 2
    } else if (dataSize < this.SIZE_THRESHOLDS.LARGE) {
      return 4
    } else {
      return 6
    }
  }

  /**
   * 计算行数得分
   */
  private static calculateRowScore(affectedRows: number): number {
    if (affectedRows < this.ROW_THRESHOLDS.FEW) {
      return 0
    } else if (affectedRows < this.ROW_THRESHOLDS.MODERATE) {
      return 2
    } else if (affectedRows < this.ROW_THRESHOLDS.MANY) {
      return 3
    } else {
      return 5
    }
  }

  /**
   * 估算存储大小
   */
  static estimateStorageSize(data: any): number {
    try {
      return JSON.stringify(data).length
    } catch {
      return 0
    }
  }

  /**
   * 分析操作模式
   */
  static analyzePattern(operations: any[]): {
    pattern: 'sequential' | 'bulk' | 'random'
    recommendation: string
  } {
    if (!operations || operations.length === 0) {
      return {
        pattern: 'random',
        recommendation: '无操作记录'
      }
    }

    // 检查是否为批量操作
    const bulkOperations = operations.filter(op =>
      op.type?.includes('bulk') || op.affectedRows > 100
    )

    if (bulkOperations.length > operations.length / 2) {
      return {
        pattern: 'bulk',
        recommendation: '建议使用快照存储策略'
      }
    }

    // 检查是否为顺序操作
    const timestamps = operations.map(op => new Date(op.timestamp).getTime())
    let isSequential = true

    for (let i = 1; i < timestamps.length; i++) {
      const timeDiff = timestamps[i] - timestamps[i - 1]
      if (timeDiff > 60000) { // 超过1分钟
        isSequential = false
        break
      }
    }

    if (isSequential) {
      return {
        pattern: 'sequential',
        recommendation: '建议合并连续操作'
      }
    }

    return {
      pattern: 'random',
      recommendation: '标准存储策略'
    }
  }
}