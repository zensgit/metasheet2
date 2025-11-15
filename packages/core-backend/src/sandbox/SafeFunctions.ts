/**
 * Safe Functions Library
 * Pre-defined safe functions that can be exposed to sandboxed scripts
 */

export const SafeMathFunctions = {
  // Basic math operations
  sum: (arr: number[]): number => arr.reduce((a, b) => a + b, 0),
  average: (arr: number[]): number => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0,
  median: (arr: number[]): number => {
    const sorted = [...arr].sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
  },
  min: (arr: number[]): number => Math.min(...arr),
  max: (arr: number[]): number => Math.max(...arr),

  // Statistical functions
  standardDeviation: (arr: number[]): number => {
    const avg = arr.reduce((a, b) => a + b, 0) / arr.length
    const squareDiffs = arr.map(value => Math.pow(value - avg, 2))
    const avgSquareDiff = squareDiffs.reduce((a, b) => a + b, 0) / arr.length
    return Math.sqrt(avgSquareDiff)
  },

  // Rounding functions
  round: (num: number, decimals: number = 0): number => {
    const factor = Math.pow(10, decimals)
    return Math.round(num * factor) / factor
  },

  // Range functions
  range: (start: number, end: number, step: number = 1): number[] => {
    const result = []
    for (let i = start; i <= end; i += step) {
      result.push(i)
    }
    return result
  },

  // Random functions
  random: (min: number = 0, max: number = 1): number => {
    return Math.random() * (max - min) + min
  },

  randomInt: (min: number, max: number): number => {
    return Math.floor(Math.random() * (max - min + 1)) + min
  }
}

export const SafeStringFunctions = {
  // String manipulation
  capitalize: (str: string): string => {
    return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase()
  },

  titleCase: (str: string): string => {
    return str.replace(/\w\S*/g, txt =>
      txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase()
    )
  },

  camelCase: (str: string): string => {
    return str.replace(/[-_\s]+(.)?/g, (_, c) => c ? c.toUpperCase() : '')
  },

  snakeCase: (str: string): string => {
    return str.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)
      .replace(/^_/, '')
      .replace(/\s+/g, '_')
  },

  kebabCase: (str: string): string => {
    return str.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)
      .replace(/^-/, '')
      .replace(/\s+/g, '-')
  },

  // String validation
  isEmail: (str: string): boolean => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    return emailRegex.test(str)
  },

  isURL: (str: string): boolean => {
    try {
      new URL(str)
      return true
    } catch {
      return false
    }
  },

  isNumeric: (str: string): boolean => {
    return !isNaN(Number(str)) && !isNaN(parseFloat(str))
  },

  // String cleaning
  removeHtml: (str: string): string => {
    return str.replace(/<[^>]*>/g, '')
  },

  truncate: (str: string, length: number, suffix: string = '...'): string => {
    if (str.length <= length) return str
    return str.substring(0, length - suffix.length) + suffix
  },

  // String parsing
  extractNumbers: (str: string): number[] => {
    const matches = str.match(/-?\d+\.?\d*/g)
    return matches ? matches.map(Number) : []
  },

  wordCount: (str: string): number => {
    return str.trim().split(/\s+/).length
  }
}

export const SafeArrayFunctions = {
  // Array manipulation
  unique: <T>(arr: T[]): T[] => {
    return [...new Set(arr)]
  },

  flatten: <T>(arr: any[]): T[] => {
    return arr.reduce((flat, item) => {
      return flat.concat(Array.isArray(item) ? SafeArrayFunctions.flatten(item) : item)
    }, [])
  },

  chunk: <T>(arr: T[], size: number): T[][] => {
    const chunks = []
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size))
    }
    return chunks
  },

  shuffle: <T>(arr: T[]): T[] => {
    const shuffled = [...arr]
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
    }
    return shuffled
  },

  // Array filtering
  compact: <T>(arr: (T | null | undefined | false | 0 | '')[]): T[] => {
    return arr.filter(Boolean) as T[]
  },

  difference: <T>(arr1: T[], arr2: T[]): T[] => {
    const set2 = new Set(arr2)
    return arr1.filter(x => !set2.has(x))
  },

  intersection: <T>(arr1: T[], arr2: T[]): T[] => {
    const set2 = new Set(arr2)
    return arr1.filter(x => set2.has(x))
  },

  // Array searching
  findIndex: <T>(arr: T[], predicate: (item: T) => boolean): number => {
    for (let i = 0; i < arr.length; i++) {
      if (predicate(arr[i])) return i
    }
    return -1
  },

  findLastIndex: <T>(arr: T[], predicate: (item: T) => boolean): number => {
    for (let i = arr.length - 1; i >= 0; i--) {
      if (predicate(arr[i])) return i
    }
    return -1
  }
}

