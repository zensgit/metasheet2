/**
 * 数据压缩服务
 * 提供智能压缩和解压缩功能
 */

export type CompressionType = 'none' | 'light' | 'medium' | 'heavy'

export interface CompressionResult {
  compressed: boolean
  type: CompressionType
  data: any
  originalSize: number
  compressedSize: number
  compressionRatio: number
}

export class CompressionService {
  // 字符串去重映射
  private static stringCache = new Map<string, string>()
  private static stringIdCounter = 0

  /**
   * 智能压缩数据
   */
  static compress(data: any, strategy: 'adaptive' | 'aggressive' | 'minimal' = 'adaptive'): CompressionResult {
    const originalSize = this.calculateSize(data)

    if (strategy === 'minimal' || originalSize < 1024) {
      // 小数据不压缩
      return {
        compressed: false,
        type: 'none',
        data,
        originalSize,
        compressedSize: originalSize,
        compressionRatio: 0
      }
    }

    let compressedData: any
    let compressionType: CompressionType

    if (strategy === 'aggressive' || originalSize > 10240) {
      // 重度压缩
      compressedData = this.heavyCompress(data)
      compressionType = 'heavy'
    } else if (originalSize > 5120) {
      // 中度压缩
      compressedData = this.mediumCompress(data)
      compressionType = 'medium'
    } else {
      // 轻度压缩
      compressedData = this.lightCompress(data)
      compressionType = 'light'
    }

    const compressedSize = this.calculateSize(compressedData)

    return {
      compressed: true,
      type: compressionType,
      data: compressedData,
      originalSize,
      compressedSize,
      compressionRatio: (originalSize - compressedSize) / originalSize
    }
  }

  /**
   * 解压缩数据
   */
  static decompress(compressedData: any, type: CompressionType): any {
    switch (type) {
      case 'none':
        return compressedData
      case 'light':
        return this.lightDecompress(compressedData)
      case 'medium':
        return this.mediumDecompress(compressedData)
      case 'heavy':
        return this.heavyDecompress(compressedData)
      default:
        return compressedData
    }
  }

  /**
   * 轻度压缩 - 去除冗余字段
   */
  private static lightCompress(data: any): any {
    const defaults = {
      type: 'update_record',
      status: 'active',
      enabled: true,
      visible: true,
      deleted: false
    }

    return this.removeDefaults(data, defaults)
  }

  /**
   * 轻度解压缩
   */
  private static lightDecompress(data: any): any {
    const defaults = {
      type: 'update_record',
      status: 'active',
      enabled: true,
      visible: true,
      deleted: false
    }

    return this.restoreDefaults(data, defaults)
  }

  /**
   * 中度压缩 - 字符串去重
   */
  private static mediumCompress(data: any): any {
    // 先进行轻度压缩
    const lightCompressed = this.lightCompress(data)

    // 然后进行字符串去重
    const { data: deduplicated, stringMap } = this.deduplicateStrings(lightCompressed)

    return {
      _compressed: 'medium',
      _stringMap: stringMap,
      data: deduplicated
    }
  }

  /**
   * 中度解压缩
   */
  private static mediumDecompress(compressedData: any): any {
    if (compressedData._compressed !== 'medium') {
      return compressedData
    }

    // 恢复字符串
    const restored = this.restoreStrings(compressedData.data, compressedData._stringMap)

    // 恢复默认值
    return this.lightDecompress(restored)
  }

  /**
   * 重度压缩 - 结构优化 + 字符串去重 + 数组压缩
   */
  private static heavyCompress(data: any): any {
    // 先进行中度压缩
    const mediumCompressed = this.mediumCompress(data)

    // 然后进行结构优化
    const optimized = this.optimizeStructure(mediumCompressed)

    // 最后进行数组压缩
    const arrayCompressed = this.compressArrays(optimized)

    return {
      _compressed: 'heavy',
      ...arrayCompressed
    }
  }

