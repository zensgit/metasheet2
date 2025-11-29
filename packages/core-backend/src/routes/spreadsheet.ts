// @ts-nocheck
/**
 * Spreadsheet CRUD API routes
 * Handles spreadsheets, sheets, cells, and formulas
 */

import { Router, Request, Response } from 'express'
import { db } from '../db/db'
import { v4 as uuidv4 } from 'uuid'
import { Logger } from '../core/logger'

const router = Router()
const logger = new Logger('SpreadsheetAPI')

// ============================================
// Input Validation Helpers
// ============================================
interface ValidationResult {
  valid: boolean
  errors: string[]
}

function validateSpreadsheetInput(body: any): ValidationResult {
  const errors: string[] = []

  // Validate name
  if (body.name !== undefined) {
    if (typeof body.name !== 'string') {
      errors.push('name must be a string')
    } else if (body.name.length > 255) {
      errors.push('name must not exceed 255 characters')
    } else if (body.name.trim().length === 0) {
      errors.push('name cannot be empty')
    }
  }

  // Validate description
  if (body.description !== undefined && body.description !== null) {
    if (typeof body.description !== 'string') {
      errors.push('description must be a string')
    } else if (body.description.length > 2000) {
      errors.push('description must not exceed 2000 characters')
    }
  }

  // Validate owner_id
  if (body.owner_id !== undefined) {
    if (typeof body.owner_id !== 'string' || body.owner_id.trim().length === 0) {
      errors.push('owner_id must be a non-empty string')
    }
  }

  // Validate workspace_id
  if (body.workspace_id !== undefined && body.workspace_id !== null) {
    if (typeof body.workspace_id !== 'string') {
      errors.push('workspace_id must be a string')
    }
  }

  // Validate initial_sheets
  if (body.initial_sheets !== undefined) {
    if (!Array.isArray(body.initial_sheets)) {
      errors.push('initial_sheets must be an array')
    } else if (body.initial_sheets.length > 50) {
      errors.push('initial_sheets cannot exceed 50 sheets')
    } else {
      body.initial_sheets.forEach((sheet: any, idx: number) => {
        if (sheet.name !== undefined && typeof sheet.name !== 'string') {
          errors.push(`initial_sheets[${idx}].name must be a string`)
        } else if (sheet.name && sheet.name.length > 100) {
          errors.push(`initial_sheets[${idx}].name must not exceed 100 characters`)
        }
      })
    }
  }

  return { valid: errors.length === 0, errors }
}

function validateCellUpdate(body: any): ValidationResult {
  const errors: string[] = []

  if (!body.updates || !Array.isArray(body.updates)) {
    errors.push('updates must be an array')
    return { valid: false, errors }
  }

  if (body.updates.length > 10000) {
    errors.push('updates cannot exceed 10000 cells per request')
  }

  body.updates.forEach((update: any, idx: number) => {
    if (update.row === undefined || typeof update.row !== 'number' || update.row < 0) {
      errors.push(`updates[${idx}].row must be a non-negative number`)
    }
    if (update.col === undefined || typeof update.col !== 'number' || update.col < 0) {
      errors.push(`updates[${idx}].col must be a non-negative number`)
    }
    if (update.value !== undefined && update.value !== null) {
      const valueType = typeof update.value
      if (!['string', 'number', 'boolean'].includes(valueType)) {
        errors.push(`updates[${idx}].value must be string, number, boolean, or null`)
      }
      if (valueType === 'string' && update.value.length > 50000) {
        errors.push(`updates[${idx}].value string exceeds 50000 character limit`)
      }
    }
  })

  return { valid: errors.length === 0, errors }
}

function sanitizeString(str: string, maxLength = 255): string {
  if (typeof str !== 'string') return ''
  // Remove potentially dangerous characters for XSS
  return str.replace(/[<>]/g, '').trim().slice(0, maxLength)
}

// Utility to convert column index to letter (0 -> A, 1 -> B, 25 -> Z, 26 -> AA)
function columnIndexToLetter(index: number): string {
  let letter = ''
  while (index >= 0) {
    letter = String.fromCharCode(65 + (index % 26)) + letter
    index = Math.floor(index / 26) - 1
  }
  return letter
}

// Utility to convert cell position to reference (row: 0, col: 0 -> "A1")
function getCellRef(row: number, col: number): string {
  return `${columnIndexToLetter(col)}${row + 1}`
}