export const SafeDateFunctions = {
  // Date formatting
  formatDate: (date: Date | string, format: string = 'YYYY-MM-DD'): string => {
    const d = typeof date === 'string' ? new Date(date) : date

    const year = d.getFullYear()
    const month = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    const hours = String(d.getHours()).padStart(2, '0')
    const minutes = String(d.getMinutes()).padStart(2, '0')
    const seconds = String(d.getSeconds()).padStart(2, '0')

    return format
      .replace('YYYY', String(year))
      .replace('MM', month)
      .replace('DD', day)
      .replace('HH', hours)
      .replace('mm', minutes)
      .replace('ss', seconds)
  },

  // Date manipulation
  addDays: (date: Date | string, days: number): Date => {
    const d = new Date(date)
    d.setDate(d.getDate() + days)
    return d
  },

  addMonths: (date: Date | string, months: number): Date => {
    const d = new Date(date)
    d.setMonth(d.getMonth() + months)
    return d
  },

  addYears: (date: Date | string, years: number): Date => {
    const d = new Date(date)
    d.setFullYear(d.getFullYear() + years)
    return d
  },

  // Date comparison
  daysBetween: (date1: Date | string, date2: Date | string): number => {
    const d1 = new Date(date1)
    const d2 = new Date(date2)
    const diffTime = Math.abs(d2.getTime() - d1.getTime())
    return Math.ceil(diffTime / (1000 * 60 * 60 * 24))
  },

  isWeekend: (date: Date | string): boolean => {
    const d = new Date(date)
    const day = d.getDay()
    return day === 0 || day === 6
  },

  isLeapYear: (year: number): boolean => {
    return (year % 4 === 0 && year % 100 !== 0) || (year % 400 === 0)
  },

  // Date parsing
  parseDate: (dateString: string): Date | null => {
    const date = new Date(dateString)
    return isNaN(date.getTime()) ? null : date
  }
}

export const SafeObjectFunctions = {
  // Object manipulation
  pick: <T extends object, K extends keyof T>(obj: T, keys: K[]): Pick<T, K> => {
    const result = {} as Pick<T, K>
    keys.forEach(key => {
      if (key in obj) {
        result[key] = obj[key]
      }
    })
    return result
  },

  omit: <T extends object, K extends keyof T>(obj: T, keys: K[]): Omit<T, K> => {
    const result = { ...obj }
    keys.forEach(key => {
      delete result[key]
    })
    return result as Omit<T, K>
  },

  merge: <T extends object>(...objects: Partial<T>[]): T => {
    return Object.assign({}, ...objects) as T
  },

  // Object validation
  hasKey: <T extends object>(obj: T, key: PropertyKey): boolean => {
    return key in obj
  },

  isEmpty: (obj: object): boolean => {
    return Object.keys(obj).length === 0
  },

  // Object transformation
  mapValues: <T extends object, R>(
    obj: T,
    fn: (value: T[keyof T], key: keyof T) => R
  ): Record<keyof T, R> => {
    const result = {} as Record<keyof T, R>
    for (const key in obj) {
      if (obj.hasOwnProperty(key)) {
        result[key] = fn(obj[key], key)
      }
    }
    return result
  },

  invert: <T extends Record<PropertyKey, PropertyKey>>(obj: T): Record<T[keyof T], keyof T> => {
    const result = {} as Record<T[keyof T], keyof T>
    for (const key in obj) {
      if (obj.hasOwnProperty(key)) {
        result[obj[key]] = key
      }
    }
    return result
  },

  // Deep operations (with cycle protection)
  deepClone: <T>(obj: T, visited = new WeakSet()): T => {
    if (obj === null || typeof obj !== 'object') return obj
    if (visited.has(obj as any)) return obj
    visited.add(obj as any)

    if (obj instanceof Date) return new Date(obj.getTime()) as any
    if (obj instanceof Array) {
      return obj.map(item => SafeObjectFunctions.deepClone(item, visited)) as any
    }

    const clonedObj: any = {}
    for (const key in obj) {
      if (obj.hasOwnProperty(key)) {
        clonedObj[key] = SafeObjectFunctions.deepClone(obj[key], visited)
      }
    }
    return clonedObj
  }
}

