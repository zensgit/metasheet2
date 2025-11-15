"use strict";
/**
 * Spreadsheet CRUD API routes
 * Handles spreadsheets, sheets, cells, and formulas
 */
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const db_1 = require("../db/db");
const uuid_1 = require("uuid");
const logger_1 = require("../core/logger");
const router = (0, express_1.Router)();
const logger = new logger_1.Logger('SpreadsheetAPI');
// Utility to convert column index to letter (0 -> A, 1 -> B, 25 -> Z, 26 -> AA)
function columnIndexToLetter(index) {
    let letter = '';
    while (index >= 0) {
        letter = String.fromCharCode(65 + (index % 26)) + letter;
        index = Math.floor(index / 26) - 1;
    }
    return letter;
}
// Utility to convert cell position to reference (row: 0, col: 0 -> "A1")
function getCellRef(row, col) {
    return `${columnIndexToLetter(col)}${row + 1}`;
}
// Parse cell reference to indices ("A1" -> {row: 0, col: 0})
function parseCellRef(ref) {
    const match = ref.match(/^([A-Z]+)(\d+)$/);
    if (!match)
        throw new Error(`Invalid cell reference: ${ref}`);
    const col = match[1]
        .split('')
        .reduce((acc, char) => acc * 26 + char.charCodeAt(0) - 64, 0) - 1;
    const row = parseInt(match[2]) - 1;
    return { row, col };
}
/**
 * GET /api/spreadsheets
 * List all spreadsheets
 */
router.get('/spreadsheets', async (req, res) => {
    try {
        if (!db_1.db) {
            return res.status(503).json({
                ok: false,
                error: { code: 'DB_UNAVAILABLE', message: 'Database not configured' }
            });
        }
        const { workspace_id, owner_id, is_template } = req.query;
        let query = db_1.db.selectFrom('spreadsheets').selectAll();
        if (workspace_id) {
            query = query.where('workspace_id', '=', workspace_id);
        }
        if (owner_id) {
            query = query.where('owner_id', '=', owner_id);
        }
        if (is_template !== undefined) {
            query = query.where('is_template', '=', is_template === 'true');
        }
        query = query.where('deleted_at', 'is', null);
        query = query.orderBy('updated_at', 'desc');
        const spreadsheets = await query.execute();
        res.json({
            ok: true,
            data: spreadsheets
        });
    }
    catch (error) {
        logger.error('Failed to list spreadsheets:', error);
        res.status(500).json({
            ok: false,
            error: { code: 'INTERNAL_ERROR', message: 'Failed to list spreadsheets' }
        });
    }
});
/**
 * POST /api/spreadsheets
 * Create a new spreadsheet
 */
