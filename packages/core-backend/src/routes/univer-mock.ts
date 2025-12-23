import type { Request, Response } from 'express'
import { randomUUID } from 'crypto'
import { Router } from 'express'
import { z } from 'zod'

type UniverMockField = {
  id: string
  name: string
  type: 'string' | 'number' | 'boolean' | 'formula' | 'select' | 'link'
  options?: Array<{ value: string; color?: string }>
}

type UniverMockRecord = {
  id: string
  version: number
  data: Record<string, unknown>
}

type UniverMockView = {
  id: string
  fields: UniverMockField[]
  rows: UniverMockRecord[]
}

const baseView: UniverMockView = {
  id: 'univer_demo_view',
  fields: [
    { id: 'name', name: '产品名称', type: 'string' },
    { id: 'qty', name: '数量', type: 'number' },
    { id: 'price', name: '单价', type: 'number' },
    { id: 'total', name: '总价', type: 'formula' },
    {
      id: 'priority',
      name: '优先级',
      type: 'select',
      options: [
        { value: 'P0', color: '#ff4d4f' },
        { value: 'P1', color: '#faad14' },
        { value: 'P2', color: '#1677ff' },
        { value: 'Done', color: '#52c41a' },
      ],
    },
    { id: 'related', name: '关联', type: 'link' },
  ],
  rows: [
    { id: 'rec_1', version: 1, data: { name: '产品A', qty: 10, price: 100, total: '=B1*C1', priority: 'P0', related: 'PLM#6' } },
    { id: 'rec_2', version: 1, data: { name: '产品B', qty: 20, price: 150, total: '=B2*C2', priority: 'P1', related: 'PLM#7' } },
    { id: 'rec_3', version: 1, data: { name: '产品C', qty: 15, price: 200, total: '=B3*C3', priority: 'P2', related: 'PLM#8' } },
    { id: 'rec_4', version: 1, data: { name: '产品D', qty: 25, price: 120, total: '=B4*C4', priority: 'P1', related: 'PLM#9' } },
    { id: 'rec_5', version: 1, data: { name: '合计', qty: '', price: '', total: '=SUM(D1:D4)', priority: '', related: '' } },
  ],
}

const views = new Map<string, UniverMockView>()
views.set(baseView.id, baseView)

function parsePositiveInt(value: unknown, fallback: number, opts?: { min?: number; max?: number }): number {
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : Number.NaN
  const min = opts?.min ?? 1
  const max = opts?.max ?? Number.MAX_SAFE_INTEGER
  if (!Number.isFinite(parsed) || parsed < min) return fallback
  return Math.min(parsed, max)
}

function getDefaultPerfViewId(rows: number, cols: number): string {
  return `univer_perf_${rows}x${cols}`
}

function generatePerfView(viewId: string, rows: number, cols: number, mode: 'core' | 'full'): UniverMockView {
  const selectOptions = [
    { value: 'P0', color: '#ff4d4f' },
    { value: 'P1', color: '#faad14' },
    { value: 'P2', color: '#1677ff' },
    { value: 'Done', color: '#52c41a' },
  ]

  const fields: UniverMockField[] = []
  if (cols >= 1) fields.push({ id: 'name', name: '产品名称', type: 'string' })
  if (cols >= 2) fields.push({ id: 'qty', name: '数量', type: 'number' })
  if (cols >= 3) fields.push({ id: 'price', name: '单价', type: 'number' })
  if (cols >= 4) fields.push({ id: 'total', name: '总价', type: 'formula' })
  if (cols >= 5) fields.push({ id: 'priority', name: '优先级', type: 'select', options: selectOptions })
  if (cols >= 6) fields.push({ id: 'related', name: '关联', type: 'link' })

  for (let c = fields.length; c < cols; c += 1) {
    const idx = c + 1
    fields.push({ id: `n_${idx}`, name: `数值${idx}`, type: 'number' })
  }

  const rowsData: UniverMockRecord[] = []
  for (let r = 0; r < rows; r += 1) {
    const rowNumber1 = r + 1
    const qty = (r % 100) + 1
    const price = 50 + (r % 20) * 5
    const priority = selectOptions[r % selectOptions.length]?.value ?? 'P1'
    const related = `PLM#${(r % 10) + 1}`

    const data: Record<string, unknown> = {}
    if (cols >= 1) data.name = `产品${rowNumber1}`
    if (cols >= 2) data.qty = qty
    if (cols >= 3) data.price = price
    if (cols >= 4) data.total = `=B${rowNumber1}*C${rowNumber1}`
    if (cols >= 5) data.priority = priority
    if (cols >= 6) data.related = related

    if (mode === 'full') {
      for (const field of fields) {
        if (field.id.startsWith('n_')) {
          // Make numbers deterministic but not constant
          data[field.id] = qty * (Number.parseInt(field.id.slice(2), 10) || 1)
        }
      }
    }

    rowsData.push({ id: `rec_${rowNumber1}`, version: 1, data })
  }

  return { id: viewId, fields, rows: rowsData }
}