export const SafeValidationFunctions = {
  // Type checking
  isString: (value: any): value is string => typeof value === 'string',
  isNumber: (value: any): value is number => typeof value === 'number' && !isNaN(value),
  isBoolean: (value: any): value is boolean => typeof value === 'boolean',
  isArray: (value: any): value is any[] => Array.isArray(value),
  isObject: (value: any): value is object => value !== null && typeof value === 'object' && !Array.isArray(value),
  isNull: (value: any): value is null => value === null,
  isUndefined: (value: any): value is undefined => value === undefined,
  isFunction: (value: any): value is Function => typeof value === 'function',

  // Value validation
  inRange: (value: number, min: number, max: number): boolean => {
    return value >= min && value <= max
  },

  matches: (value: string, pattern: string | RegExp): boolean => {
    const regex = typeof pattern === 'string' ? new RegExp(pattern) : pattern
    return regex.test(value)
  },

  // Schema validation (simple)
  validateSchema: (obj: any, schema: Record<string, any>): { valid: boolean; errors: string[] } => {
    const errors: string[] = []

    for (const key in schema) {
      const rule = schema[key]
      const value = obj[key]

      if (rule.required && value === undefined) {
        errors.push(`Missing required field: ${key}`)
      }

      if (value !== undefined && rule.type) {
        const type = typeof value
        if (type !== rule.type) {
          errors.push(`Invalid type for ${key}: expected ${rule.type}, got ${type}`)
        }
      }

      if (value !== undefined && rule.min !== undefined) {
        if (typeof value === 'number' && value < rule.min) {
          errors.push(`${key} is below minimum: ${rule.min}`)
        }
        if (typeof value === 'string' && value.length < rule.min) {
          errors.push(`${key} length is below minimum: ${rule.min}`)
        }
      }

      if (value !== undefined && rule.max !== undefined) {
        if (typeof value === 'number' && value > rule.max) {
          errors.push(`${key} is above maximum: ${rule.max}`)
        }
        if (typeof value === 'string' && value.length > rule.max) {
          errors.push(`${key} length is above maximum: ${rule.max}`)
        }
      }
    }

    return { valid: errors.length === 0, errors }
  }
}

// Export all safe functions
export const SafeFunctions = {
  math: SafeMathFunctions,
  string: SafeStringFunctions,
  array: SafeArrayFunctions,
  date: SafeDateFunctions,
  object: SafeObjectFunctions,
  validation: SafeValidationFunctions
}

// Create a context with all safe functions for sandbox execution
export function createSafeContext(): Record<string, any> {
  return {
    // Math functions
    sum: SafeMathFunctions.sum,
    average: SafeMathFunctions.average,
    median: SafeMathFunctions.median,
    round: SafeMathFunctions.round,

    // String functions
    capitalize: SafeStringFunctions.capitalize,
    titleCase: SafeStringFunctions.titleCase,
    isEmail: SafeStringFunctions.isEmail,
    truncate: SafeStringFunctions.truncate,

    // Array functions
    unique: SafeArrayFunctions.unique,
    flatten: SafeArrayFunctions.flatten,
    chunk: SafeArrayFunctions.chunk,

    // Date functions
    formatDate: SafeDateFunctions.formatDate,
    addDays: SafeDateFunctions.addDays,
    daysBetween: SafeDateFunctions.daysBetween,

    // Object functions
    pick: SafeObjectFunctions.pick,
    omit: SafeObjectFunctions.omit,
    merge: SafeObjectFunctions.merge,

    // Validation functions
    isString: SafeValidationFunctions.isString,
    isNumber: SafeValidationFunctions.isNumber,
    validateSchema: SafeValidationFunctions.validateSchema
  }
}