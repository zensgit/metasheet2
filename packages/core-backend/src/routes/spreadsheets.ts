import type { Request, Response } from 'express'
import { Router } from 'express'
import type { Injector } from '@wendellhu/redi'
import type { Kysely } from 'kysely'
import { randomUUID } from 'crypto'
import { z } from 'zod'
import { rbacGuard } from '../rbac/rbac'
import { auditLog } from '../audit/audit'
import { db as defaultDb } from '../db/db'
import type { Database } from '../db/types'
import { parsePagination } from '../util/response'
import { Logger } from '../core/logger'

const logger = new Logger('SpreadsheetsRouter')

type SpreadsheetDb = Kysely<Database>

interface SpreadsheetRouterOptions {
  db?: SpreadsheetDb
}

function getActorId(req: Request): string | undefined {
  const user = req.user
  if (!user) return undefined
  const raw = user.id ?? user.sub ?? user.userId
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw)
  if (typeof raw === 'string' && raw.trim().length > 0) return raw
  return undefined
}

function toCellValue(value: unknown): Record<string, unknown> | null {
  if (value === undefined) return null
  if (value === null) return null
  if (typeof value === 'object') return value as Record<string, unknown>
  return { value }
}

export function spreadsheetsRouter(_injector?: Injector, options: SpreadsheetRouterOptions = {}): Router {
  const r = Router()
  const db = options.db ?? defaultDb

  r.get('/api/spreadsheets', rbacGuard('spreadsheets', 'read'), async (req: Request, res: Response) => {
    const { page, pageSize, offset } = parsePagination(req.query as Record<string, unknown>)

    try {
      const items = await db
        .selectFrom('spreadsheets')
        .selectAll()
        .where('deleted_at', 'is', null)
        .orderBy('created_at', 'desc')
        .limit(pageSize)
        .offset(offset)
        .execute()

      return res.json({ ok: true, data: { items, page, pageSize, total: items.length } })
    } catch (error) {
      logger.error('Failed to list spreadsheets', error as Error)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to list spreadsheets' } })
    }
  })

  r.post('/api/spreadsheets', rbacGuard('spreadsheets', 'write'), async (req: Request, res: Response) => {
    const schema = z.object({
      id: z.string().optional(),
      name: z.string().min(1),
      owner_id: z.string().optional(),
      ownerId: z.string().optional(),
      workspace_id: z.string().optional(),
      initial_sheets: z.array(z.object({
        id: z.string().optional(),
        name: z.string().min(1)
      })).optional()
    })
    const parse = schema.safeParse(req.body)
    if (!parse.success) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parse.error.message } })
    }

    const payload = parse.data
    const spreadsheetId = payload.id ?? randomUUID()
    const ownerId = payload.owner_id ?? payload.ownerId ?? getActorId(req) ?? null
    const initialSheets = payload.initial_sheets?.length
      ? payload.initial_sheets
      : [{ name: 'Sheet1' }]

    try {
      const created = await db.transaction().execute(async (trx) => {
        const spreadsheet = await trx
          .insertInto('spreadsheets')
          .values({
            id: spreadsheetId,
            name: payload.name,
            owner_id: ownerId
          })
          .returningAll()
          .executeTakeFirstOrThrow()

        const sheets = []
        for (const [index, sheet] of initialSheets.entries()) {
          const sheetId = sheet.id ?? randomUUID()
          const createdSheet = await trx
            .insertInto('sheets')
            .values({
              id: sheetId,
              spreadsheet_id: spreadsheetId,
              name: sheet.name,
              order_index: index,
              row_count: 1000,
              column_count: 26,
              frozen_rows: 0,
              frozen_columns: 0
            })
            .returningAll()
            .executeTakeFirstOrThrow()
          sheets.push(createdSheet)
        }

        return { spreadsheet, sheets }
      })

      await auditLog({
        actorId: getActorId(req),
        actorType: 'user',
        action: 'create',
        resourceType: 'spreadsheet',
        resourceId: spreadsheetId,
        meta: { name: payload.name, ownerId }
      })

      return res.status(201).json({ ok: true, data: created })
    } catch (error) {
      logger.error('Failed to create spreadsheet', error as Error)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to create spreadsheet' } })
    }
  })

  r.get('/api/spreadsheets/:id', rbacGuard('spreadsheets', 'read'), async (req: Request, res: Response) => {
    const id = req.params.id

    try {
      const spreadsheet = await db
        .selectFrom('spreadsheets')
        .selectAll()
        .where('id', '=', id)
        .where('deleted_at', 'is', null)
        .executeTakeFirst()

      if (!spreadsheet) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Spreadsheet not found' } })
      }

      const sheets = await db
        .selectFrom('sheets')
        .selectAll()
        .where('spreadsheet_id', '=', id)
        .orderBy('order_index', 'asc')
        .execute()

      return res.json({ ok: true, data: { ...spreadsheet, sheets } })
    } catch (error) {
      logger.error('Failed to load spreadsheet', error as Error)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to load spreadsheet' } })
    }
  })

  r.put('/api/spreadsheets/:id', rbacGuard('spreadsheets', 'write'), async (req: Request, res: Response) => {
    const id = req.params.id
    const schema = z.object({ name: z.string().min(1).optional() })
    const parse = schema.safeParse(req.body)
    if (!parse.success) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parse.error.message } })
    }

    try {
      const existing = await db
        .selectFrom('spreadsheets')
        .selectAll()
        .where('id', '=', id)
        .where('deleted_at', 'is', null)
        .executeTakeFirst()

      if (!existing) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Sheet not found' } })
      }

      const nextName = parse.data.name ?? existing.name
      const updated = await db
        .updateTable('spreadsheets')
        .set({ name: nextName, updated_at: new Date() })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow()

      await auditLog({
        actorId: getActorId(req),
        actorType: 'user',
        action: 'update',
        resourceType: 'spreadsheet',
        resourceId: id,
        meta: { before: existing, after: updated }
      })

      return res.json({ ok: true, data: updated })
    } catch (error) {
      logger.error('Failed to update spreadsheet', error as Error)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to update spreadsheet' } })
    }
  })

  r.delete('/api/spreadsheets/:id', rbacGuard('spreadsheets', 'write'), async (req: Request, res: Response) => {
    const id = req.params.id

    try {
      const existing = await db
        .selectFrom('spreadsheets')
        .selectAll()
        .where('id', '=', id)
        .where('deleted_at', 'is', null)
        .executeTakeFirst()

      if (!existing) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Sheet not found' } })
      }

      await db
        .updateTable('spreadsheets')
        .set({ deleted_at: new Date() })
        .where('id', '=', id)
        .execute()

      await auditLog({
        actorId: getActorId(req),
        actorType: 'user',
        action: 'delete',
        resourceType: 'spreadsheet',
        resourceId: id,
        meta: { before: existing }
      })

      return res.json({ ok: true, data: { id } })
    } catch (error) {
      logger.error('Failed to delete spreadsheet', error as Error)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to delete spreadsheet' } })
    }
  })

  r.put('/api/spreadsheets/:id/sheets/:sheetId', rbacGuard('spreadsheets', 'write'), async (req: Request, res: Response) => {
    const { id, sheetId } = req.params
    const schema = z.object({
      row_count: z.number().int().min(1).optional(),
      rowCount: z.number().int().min(1).optional(),
      column_count: z.number().int().min(1).optional(),
      columnCount: z.number().int().min(1).optional()
    })
    const parse = schema.safeParse(req.body)
    if (!parse.success) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parse.error.message } })
    }

    const payload = parse.data
    const nextRowCount = payload.row_count ?? payload.rowCount
    const nextColumnCount = payload.column_count ?? payload.columnCount
    if (nextRowCount === undefined && nextColumnCount === undefined) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'No updates provided' } })
    }

    try {
      const existing = await db
        .selectFrom('sheets')
        .selectAll()
        .where('id', '=', sheetId)
        .where('spreadsheet_id', '=', id)
        .executeTakeFirst()

      if (!existing) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Sheet not found' } })
      }

      const updated = await db
        .updateTable('sheets')
        .set({
          row_count: nextRowCount ?? existing.row_count,
          column_count: nextColumnCount ?? existing.column_count,
          updated_at: new Date()
        })
        .where('id', '=', sheetId)
        .returningAll()
        .executeTakeFirstOrThrow()

      await auditLog({
        actorId: getActorId(req),
        actorType: 'user',
        action: 'update',
        resourceType: 'sheet',
        resourceId: sheetId,
        meta: { before: existing, after: updated }
      })

      return res.json({ ok: true, data: updated })
    } catch (error) {
      logger.error('Failed to update sheet metadata', error as Error)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to update sheet metadata' } })
    }
  })

  r.get('/api/spreadsheets/:id/sheets/:sheetId/cells', rbacGuard('spreadsheets', 'read'), async (req: Request, res: Response) => {
    const { id, sheetId } = req.params

    try {
      const sheet = await db
        .selectFrom('sheets')
        .selectAll()
        .where('id', '=', sheetId)
        .where('spreadsheet_id', '=', id)
        .executeTakeFirst()

      if (!sheet) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Sheet not found' } })
      }

      const cells = await db
        .selectFrom('cells')
        .selectAll()
        .where('sheet_id', '=', sheetId)
        .orderBy('row_index', 'asc')
        .orderBy('column_index', 'asc')
        .execute()

      return res.json({ ok: true, data: { sheet, cells } })
    } catch (error) {
      logger.error('Failed to load cells', error as Error)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to load cells' } })
    }
  })

  r.put('/api/spreadsheets/:id/sheets/:sheetId/cells', rbacGuard('spreadsheets', 'write'), async (req: Request, res: Response) => {
    const sheetId = req.params.sheetId
    const schema = z.object({
      cells: z.array(z.object({
        row: z.number().int().nonnegative(),
        col: z.number().int().nonnegative(),
        value: z.any().optional(),
        formula: z.string().optional(),
        dataType: z.string().optional(),
        data_type: z.string().optional()
      })).min(1)
    })
    const parse = schema.safeParse(req.body)
    if (!parse.success) {
      return res.status(400).json({ ok: false, error: { code: 'INVALID_INPUT', message: parse.error.message } })
    }

    try {
      const updatedCells = await db.transaction().execute(async (trx) => {
        const results = []
        for (const cell of parse.data.cells) {
          const existing = await trx
            .selectFrom('cells')
            .selectAll()
            .where((eb) => eb.and([
              eb('sheet_id', '=', sheetId),
              eb('row_index', '=', cell.row),
              eb('column_index', '=', cell.col)
            ]))
            .executeTakeFirst()

          const dataType = cell.dataType ?? cell.data_type ?? null
          const values = {
            sheet_id: sheetId,
            row_index: cell.row,
            column_index: cell.col,
            value: toCellValue(cell.value),
            data_type: dataType,
            formula: cell.formula ?? null
          }

          if (existing) {
            const updated = await trx
              .updateTable('cells')
              .set({ ...values, updated_at: new Date() })
              .where('id', '=', existing.id)
              .returningAll()
              .executeTakeFirstOrThrow()

            await trx
              .insertInto('cell_versions')
              .values({
                cell_id: existing.id,
                sheet_id: sheetId,
                version_number: 1,
                value: toCellValue(existing.value),
                formula: existing.formula ?? null,
                format: null,
                changed_by: getActorId(req) ?? null,
                change_type: 'update',
                change_summary: 'Cell updated'
              })
              .execute()

            results.push(updated)
            continue
          }

          const inserted = await trx
            .insertInto('cells')
            .values(values)
            .returningAll()
            .executeTakeFirstOrThrow()

          results.push(inserted)
        }
        return results
      })

      return res.json({ ok: true, data: { cells: updatedCells } })
    } catch (error) {
      logger.error('Failed to update cells', error as Error)
      return res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to update cells' } })
    }
  })

  return r
}