// Parse cell reference to indices ("A1" -> {row: 0, col: 0})
function parseCellRef(ref: string): { row: number; col: number } {
  const match = ref.match(/^([A-Z]+)(\d+)$/)
  if (!match) throw new Error(`Invalid cell reference: ${ref}`)

  const col = match[1]
    .split('')
    .reduce((acc, char) => acc * 26 + char.charCodeAt(0) - 64, 0) - 1
  const row = parseInt(match[2]) - 1

  return { row, col }
}

/**
 * GET /api/spreadsheets
 * List all spreadsheets
 */
router.get('/spreadsheets', async (req: Request, res: Response) => {
  try {
    if (!db) {
      return res.status(503).json({
        ok: false,
        error: { code: 'DB_UNAVAILABLE', message: 'Database not configured' }
      })
    }

    const { workspace_id, owner_id, is_template } = req.query

    let query = db.selectFrom('spreadsheets').selectAll()

    if (workspace_id) {
      query = query.where('workspace_id', '=', workspace_id as string)
    }
    if (owner_id) {
      query = query.where('owner_id', '=', owner_id as string)
    }
    if (is_template !== undefined) {
      query = query.where('is_template', '=', is_template === 'true')
    }

    query = query.where('deleted_at', 'is', null)
    query = query.orderBy('updated_at', 'desc')

    const spreadsheets = await query.execute()

    res.json({
      ok: true,
      data: spreadsheets
    })
  } catch (error) {
    logger.error('Failed to list spreadsheets:', error as Error)
    res.status(500).json({
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to list spreadsheets' }
    })
  }
})

/**
 * POST /api/spreadsheets
 * Create a new spreadsheet
 */
router.post('/spreadsheets', async (req: Request, res: Response) => {
  try {
    if (!db) {
      return res.status(503).json({
        ok: false,
        error: { code: 'DB_UNAVAILABLE', message: 'Database not configured' }
      })
    }

    // Validate input
    const validation = validateSpreadsheetInput(req.body)
    if (!validation.valid) {
      return res.status(400).json({
        ok: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid input',
          details: validation.errors
        }
      })
    }

    const {
      name = 'Untitled Spreadsheet',
      description,
      owner_id,
      workspace_id,
      template_id,
      initial_sheets = [{ name: 'Sheet1' }]
    } = req.body

    // Sanitize inputs
    const sanitizedName = sanitizeString(name, 255)
    const sanitizedDescription = description ? sanitizeString(description, 2000) : undefined

    // Start transaction
    const result = await db.transaction().execute(async (trx) => {
      // Create spreadsheet
      const spreadsheet = await trx
        .insertInto('spreadsheets')
        .values({
          id: uuidv4(),
          name: sanitizedName,
          description: sanitizedDescription,
          owner_id,
          workspace_id,
          is_template: false,
          template_id,
          settings: {},
          metadata: {},
          created_by: owner_id,
          created_at: new Date(),
          updated_at: new Date()
        })
        .returningAll()
        .executeTakeFirstOrThrow()

      // Create initial sheets
      const sheets = []
      for (let i = 0; i < initial_sheets.length; i++) {
        const sheet = await trx
          .insertInto('sheets')
          .values({
            id: uuidv4(),
            spreadsheet_id: spreadsheet.id,
            name: initial_sheets[i].name || `Sheet${i + 1}`,
            order_index: i,
            row_count: 1000,
            column_count: 26,
            frozen_rows: 0,
            frozen_columns: 0,
            hidden_rows: [],
            hidden_columns: [],
            row_heights: {},
            column_widths: {},
            config: {},
            created_at: new Date(),
            updated_at: new Date()
          })
          .returningAll()
          .executeTakeFirstOrThrow()
        sheets.push(sheet)
      }

      return { spreadsheet, sheets }
    })

    res.status(201).json({
      ok: true,
      data: result
    })
  } catch (error) {
    logger.error('Failed to create spreadsheet:', error as Error)
    res.status(500).json({
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to create spreadsheet' }
    })
  }
})

/**
 * GET /api/spreadsheets/:id
 * Get spreadsheet with sheets
 */
