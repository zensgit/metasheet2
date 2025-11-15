import type { Response } from 'express'

export function jsonError(res: Response, status: number, code: string, message?: string, details?: any) {
  res.status(status).json({ ok: false, error: { code, message, details } })
}

export function jsonOk(res: Response, data: any, meta?: any) {
  res.json({ ok: true, data, meta })
}