router.post('/spreadsheets', async (req, res) => {
    try {
        if (!db_1.db) {
            return res.status(503).json({
                ok: false,
                error: { code: 'DB_UNAVAILABLE', message: 'Database not configured' }
            });
        }
        const { name = 'Untitled Spreadsheet', description, owner_id, workspace_id, template_id, initial_sheets = [{ name: 'Sheet1' }] } = req.body;
        // Start transaction
        const result = await db_1.db.transaction().execute(async (trx) => {
            // Create spreadsheet
            const spreadsheet = await trx
                .insertInto('spreadsheets')
                .values({
                id: (0, uuid_1.v4)(),
                name,
                description,
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
                .executeTakeFirstOrThrow();
            // Create initial sheets
            const sheets = [];
            for (let i = 0; i < initial_sheets.length; i++) {
                const sheet = await trx
                    .insertInto('sheets')
                    .values({
                    id: (0, uuid_1.v4)(),
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
                    .executeTakeFirstOrThrow();
                sheets.push(sheet);
            }
            return { spreadsheet, sheets };
        });
        res.status(201).json({
            ok: true,
            data: result
        });
    }
    catch (error) {
        logger.error('Failed to create spreadsheet:', error);
        res.status(500).json({
            ok: false,
            error: { code: 'INTERNAL_ERROR', message: 'Failed to create spreadsheet' }
        });
    }
});
/**
 * GET /api/spreadsheets/:id
 * Get spreadsheet with sheets
 */
router.get('/spreadsheets/:id', async (req, res) => {
    try {
        if (!db_1.db) {
            return res.status(503).json({
                ok: false,
                error: { code: 'DB_UNAVAILABLE', message: 'Database not configured' }
            });
        }
        const { id } = req.params;
        const spreadsheet = await db_1.db
            .selectFrom('spreadsheets')
            .selectAll()
            .where('id', '=', id)
            .where('deleted_at', 'is', null)
            .executeTakeFirst();
        if (!spreadsheet) {
            return res.status(404).json({
                ok: false,
                error: { code: 'NOT_FOUND', message: 'Spreadsheet not found' }
            });
        }
        const sheets = await db_1.db
            .selectFrom('sheets')
            .selectAll()
            .where('spreadsheet_id', '=', id)
            .orderBy('order_index', 'asc')
            .execute();
        res.json({
            ok: true,
            data: {
                ...spreadsheet,
                sheets
            }
        });
    }
    catch (error) {
        logger.error('Failed to get spreadsheet:', error);
        res.status(500).json({
            ok: false,
            error: { code: 'INTERNAL_ERROR', message: 'Failed to get spreadsheet' }
        });
    }
});
/**
 * PUT /api/spreadsheets/:id
 * Update spreadsheet metadata
 */
router.put('/spreadsheets/:id', async (req, res) => {
    try {
        if (!db_1.db) {
            return res.status(503).json({
                ok: false,
                error: { code: 'DB_UNAVAILABLE', message: 'Database not configured' }
            });
        }
        const { id } = req.params;
        const { name, description, settings, metadata } = req.body;
        const updates = { updated_at: new Date() };
        if (name !== undefined)
            updates.name = name;
        if (description !== undefined)
            updates.description = description;
        if (settings !== undefined)
            updates.settings = settings;
        if (metadata !== undefined)
            updates.metadata = metadata;
        const spreadsheet = await db_1.db
            .updateTable('spreadsheets')
            .set(updates)
            .where('id', '=', id)
            .where('deleted_at', 'is', null)
            .returningAll()
            .executeTakeFirst();
        if (!spreadsheet) {
            return res.status(404).json({
                ok: false,
                error: { code: 'NOT_FOUND', message: 'Spreadsheet not found' }
            });
        }
        res.json({
            ok: true,
            data: spreadsheet
        });
    }
    catch (error) {
        logger.error('Failed to update spreadsheet:', error);
        res.status(500).json({
            ok: false,
            error: { code: 'INTERNAL_ERROR', message: 'Failed to update spreadsheet' }
        });
    }
});
/**
 * DELETE /api/spreadsheets/:id
 * Soft delete spreadsheet
 */
router.delete('/spreadsheets/:id', async (req, res) => {
    try {
        if (!db_1.db) {
            return res.status(503).json({
                ok: false,
                error: { code: 'DB_UNAVAILABLE', message: 'Database not configured' }
            });
        }
        const { id } = req.params;
        const spreadsheet = await db_1.db
            .updateTable('spreadsheets')
            .set({
            deleted_at: new Date(),
            updated_at: new Date()
        })
            .where('id', '=', id)
            .where('deleted_at', 'is', null)
            .returningAll()
            .executeTakeFirst();
        if (!spreadsheet) {
            return res.status(404).json({
                ok: false,
                error: { code: 'NOT_FOUND', message: 'Spreadsheet not found' }
            });
        }
        res.json({
            ok: true,
            message: 'Spreadsheet deleted successfully'
        });
    }
    catch (error) {
        logger.error('Failed to delete spreadsheet:', error);
        res.status(500).json({
            ok: false,
            error: { code: 'INTERNAL_ERROR', message: 'Failed to delete spreadsheet' }
        });
    }
});
/**
 * GET /api/spreadsheets/:spreadsheetId/sheets/:sheetId/cells
 * Get cells for a sheet
 */
router.get('/spreadsheets/:spreadsheetId/sheets/:sheetId/cells', async (req, res) => {
    try {
        if (!db_1.db) {
            return res.status(503).json({
                ok: false,
                error: { code: 'DB_UNAVAILABLE', message: 'Database not configured' }
            });
        }
        const { sheetId } = req.params;
        const { startRow = 0, endRow = 100, startCol = 0, endCol = 26 } = req.query;
        const cells = await db_1.db
            .selectFrom('cells')
            .selectAll()
            .where('sheet_id', '=', sheetId)
            .where('row_index', '>=', Number(startRow))
            .where('row_index', '<=', Number(endRow))
            .where('column_index', '>=', Number(startCol))
            .where('column_index', '<=', Number(endCol))
            .orderBy('row_index', 'asc')
            .orderBy('column_index', 'asc')
            .execute();
        // Convert to grid format for frontend
        const grid = {};
        cells.forEach(cell => {
            if (!grid[cell.row_index])
                grid[cell.row_index] = {};
            grid[cell.row_index][cell.column_index] = {
                value: cell.value,
                formula: cell.formula,
                format: cell.format,
                dataType: cell.data_type,
                locked: cell.locked,
                comment: cell.comment
            };
        });
        res.json({
            ok: true,
            data: {
                cells,
                grid
            }
        });
    }
    catch (error) {
        logger.error('Failed to get cells:', error);
        res.status(500).json({
            ok: false,
            error: { code: 'INTERNAL_ERROR', message: 'Failed to get cells' }
        });
    }
});
/**
 * PUT /api/spreadsheets/:spreadsheetId/sheets/:sheetId/cells
 * Update multiple cells
 */
router.put('/spreadsheets/:spreadsheetId/sheets/:sheetId/cells', async (req, res) => {
    try {
        if (!db_1.db) {
            return res.status(503).json({
                ok: false,
                error: { code: 'DB_UNAVAILABLE', message: 'Database not configured' }
            });
        }
        const { sheetId } = req.params;
        const { cells } = req.body;
        if (!Array.isArray(cells)) {
            return res.status(400).json({
                ok: false,
                error: { code: 'INVALID_INPUT', message: 'cells must be an array' }
            });
        }
        const result = await db_1.db.transaction().execute(async (trx) => {
            const updatedCells = [];
            for (const cellData of cells) {
                const { row, col, value, formula, format, dataType } = cellData;
                const cellRef = getCellRef(row, col);
                // Check if cell exists
                const existingCell = await trx
                    .selectFrom('cells')
                    .selectAll()
                    .where('sheet_id', '=', sheetId)
                    .where('row_index', '=', row)
                    .where('column_index', '=', col)
                    .executeTakeFirst();
                let cell;
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
                        .executeTakeFirstOrThrow();
                    // Save version history
                    await trx
                        .insertInto('cell_versions')
                        .values({
                        id: (0, uuid_1.v4)(),
                        cell_id: existingCell.id,
                        sheet_id: sheetId,
                        version_number: 1, // TODO: Increment properly
                        value: existingCell.value,
                        formula: existingCell.formula,
                        format: existingCell.format,
                        change_type: 'update',
                        created_at: new Date()
                    })
                        .execute();
                }
                else {
                    // Create new cell
                    cell = await trx
                        .insertInto('cells')
                        .values({
                        id: (0, uuid_1.v4)(),
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
                        .executeTakeFirstOrThrow();
                }
                // Handle formula dependencies
                if (formula) {
                    await handleFormula(trx, cell.id, sheetId, formula);
                }
                updatedCells.push(cell);
            }
            return updatedCells;
        });
        res.json({
            ok: true,
            data: result
        });
    }
    catch (error) {
        logger.error('Failed to update cells:', error);
        res.status(500).json({
            ok: false,
            error: { code: 'INTERNAL_ERROR', message: 'Failed to update cells' }
        });
    }
});
/**
 * POST /api/spreadsheets/:spreadsheetId/sheets
 * Add a new sheet
 */
router.post('/spreadsheets/:spreadsheetId/sheets', async (req, res) => {
    try {
        if (!db_1.db) {
            return res.status(503).json({
                ok: false,
                error: { code: 'DB_UNAVAILABLE', message: 'Database not configured' }
            });
        }
        const { spreadsheetId } = req.params;
        const { name = 'New Sheet', rowCount = 1000, columnCount = 26 } = req.body;
        // Get max order index
        const maxOrderResult = await db_1.db
            .selectFrom('sheets')
            .select(db_1.db.fn.max('order_index').as('max_order'))
            .where('spreadsheet_id', '=', spreadsheetId)
            .executeTakeFirst();
        const orderIndex = (maxOrderResult?.max_order ?? -1) + 1;
        const sheet = await db_1.db
            .insertInto('sheets')
            .values({
            id: (0, uuid_1.v4)(),
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
            .executeTakeFirstOrThrow();
        res.status(201).json({
            ok: true,
            data: sheet
        });
    }
    catch (error) {
        logger.error('Failed to create sheet:', error);
        res.status(500).json({
            ok: false,
            error: { code: 'INTERNAL_ERROR', message: 'Failed to create sheet' }
        });
    }
});
// Helper function to handle formula parsing and dependencies
async function handleFormula(trx, cellId, sheetId, formulaText) {
    // Parse formula to extract dependencies
    const dependencies = extractDependencies(formulaText);
    // Check if formula record exists
    const existingFormula = await trx
        .selectFrom('formulas')
        .selectAll()
        .where('cell_id', '=', cellId)
        .executeTakeFirst();
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
            .execute();
    }
    else {
        // Create new formula record
        await trx
            .insertInto('formulas')
            .values({
            id: (0, uuid_1.v4)(),
            cell_id: cellId,
            sheet_id: sheetId,
            formula_text: formulaText,
            dependencies,
            dependents: [],
            is_volatile: isVolatileFormula(formulaText),
            created_at: new Date(),
            updated_at: new Date()
        })
            .execute();
    }
    // TODO: Update dependents of referenced cells
    // TODO: Trigger recalculation
}
// Extract cell references from formula
function extractDependencies(formula) {
    const refs = [];
    const pattern = /\b[A-Z]+\d+\b/g;
    const matches = formula.match(pattern);
    if (matches) {
        refs.push(...matches);
    }
    return [...new Set(refs)]; // Remove duplicates
}
// Check if formula contains volatile functions
function isVolatileFormula(formula) {
    const volatileFunctions = ['NOW', 'TODAY', 'RAND', 'RANDBETWEEN'];
    return volatileFunctions.some(fn => formula.toUpperCase().includes(fn));
}
exports.default = router;
//# sourceMappingURL=spreadsheet.js.map