router.get('/spreadsheets/:id', async (req: Request, res: Response) => {
  try {
    if (!db) {
      return res.status(503).json({
        ok: false,
        error: { code: 'DB_UNAVAILABLE', message: 'Database not configured' }
      })
    }

    const { id } = req.params

    const spreadsheet = await db
      .selectFrom('spreadsheets')
      .selectAll()
      .where('id', '=', id)
      .where('deleted_at', 'is', null)
      .executeTakeFirst()

    if (!spreadsheet) {
      return res.status(404).json({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Spreadsheet not found' }
      })
    }

    const sheets = await db
      .selectFrom('sheets')
      .selectAll()
      .where('spreadsheet_id', '=', id)
      .orderBy('order_index', 'asc')
      .execute()

    res.json({
      ok: true,
      data: {
        ...spreadsheet,
        sheets
      }
    })
  } catch (error) {
    logger.error('Failed to get spreadsheet:', error as Error)
    res.status(500).json({
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to get spreadsheet' }
    })
  }
})

/**
 * PUT /api/spreadsheets/:id
 * Update spreadsheet metadata
 */
router.put('/spreadsheets/:id', async (req: Request, res: Response) => {
  try {
    if (!db) {
      return res.status(503).json({
        ok: false,
        error: { code: 'DB_UNAVAILABLE', message: 'Database not configured' }
      })
    }

    const { id } = req.params
    const { name, description, settings, metadata } = req.body

    const updates: any = { updated_at: new Date() }
    if (name !== undefined) updates.name = name
    if (description !== undefined) updates.description = description
    if (settings !== undefined) updates.settings = settings
    if (metadata !== undefined) updates.metadata = metadata

    const spreadsheet = await db
      .updateTable('spreadsheets')
      .set(updates)
      .where('id', '=', id)
      .where('deleted_at', 'is', null)
      .returningAll()
      .executeTakeFirst()

    if (!spreadsheet) {
      return res.status(404).json({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Spreadsheet not found' }
      })
    }

    res.json({
      ok: true,
      data: spreadsheet
    })
  } catch (error) {
    logger.error('Failed to update spreadsheet:', error as Error)
    res.status(500).json({
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to update spreadsheet' }
    })
  }
})

/**
 * DELETE /api/spreadsheets/:id
 * Soft delete spreadsheet
 */
router.delete('/spreadsheets/:id', async (req: Request, res: Response) => {
  try {
    if (!db) {
      return res.status(503).json({
        ok: false,
        error: { code: 'DB_UNAVAILABLE', message: 'Database not configured' }
      })
    }

    const { id } = req.params

    const spreadsheet = await db
      .updateTable('spreadsheets')
      .set({
        deleted_at: new Date(),
        updated_at: new Date()
      })
      .where('id', '=', id)
      .where('deleted_at', 'is', null)
      .returningAll()
      .executeTakeFirst()

    if (!spreadsheet) {
      return res.status(404).json({
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Spreadsheet not found' }
      })
    }

    res.json({
      ok: true,
      message: 'Spreadsheet deleted successfully'
    })
  } catch (error) {
    logger.error('Failed to delete spreadsheet:', error as Error)
    res.status(500).json({
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to delete spreadsheet' }
    })
  }
})

/**
 * GET /api/spreadsheets/:spreadsheetId/sheets/:sheetId/cells
 * Get cells for a sheet
 */
router.get('/spreadsheets/:spreadsheetId/sheets/:sheetId/cells', async (req: Request, res: Response) => {
  try {
    if (!db) {
      return res.status(503).json({
        ok: false,
        error: { code: 'DB_UNAVAILABLE', message: 'Database not configured' }
      })
    }

    const { sheetId } = req.params
    const {
      startRow = 0,
      endRow = 100,
      startCol = 0,
      endCol = 26
    } = req.query

    const cells = await db
      .selectFrom('cells')
      .selectAll()
      .where('sheet_id', '=', sheetId)
      .where('row_index', '>=', Number(startRow))
      .where('row_index', '<=', Number(endRow))
      .where('column_index', '>=', Number(startCol))
      .where('column_index', '<=', Number(endCol))
      .orderBy('row_index', 'asc')
      .orderBy('column_index', 'asc')
      .execute()

    // Convert to grid format for frontend
    const grid: any = {}
    cells.forEach(cell => {
      if (!grid[cell.row_index]) grid[cell.row_index] = {}
      grid[cell.row_index][cell.column_index] = {
        value: cell.value,
        formula: cell.formula,
        format: cell.format,
        dataType: cell.data_type,
        locked: cell.locked,
        comment: cell.comment
      }
    })

    res.json({
      ok: true,
      data: {
        cells,
        grid
      }
    })
  } catch (error) {
    logger.error('Failed to get cells:', error as Error)
    res.status(500).json({
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to get cells' }
    })
  }
})

