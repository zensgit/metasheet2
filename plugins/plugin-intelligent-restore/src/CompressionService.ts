/**
 * 压缩服务
 * 提供数据压缩和解压功能
 */

export interface CompressResult {
  data: string
  algorithm: string
  originalSize: number
  compressedSize: number
  ratio: number
}

export class CompressionService {
  /**
   * 压缩数据
   */
  async compress(data: any): Promise<CompressResult> {
    const originalString = JSON.stringify(data)
    const originalSize = originalString.length

    // 简单的压缩实现（实际应用中应使用更高效的算法如 zlib）
    const compressed = this.simpleCompress(originalString)
    const compressedSize = compressed.length

    return {
      data: compressed,
      algorithm: 'simple-lz',
      originalSize,
      compressedSize,
      ratio: Math.round((compressedSize / originalSize) * 100)
    }
  }

  /**
   * 解压数据
   */
  async decompress(compressedData: string): Promise<any> {
    const decompressed = this.simpleDecompress(compressedData)
    return JSON.parse(decompressed)
  }

  /**
   * 简单的压缩算法（LZ风格）
   */
  private simpleCompress(str: string): string {
    if (!str) return ''

    const dictionary: Map<string, number> = new Map()
    const result: Array<string | number> = []
    let dictSize = 256
    let w = ''

    for (let i = 0; i < str.length; i++) {
      const c = str.charAt(i)
      const wc = w + c

      if (dictionary.has(wc)) {
        w = wc
      } else {
        if (w) {
          result.push(dictionary.get(w) || w.charCodeAt(0))
        }
        dictionary.set(wc, dictSize++)
        w = c
      }
    }

    if (w) {
      result.push(dictionary.get(w) || w.charCodeAt(0))
    }

    // 转换为Base64以便存储
    return btoa(result.join(','))
  }

  /**
   * 简单的解压算法
   */
  private simpleDecompress(compressed: string): string {
    if (!compressed) return ''

    try {
      const data = atob(compressed).split(',').map(s => {
        const n = parseInt(s)
        return isNaN(n) ? s : String.fromCharCode(n)
      })

      return data.join('')
    } catch {
      // 如果解压失败，返回原始数据
      return compressed
    }
  }

  /**
   * 计算压缩效率
   */
  calculateEfficiency(originalSize: number, compressedSize: number): {
    ratio: number
    saved: number
    efficiency: string
  } {
    const ratio = Math.round((compressedSize / originalSize) * 100)
    const saved = originalSize - compressedSize
    let efficiency = '低'

    if (ratio < 50) {
      efficiency = '高'
    } else if (ratio < 75) {
      efficiency = '中'
    }

    return {
      ratio,
      saved,
      efficiency
    }
  }

  /**
   * 批量压缩
   */
  async batchCompress(items: any[]): Promise<CompressResult[]> {
    const results: CompressResult[] = []

    for (const item of items) {
      const result = await this.compress(item)
      results.push(result)
    }

    return results
  }

  /**
   * 智能压缩决策
   */
  shouldCompress(data: any): boolean {
    const size = JSON.stringify(data).length

    // 小于1KB的数据不压缩
    if (size < 1024) {
      return false
    }

    // 检查数据是否有重复模式（适合压缩）
    const str = JSON.stringify(data)
    const uniqueChars = new Set(str).size
    const compressionPotential = uniqueChars / str.length

    // 如果唯一字符比例低于0.5，说明重复较多，适合压缩
    return compressionPotential < 0.5
  }
}