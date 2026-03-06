export interface CompressionResult {
  data: string
  algorithm: 'simple-lz'
  originalSize: number
  compressedSize: number
  ratio: number
}

export interface CompressionEfficiency {
  ratio: number
  saved: number
  efficiency: '低' | '中' | '高'
}

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

export class CompressionService {
  async compress<T>(data: T): Promise<CompressionResult> {
    const raw = JSON.stringify(data)
    const originalSize = raw.length
    const compressed = this.simpleCompress(raw)
    const compressedSize = compressed.length

    return {
      data: compressed,
      algorithm: 'simple-lz',
      originalSize,
      compressedSize,
      ratio: originalSize === 0 ? 0 : Math.round((compressedSize / originalSize) * 100),
    }
  }

  async decompress<T>(encoded: string): Promise<T> {
    const raw = this.simpleDecompress(encoded)
    return JSON.parse(raw) as T
  }

  calculateEfficiency(originalSize: number, compressedSize: number): CompressionEfficiency {
    const ratio = originalSize === 0 ? 0 : Math.round((compressedSize / originalSize) * 100)
    const saved = Math.max(0, originalSize - compressedSize)

    let efficiency: CompressionEfficiency['efficiency'] = '低'
    if (ratio < 50) {
      efficiency = '高'
    } else if (ratio < 75) {
      efficiency = '中'
    }

    return {
      ratio,
      saved,
      efficiency,
    }
  }

  async batchCompress(items: unknown[]): Promise<CompressionResult[]> {
    const results: CompressionResult[] = []

    for (const item of items) {
      results.push(await this.compress(item))
    }

    return results
  }

  shouldCompress(data: unknown): boolean {
    const raw = JSON.stringify(data)

    if (raw.length < 1024) {
      return false
    }

    return new Set(raw).size / raw.length < 0.5
  }

  private simpleCompress(input: string): string {
    if (!input) {
      return ''
    }

    const dictionary = new Map<string, number>()
    for (let index = 0; index < 256; index += 1) {
      dictionary.set(String.fromCharCode(index), index)
    }

    const codes: number[] = []
    let nextCode = 256
    let current = ''

    for (const char of input) {
      const combined = current + char
      if (dictionary.has(combined)) {
        current = combined
        continue
      }

      if (current) {
        codes.push(dictionary.get(current) ?? current.charCodeAt(0))
      }

      dictionary.set(combined, nextCode)
      nextCode += 1
      current = char
    }

    if (current) {
      codes.push(dictionary.get(current) ?? current.charCodeAt(0))
    }

    return this.encodeBase64(JSON.stringify(codes))
  }

  private simpleDecompress(input: string): string {
    if (!input) {
      return ''
    }

    const codes = JSON.parse(this.decodeBase64(input)) as number[]
    if (codes.length === 0) {
      return ''
    }

    const dictionary = new Map<number, string>()
    for (let index = 0; index < 256; index += 1) {
      dictionary.set(index, String.fromCharCode(index))
    }

    let nextCode = 256
    let previous = dictionary.get(codes[0]) ?? ''
    let output = previous

    for (let index = 1; index < codes.length; index += 1) {
      const currentCode = codes[index]
      const entry = dictionary.get(currentCode) ?? (
        currentCode === nextCode
          ? previous + previous.charAt(0)
          : ''
      )

      if (!entry) {
        throw new Error(`Invalid compressed payload at code ${currentCode}`)
      }

      output += entry
      dictionary.set(nextCode, previous + entry.charAt(0))
      nextCode += 1
      previous = entry
    }

    return output
  }

  private encodeBase64(value: string): string {
    if (typeof Buffer !== 'undefined') {
      return Buffer.from(value, 'utf8').toString('base64')
    }

    const binary = Array.from(textEncoder.encode(value), (byte) => String.fromCharCode(byte)).join('')
    return globalThis.btoa(binary)
  }

  private decodeBase64(value: string): string {
    if (typeof Buffer !== 'undefined') {
      return Buffer.from(value, 'base64').toString('utf8')
    }

    const binary = globalThis.atob(value)
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    return textDecoder.decode(bytes)
  }
}