/**
 * PUT /api/spreadsheets/:spreadsheetId/sheets/:sheetId/cells
 * Update multiple cells
 */
router.put('/spreadsheets/:spreadsheetId/sheets/:sheetId/cells', async (req: Request, res: Response) => {
  try {
    if (!db) {
      return res.status(503).json({
        ok: false,
        error: { code: 'DB_UNAVAILABLE', message: 'Database not configured' }
      })
    }

    const { sheetId } = req.params
    const { cells } = req.body

    // Validate cells array
    if (!Array.isArray(cells)) {
      return res.status(400).json({
        ok: false,
        error: { code: 'INVALID_INPUT', message: 'cells must be an array' }
      })
    }

    // Validate cell update payload
    const validation = validateCellUpdate({ updates: cells })
    if (!validation.valid) {
      return res.status(400).json({
        ok: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid cell data',
          details: validation.errors
        }
      })
    }

    const result = await db.transaction().execute(async (trx) => {
      const updatedCells = []

      for (const cellData of cells) {
        const { row, col, value, formula, format, dataType } = cellData
        const cellRef = getCellRef(row, col)

        // Check if cell exists
        const existingCell = await trx
          .selectFrom('cells')
          .selectAll()
          .where('sheet_id', '=', sheetId)
          .where('row_index', '=', row)
          .where('column_index', '=', col)
          .executeTakeFirst()

        let cell
        if (existingCell) {
          // Update existing cell
          cell = await trx
            .updateTable('cells')
            .set({
              value: value !== undefined ? value : existingCell.value,
              formula: formula !== undefined ? formula : existingCell.formula,
              format: format !== undefined ? format : existingCell.format,
              data_type: dataType || 'text',
              display_value: value?.toString() || null,
              updated_at: new Date()
            })
            .where('id', '=', existingCell.id)
            .returningAll()
            .executeTakeFirstOrThrow()

          // Save version history with proper version increment
          // Get the latest version number for this cell
          const latestVersion = await trx
            .selectFrom('cell_versions')
            .select('version_number')
            .where('cell_id', '=', existingCell.id)
            .orderBy('version_number', 'desc')
            .limit(1)
            .executeTakeFirst()

          const nextVersionNumber = (latestVersion?.version_number || 0) + 1

          await trx
            .insertInto('cell_versions')
            .values({
              id: uuidv4(),
              cell_id: existingCell.id,
              sheet_id: sheetId,
              version_number: nextVersionNumber,
              value: existingCell.value,
              formula: existingCell.formula,
              format: existingCell.format,
              change_type: 'update',
              created_at: new Date()
            })
            .execute()
        } else {
          // Create new cell
          cell = await trx
            .insertInto('cells')
            .values({
              id: uuidv4(),
              sheet_id: sheetId,
              row_index: row,
              column_index: col,
              cell_ref: cellRef,
              value: value || null,
              formula: formula || null,
              format: format || {},
              data_type: dataType || 'text',
              display_value: value?.toString() || null,
              locked: false,
              metadata: {},
              updated_at: new Date()
            })
            .returningAll()
            .executeTakeFirstOrThrow()
        }

        // Handle formula dependencies
        if (formula) {
          await handleFormula(trx, cell.id, sheetId, formula)
        }

        updatedCells.push(cell)
      }

      return updatedCells
    })

    res.json({
      ok: true,
      data: result
    })
  } catch (error) {
    logger.error('Failed to update cells:', error as Error)
    res.status(500).json({
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to update cells' }
    })
  }
})

/**
 * POST /api/spreadsheets/:spreadsheetId/sheets
 * Add a new sheet
 */
router.post('/spreadsheets/:spreadsheetId/sheets', async (req: Request, res: Response) => {
  try {
    if (!db) {
      return res.status(503).json({
        ok: false,
        error: { code: 'DB_UNAVAILABLE', message: 'Database not configured' }
      })
    }

    const { spreadsheetId } = req.params
    const { name = 'New Sheet', rowCount = 1000, columnCount = 26 } = req.body

    // Get max order index
    const maxOrderResult = await db
      .selectFrom('sheets')
      .select(db.fn.max('order_index').as('max_order'))
      .where('spreadsheet_id', '=', spreadsheetId)
      .executeTakeFirst()

    const orderIndex = (maxOrderResult?.max_order ?? -1) + 1

    const sheet = await db
      .insertInto('sheets')
      .values({
        id: uuidv4(),
        spreadsheet_id: spreadsheetId,
        name,
        order_index: orderIndex,
        row_count: rowCount,
        column_count: columnCount,
        frozen_rows: 0,
        frozen_columns: 0,
        hidden_rows: [],
        hidden_columns: [],
        row_heights: {},
        column_widths: {},
        config: {},
        created_at: new Date(),
        updated_at: new Date()
      })
      .returningAll()
      .executeTakeFirstOrThrow()

    res.status(201).json({
      ok: true,
      data: sheet
    })
  } catch (error) {
    logger.error('Failed to create sheet:', error as Error)
    res.status(500).json({
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to create sheet' }
    })
  }
})