  /**
   * 重度解压缩
   */
  private static heavyDecompress(compressedData: any): any {
    if (compressedData._compressed !== 'heavy') {
      return compressedData
    }

    // 解压数组
    const arrayDecompressed = this.decompressArrays(compressedData)

    // 恢复结构
    const structureRestored = this.restoreStructure(arrayDecompressed)

    // 进行中度解压缩
    return this.mediumDecompress(structureRestored)
  }

  /**
   * 去除默认值
   */
  private static removeDefaults(obj: any, defaults: any): any {
    if (Array.isArray(obj)) {
      return obj.map(item => this.removeDefaults(item, defaults))
    }

    if (obj && typeof obj === 'object') {
      const result: any = {}
      for (const [key, value] of Object.entries(obj)) {
        if (defaults[key] !== value) {
          result[key] = this.removeDefaults(value, defaults)
        }
      }
      return result
    }

    return obj
  }

  /**
   * 恢复默认值
   */
  private static restoreDefaults(obj: any, defaults: any): any {
    if (Array.isArray(obj)) {
      return obj.map(item => this.restoreDefaults(item, defaults))
    }

    if (obj && typeof obj === 'object') {
      const result = { ...defaults }
      for (const [key, value] of Object.entries(obj)) {
        result[key] = this.restoreDefaults(value, defaults)
      }
      return result
    }

    return obj
  }

  /**
   * 字符串去重
   */
  private static deduplicateStrings(obj: any): { data: any, stringMap: Record<string, string> } {
    const stringMap: Record<string, string> = {}
    const reverseMap = new Map<string, string>()

    const deduplicate = (item: any): any => {
      if (typeof item === 'string' && item.length > 20) {
        if (!reverseMap.has(item)) {
          const id = `$${this.stringIdCounter++}`
          stringMap[id] = item
          reverseMap.set(item, id)
        }
        return reverseMap.get(item)
      }

      if (Array.isArray(item)) {
        return item.map(deduplicate)
      }

      if (item && typeof item === 'object') {
        const result: any = {}
        for (const [key, value] of Object.entries(item)) {
          result[key] = deduplicate(value)
        }
        return result
      }

      return item
    }

    return {
      data: deduplicate(obj),
      stringMap
    }
  }

  /**
   * 恢复字符串
   */
  private static restoreStrings(obj: any, stringMap: Record<string, string>): any {
    const restore = (item: any): any => {
      if (typeof item === 'string' && item.startsWith('$') && stringMap[item]) {
        return stringMap[item]
      }

      if (Array.isArray(item)) {
        return item.map(restore)
      }

      if (item && typeof item === 'object') {
        const result: any = {}
        for (const [key, value] of Object.entries(item)) {
          result[key] = restore(value)
        }
        return result
      }

      return item
    }

    return restore(obj)
  }

  /**
   * 优化结构
   */
  private static optimizeStructure(obj: any): any {
    // 将重复的对象结构提取为模板
    if (Array.isArray(obj) && obj.length > 5) {
      const template = this.extractTemplate(obj)
      if (template) {
        return {
          _template: template.template,
          _items: template.items
        }
      }
    }

    if (obj && typeof obj === 'object') {
      const result: any = {}
      for (const [key, value] of Object.entries(obj)) {
        result[key] = this.optimizeStructure(value)
      }
      return result
    }

    return obj
  }

  /**
   * 恢复结构
   */
  private static restoreStructure(obj: any): any {
    if (obj && obj._template && obj._items) {
      return this.applyTemplate(obj._template, obj._items)
    }

    if (Array.isArray(obj)) {
      return obj.map(item => this.restoreStructure(item))
    }

    if (obj && typeof obj === 'object') {
      const result: any = {}
      for (const [key, value] of Object.entries(obj)) {
        result[key] = this.restoreStructure(value)
      }
      return result
    }

    return obj
  }

  /**
   * 压缩数组
   */
  private static compressArrays(obj: any): any {
    if (Array.isArray(obj)) {
      // 检查是否是数字数组
      if (obj.every(item => typeof item === 'number')) {
        return {
          _array: 'numbers',
          _data: this.deltaEncode(obj)
        }
      }
      return obj.map(item => this.compressArrays(item))
    }

    if (obj && typeof obj === 'object') {
      const result: any = {}
      for (const [key, value] of Object.entries(obj)) {
        result[key] = this.compressArrays(value)
      }
      return result
    }

    return obj
  }

