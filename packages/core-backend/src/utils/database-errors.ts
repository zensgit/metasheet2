/**
 * Shared database error handling utilities.
 * Provides consistent error detection for database schema errors across the codebase.
 */

/**
 * Extended Error interface for PostgreSQL database errors.
 * PostgreSQL adds a `code` property with SQLSTATE error codes.
 */
export interface DatabaseError extends Error {
  code?: string
}

/**
 * Checks if an error is a database schema error (missing table/relation).
 * Used for graceful degradation when optional tables don't exist.
 *
 * PostgreSQL error code 42P01: undefined_table (relation does not exist)
 *
 * @param error - The error to check
 * @returns true if the error indicates a missing table/relation
 */
export function isDatabaseSchemaError(error: unknown): boolean {
  const dbError = error as DatabaseError

  // PostgreSQL SQLSTATE code for "undefined_table"
  if (dbError?.code === '42P01') return true

  // Fallback: check error message for common schema error patterns
  if (dbError?.message && typeof dbError.message === 'string') {
    const msg = dbError.message.toLowerCase()
    return (msg.includes('relation') || msg.includes('table')) && msg.includes('does not exist')
  }

  return false
}

// ── SQLSTATE-first schema guards (locale-proof) ─────────────────────────────
//
// 背景:PostgreSQL 的报错散文会被 `lc_messages` 翻译(222 测试机是
// `Chinese (Simplified)_China.936`),所以 `column ... does not exist` 这类英文整句
// 在中文 locale 下永远匹配不上,原来靠散文的降级守卫会直接抛出 → 500。
//
// 规则(三条,顺序不可换):
//   1. SQLSTATE(`err.code`)是主信号;真实 pg 驱动的错误一定带 code。
//   2. message 只用来匹配**标识符**(表名/列名),绝不用来匹配散文,也绝不与 code 做 AND。
//   3. 英文散文只在 err **完全没有 code** 时(手工构造的错误、非 pg 驱动)作兜底,
//      并同时接受中文译文。

/** SQLSTATE 42P01 undefined_table */
const UNDEFINED_TABLE_SQLSTATE = '42P01'
/** SQLSTATE 42703 undefined_column */
const UNDEFINED_COLUMN_SQLSTATE = '42703'

function readErrorCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null | undefined)?.code
  return typeof code === 'string' && code.length > 0 ? code : null
}

function readErrorMessage(error: unknown): string {
  const message = (error as { message?: unknown } | null | undefined)?.message
  return typeof message === 'string' ? message : ''
}

/**
 * 去掉空白与双引号后再比对,这样 `column "g"."name" does not exist`、
 * `column g.name does not exist`、`字段 g.name 不存在` 都能命中同一个标识符。
 */
function compactForIdentifierMatch(text: string): string {
  return text.replace(/["\s]+/g, '')
}

function messageMentionsIdentifier(message: string, identifier: string | undefined): boolean {
  if (identifier === undefined || identifier.length === 0) return true
  if (message.includes(identifier)) return true
  return compactForIdentifierMatch(message).includes(compactForIdentifierMatch(identifier))
}

/** 无 code 时的散文兜底:英文原文 + 中文译文。 */
function looksLikeMissingRelationProse(message: string): boolean {
  if (message.includes('does not exist') && message.includes('relation')) return true
  return message.includes('不存在') && message.includes('关系')
}

function looksLikeMissingColumnProse(message: string): boolean {
  if (message.includes('does not exist') && message.includes('column')) return true
  return message.includes('不存在') && (message.includes('字段') || message.includes('列'))
}

/**
 * 缺表(relation does not exist)。
 *
 * @param tableName 省略时只判「是不是缺表」;给了就要求 message 提到该表名,
 *                  避免把别的表的缺失误当成自己的可降级场景。
 */
export function isUndefinedTableError(error: unknown, tableName?: string): boolean {
  const code = readErrorCode(error)
  const message = readErrorMessage(error)
  if (code !== null) {
    if (code !== UNDEFINED_TABLE_SQLSTATE) return false
    return messageMentionsIdentifier(message, tableName)
  }
  if (!looksLikeMissingRelationProse(message)) return false
  return messageMentionsIdentifier(message, tableName)
}

/**
 * 缺列(column does not exist)。
 *
 * @param columnName 省略时只判「是不是缺列」;给了就要求 message 提到该列名。
 */
export function isUndefinedColumnError(error: unknown, columnName?: string): boolean {
  const code = readErrorCode(error)
  const message = readErrorMessage(error)
  if (code !== null) {
    if (code !== UNDEFINED_COLUMN_SQLSTATE) return false
    return messageMentionsIdentifier(message, columnName)
  }
  if (!looksLikeMissingColumnProse(message)) return false
  return messageMentionsIdentifier(message, columnName)
}