// Helper function to handle formula parsing and dependencies
async function handleFormula(trx: any, cellId: string, sheetId: string, formulaText: string) {
  // Parse formula to extract dependencies
  const dependencies = extractDependencies(formulaText)

  // Check if formula record exists
  const existingFormula = await trx
    .selectFrom('formulas')
    .selectAll()
    .where('cell_id', '=', cellId)
    .executeTakeFirst()

  if (existingFormula) {
    // Update existing formula
    await trx
      .updateTable('formulas')
      .set({
        formula_text: formulaText,
        dependencies,
        updated_at: new Date()
      })
      .where('id', '=', existingFormula.id)
      .execute()
  } else {
    // Create new formula record
    await trx
      .insertInto('formulas')
      .values({
        id: uuidv4(),
        cell_id: cellId,
        sheet_id: sheetId,
        formula_text: formulaText,
        dependencies,
        dependents: [],
        is_volatile: isVolatileFormula(formulaText),
        created_at: new Date(),
        updated_at: new Date()
      })
      .execute()
  }

  // Update dependents of referenced cells
  for (const depRef of dependencies) {
    // Find the cell being referenced
    const referencedCell = await trx
      .selectFrom('cells')
      .select(['id'])
      .where('sheet_id', '=', sheetId)
      .where('cell_ref', '=', depRef)
      .executeTakeFirst()

    if (referencedCell) {
      // Get the formula record for the referenced cell
      const refFormula = await trx
        .selectFrom('formulas')
        .selectAll()
        .where('cell_id', '=', referencedCell.id)
        .executeTakeFirst()

      if (refFormula) {
        // Add current cell to the dependents list
        const currentDependents = Array.isArray(refFormula.dependents) ? refFormula.dependents : []
        if (!currentDependents.includes(cellId)) {
          await trx
            .updateTable('formulas')
            .set({
              dependents: [...currentDependents, cellId],
              updated_at: new Date()
            })
            .where('id', '=', refFormula.id)
            .execute()
        }
      }
    }
  }

  // Trigger recalculation for cells that depend on this cell
  await triggerRecalculation(trx, cellId, sheetId)
}

// Trigger recalculation for dependent cells
async function triggerRecalculation(trx: any, cellId: string, sheetId: string, visited: Set<string> = new Set()) {
  // Prevent infinite loops in circular references
  if (visited.has(cellId)) {
    logger.warn(`Circular reference detected for cell ${cellId}`)
    return
  }
  visited.add(cellId)

  // Find formulas that depend on this cell
  const dependentFormulas = await trx
    .selectFrom('formulas')
    .selectAll()
    .where('sheet_id', '=', sheetId)
    .execute()

  for (const formula of dependentFormulas) {
    const dependents = Array.isArray(formula.dependents) ? formula.dependents : []
    if (dependents.includes(cellId)) {
      // Mark the dependent cell for recalculation
      await trx
        .updateTable('cells')
        .set({
          needs_recalc: true,
          updated_at: new Date()
        })
        .where('id', '=', formula.cell_id)
        .execute()

      // Recursively trigger recalculation for cells that depend on this one
      await triggerRecalculation(trx, formula.cell_id, sheetId, visited)
    }
  }
}

// Extract cell references from formula
function extractDependencies(formula: string): string[] {
  const refs: string[] = []
  const pattern = /\b[A-Z]+\d+\b/g
  const matches = formula.match(pattern)
  if (matches) {
    refs.push(...matches)
  }
  return [...new Set(refs)] // Remove duplicates
}

// Check if formula contains volatile functions
function isVolatileFormula(formula: string): boolean {
  const volatileFunctions = ['NOW', 'TODAY', 'RAND', 'RANDBETWEEN']
  return volatileFunctions.some(fn => formula.toUpperCase().includes(fn))
}

export default router