export function univerMockRouter(): Router {
  const router = Router()

  router.get('/view', (req: Request, res: Response) => {
    const rowsParam = req.query.rows
    const colsParam = req.query.cols
    const viewIdParam = typeof req.query.viewId === 'string' ? req.query.viewId : undefined
    const modeParam = typeof req.query.mode === 'string' ? req.query.mode : undefined
    const refresh = req.query.refresh === 'true'

    const hasPerfParams = typeof rowsParam !== 'undefined' || typeof colsParam !== 'undefined'
    if (hasPerfParams) {
      const rows = parsePositiveInt(rowsParam, 10000, { min: 1, max: 200000 })
      const cols = parsePositiveInt(colsParam, 50, { min: 1, max: 200 })
      const viewId = viewIdParam ?? getDefaultPerfViewId(rows, cols)
      const mode = modeParam === 'core' ? 'core' : 'full'
      if (refresh || !views.has(viewId)) {
        views.set(viewId, generatePerfView(viewId, rows, cols, mode))
      }
      return res.json({ ok: true, data: views.get(viewId) })
    }

    const viewId = viewIdParam ?? baseView.id
    const view = views.get(viewId)
    if (!view) {
      return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `View not found: ${viewId}` } })
    }

    res.json({
      ok: true,
      data: view,
    })
  })

  router.get('/record', (req: Request, res: Response) => {
    const viewId = typeof req.query.viewId === 'string' && req.query.viewId.trim() ? req.query.viewId : baseView.id
    const recordId = typeof req.query.recordId === 'string' ? req.query.recordId : ''
    if (!recordId) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'recordId is required' } })
    }

    const view = views.get(viewId)
    if (!view) {
      return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `View not found: ${viewId}` } })
    }

    const record = view.rows.find(r => r.id === recordId)
    if (!record) {
      return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Record not found: ${recordId}` } })
    }

    return res.json({ ok: true, data: record })
  })

  router.post('/records', (req: Request, res: Response) => {
    const schema = z.object({
      viewId: z.string().min(1).optional(),
      data: z.record(z.unknown()).optional(),
    })

    const parsed = schema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
    }

    const viewId = parsed.data.viewId ?? baseView.id
    const view = views.get(viewId)
    if (!view) {
      return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `View not found: ${viewId}` } })
    }

    const fieldById = new Map(view.fields.map(f => [f.id, f]))
    const data = parsed.data.data ?? {}
    const patch: Record<string, unknown> = {}

    for (const [fieldId, value] of Object.entries(data)) {
      const field = fieldById.get(fieldId)
      if (!field) {
        return res.status(400).json({
          ok: false,
          error: { code: 'VALIDATION_ERROR', message: `Unknown fieldId: ${fieldId}` },
        })
      }

      if (field.type === 'select') {
        if (typeof value !== 'string') {
          return res.status(400).json({
            ok: false,
            error: { code: 'VALIDATION_ERROR', message: `Select value must be string: ${fieldId}` },
          })
        }
        const allowed = new Set((field.options ?? []).map(o => o.value))
        if (value !== '' && !allowed.has(value)) {
          return res.status(400).json({
            ok: false,
            error: { code: 'VALIDATION_ERROR', message: `Invalid select option for ${fieldId}: ${value}` },
          })
        }
      }

      if (field.type === 'link' && typeof value !== 'string') {
        return res.status(400).json({
          ok: false,
          error: { code: 'VALIDATION_ERROR', message: `Link value must be string: ${fieldId}` },
        })
      }

      if (field.type === 'formula') {
        if (typeof value !== 'string') continue
        if (value !== '' && !value.startsWith('=')) continue
      }

      patch[fieldId] = value
    }

    const recordId = `rec_${randomUUID()}`
    const record: UniverMockRecord = { id: recordId, version: 1, data: patch }
    view.rows.push(record)

    return res.json({ ok: true, data: { record } })
  })

  router.delete('/records/:recordId', (req: Request, res: Response) => {
    const recordId = typeof req.params.recordId === 'string' ? req.params.recordId : ''
    if (!recordId) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'recordId is required' } })
    }

    const viewId = typeof req.query.viewId === 'string' && req.query.viewId.trim() ? req.query.viewId : baseView.id
    const expectedRaw = typeof req.query.expectedVersion === 'string' ? Number.parseInt(req.query.expectedVersion, 10) : Number.NaN
    const expectedVersion = Number.isFinite(expectedRaw) ? expectedRaw : undefined

    const view = views.get(viewId)
    if (!view) {
      return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `View not found: ${viewId}` } })
    }

    const idx = view.rows.findIndex(r => r.id === recordId)
    if (idx < 0) {
      return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Record not found: ${recordId}` } })
    }

    const record = view.rows[idx]
    if (typeof expectedVersion === 'number' && expectedVersion !== record.version) {
      return res.status(409).json({
        ok: false,
        error: {
          code: 'VERSION_CONFLICT',
          message: `Version conflict for ${recordId}`,
          serverVersion: record.version,
        },
      })
    }

    view.rows.splice(idx, 1)
    return res.json({ ok: true, data: { deleted: recordId } })
  })

  router.post('/patch', (req: Request, res: Response) => {
    const schema = z.object({
      viewId: z.string().min(1).optional(),
      changes: z.array(z.object({
        recordId: z.string().min(1),
        fieldId: z.string().min(1),
        value: z.unknown(),
        expectedVersion: z.number().int().nonnegative().optional(),
      })).min(1),
    })

    const parsed = schema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: parsed.error.message } })
    }

    const viewId = parsed.data.viewId ?? baseView.id
    const view = views.get(viewId)
    if (!view) {
      return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `View not found: ${viewId}` } })
    }

    const recordById = new Map(view.rows.map(r => [r.id, r]))
    const fieldById = new Map(view.fields.map(f => [f.id, f]))

    const changesByRecord = new Map<string, typeof parsed.data.changes>()
    for (const change of parsed.data.changes) {
      const list = changesByRecord.get(change.recordId)
      if (list) list.push(change)
      else changesByRecord.set(change.recordId, [change])
    }

    // Pre-validate (atomic behavior): record/field existence + expectedVersion per record.
    for (const [recordId, changes] of changesByRecord.entries()) {
      const record = recordById.get(recordId)
      if (!record) {
        return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `Record not found: ${recordId}` } })
      }

      const expectedVersions = Array.from(new Set(changes.map(c => c.expectedVersion).filter((v): v is number => typeof v === 'number')))
      if (expectedVersions.length > 1) {
        return res.status(400).json({
          ok: false,
          error: { code: 'VALIDATION_ERROR', message: `Multiple expectedVersion values provided for ${recordId}` },
        })
      }

      if (expectedVersions.length === 1 && expectedVersions[0] !== record.version) {
        return res.status(409).json({
          ok: false,
          error: {
            code: 'VERSION_CONFLICT',
            message: `Version conflict for ${recordId}`,
            serverVersion: record.version,
          },
        })
      }

      for (const change of changes) {
        const field = fieldById.get(change.fieldId)
        if (!field) {
          return res.status(400).json({
            ok: false,
            error: { code: 'VALIDATION_ERROR', message: `Unknown fieldId: ${change.fieldId}` },
          })
        }

        if (field.type === 'select') {
          if (typeof change.value !== 'string') {
            return res.status(400).json({
              ok: false,
              error: { code: 'VALIDATION_ERROR', message: `Select value must be string: ${change.fieldId}` },
            })
          }
          const allowed = new Set((field.options ?? []).map(o => o.value))
          if (change.value !== '' && !allowed.has(change.value)) {
            return res.status(400).json({
              ok: false,
              error: { code: 'VALIDATION_ERROR', message: `Invalid select option for ${change.fieldId}: ${change.value}` },
            })
          }
        }

        if (field.type === 'link' && typeof change.value !== 'string') {
          return res.status(400).json({
            ok: false,
            error: { code: 'VALIDATION_ERROR', message: `Link value must be string: ${change.fieldId}` },
          })
        }
      }
    }

    const updates: Array<{ recordId: string; version: number }> = []
    for (const [recordId, changes] of changesByRecord.entries()) {
      const record = recordById.get(recordId)
      if (!record) continue

      let applied = 0
      for (const change of changes) {
        const field = fieldById.get(change.fieldId)
        if (!field) continue

        // Never persist computed formula results from grid; only allow storing the formula string itself.
        if (field.type === 'formula') {
          if (typeof change.value !== 'string') continue
          if (change.value !== '' && !change.value.startsWith('=')) continue
        }

        record.data[change.fieldId] = change.value
        applied += 1
      }

      if (applied > 0) {
        record.version += 1
        updates.push({ recordId, version: record.version })
      }
    }

    return res.json({ ok: true, data: { updated: updates } })
  })

  return router
}
