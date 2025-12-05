import type { Response } from 'express'

export function jsonError(res: Response, status: number, code: string, message?: string, details?: unknown) {
  res.status(status).json({ ok: false, error: { code, message, details } })
}

export function jsonOk<T = unknown>(res: Response, data: T, meta?: Record<string, unknown>) {
  res.json({ ok: true, data, meta })
}

/**
 * Pagination options with defaults
 */
export interface PaginationParams {
  page: number
  pageSize: number
  offset: number
}

/**
 * Parse pagination parameters from query string with sensible defaults and bounds.
 *
 * @param query - Express request query object
 * @param options - Optional configuration for defaults and bounds
 * @returns Parsed and bounded pagination parameters
 */
export function parsePagination(
  query: Record<string, unknown>,
  options: {
    defaultPage?: number
    defaultPageSize?: number
    maxPageSize?: number
    minPageSize?: number
  } = {}
): PaginationParams {
  const {
    defaultPage = 1,
    defaultPageSize = 50,
    maxPageSize = 200,
    minPageSize = 1
  } = options

  const page = Math.max(parseInt(String(query.page || defaultPage), 10), 1)
  const pageSize = Math.min(
    Math.max(parseInt(String(query.pageSize || defaultPageSize), 10), minPageSize),
    maxPageSize
  )
  const offset = (page - 1) * pageSize

  return { page, pageSize, offset }
}
