import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, test } from 'vitest'

const source = readFileSync(join(__dirname, '../../src/routes/univer-meta.ts'), 'utf8')

const occurrences = (needle: string): number => source.split(needle).length - 1

describe('multitable destructive recovery route authority', () => {
  test('registers each recovery route exactly once through the exact-anchor handlers', () => {
    expect(occurrences("router.post('/sheets/:sheetId/revert-preview'")).toBe(1)
    expect(occurrences("router.post('/sheets/:sheetId/revert-execute'")).toBe(1)
    expect(occurrences("router.post('/sheets/:sheetId/reset-preview'")).toBe(1)
    expect(occurrences("router.post('/sheets/:sheetId/reset-execute'")).toBe(1)

    expect(source).toContain(
      "router.post('/sheets/:sheetId/revert-preview', (req: Request, res: Response) => handleExactAnchorPreview(req, res, 'revert'))",
    )
    expect(source).toContain(
      "router.post('/sheets/:sheetId/revert-execute', (req: Request, res: Response) => handleExactAnchorExecute(req, res, 'revert'))",
    )
    expect(source).toContain(
      "router.post('/sheets/:sheetId/reset-preview', (req: Request, res: Response) => handleExactAnchorPreview(req, res, 'reset'))",
    )
    expect(source).toContain(
      "router.post('/sheets/:sheetId/reset-execute', (req: Request, res: Response) => handleExactAnchorExecute(req, res, 'reset'))",
    )
  })

  test('does not retain a second wall-clock recovery planner beside exact-anchor authority', () => {
    expect(source).not.toContain('const computeSheetRevert')
    expect(source).not.toContain('const computeSheetReset')
    expect(source).not.toContain('const sendPitResetBlocked')
    expect(source).not.toContain('const sendHistoryIncomplete')
  })
})