  /**
   * 解压数组
   */
  private static decompressArrays(obj: any): any {
    if (obj && obj._array === 'numbers') {
      return this.deltaDecode(obj._data)
    }

    if (Array.isArray(obj)) {
      return obj.map(item => this.decompressArrays(item))
    }

    if (obj && typeof obj === 'object') {
      const result: any = {}
      for (const [key, value] of Object.entries(obj)) {
        result[key] = this.decompressArrays(value)
      }
      return result
    }

    return obj
  }

  /**
   * Delta编码（用于压缩数字序列）
   */
  private static deltaEncode(numbers: number[]): number[] {
    if (numbers.length === 0) return []

    const result = [numbers[0]!]
    for (let i = 1; i < numbers.length; i++) {
      result.push(numbers[i]! - numbers[i - 1]!)
    }
    return result as number[]
  }

  /**
   * Delta解码
   */
  private static deltaDecode(encoded: number[]): number[] {
    if (encoded.length === 0) return []

    const result = [encoded[0]!]
    for (let i = 1; i < encoded.length; i++) {
      result.push(result[i - 1]! + encoded[i]!)
    }
    return result as number[]
  }

  /**
   * 提取模板
   */
  private static extractTemplate(items: any[]): { template: any, items: any[] } | null {
    if (items.length < 5) return null

    // 找出所有对象的公共键
    const commonKeys = new Set<string>()
    const firstItem = items[0]

    if (!firstItem || typeof firstItem !== 'object') return null

    Object.keys(firstItem).forEach(key => commonKeys.add(key))

    for (let i = 1; i < items.length; i++) {
      if (!items[i] || typeof items[i] !== 'object') return null

      const currentKeys = new Set(Object.keys(items[i]))
      commonKeys.forEach(key => {
        if (!currentKeys.has(key)) {
          commonKeys.delete(key)
        }
      })
    }

    if (commonKeys.size < 3) return null

    // 创建模板
    const template: any = {}
    commonKeys.forEach(key => {
      template[key] = null
    })

    // 创建精简的项目数组
    const compactItems = items.map(item => {
      const compact: any = {}
      for (const [key, value] of Object.entries(item)) {
        if (!commonKeys.has(key) || value !== null) {
          compact[key] = value
        }
      }
      return compact
    })

    return { template, items: compactItems }
  }

  /**
   * 应用模板
   */
  private static applyTemplate(template: any, items: any[]): any[] {
    return items.map(item => ({ ...template, ...item }))
  }

  /**
   * 计算数据大小
   */
  private static calculateSize(data: any): number {
    return JSON.stringify(data).length
  }

  /**
   * 批量压缩
   */
  static batchCompress(dataArray: any[], strategy: 'adaptive' | 'aggressive' | 'minimal' = 'adaptive'): CompressionResult[] {
    return dataArray.map(data => this.compress(data, strategy))
  }

  /**
   * 获取压缩统计
   */
  static getCompressionStats(results: CompressionResult[]): {
    totalOriginalSize: number
    totalCompressedSize: number
    averageCompressionRatio: number
    bestCompressionRatio: number
    worstCompressionRatio: number
  } {
    let totalOriginalSize = 0
    let totalCompressedSize = 0
    let bestRatio = 0
    let worstRatio = 1

    for (const result of results) {
      totalOriginalSize += result.originalSize
      totalCompressedSize += result.compressedSize
      bestRatio = Math.max(bestRatio, result.compressionRatio)
      worstRatio = Math.min(worstRatio, result.compressionRatio)
    }

    return {
      totalOriginalSize,
      totalCompressedSize,
      averageCompressionRatio: results.length > 0
        ? results.reduce((sum, r) => sum + r.compressionRatio, 0) / results.length
        : 0,
      bestCompressionRatio: bestRatio,
      worstCompressionRatio: worstRatio
    }
  }
}