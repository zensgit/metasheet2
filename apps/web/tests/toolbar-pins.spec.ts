import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  moveToolbarPin,
  pinToolbarCommand,
  readToolbarPins,
  reorderToolbarPins,
  resetToolbarPins,
  sanitizeToolbarPins,
  TOOLBAR_PIN_CAP,
  TOOLBAR_PINS_STORAGE_KEY,
  toolbarPinScope,
  unpinToolbarCommand,
  writeToolbarPins,
} from '../src/multitable/utils/toolbar-pins'

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  localStorage.clear()
})

describe('toolbar pin preferences', () => {
  it('defaults to an empty pin list and anonymous::_ scope', () => {
    expect(toolbarPinScope(null, null)).toBe('anonymous::_')
    expect(readToolbarPins(toolbarPinScope('user-1', 'sheet-9'))).toEqual([])
  })

  it('sanitizes unknown ids, duplicates, and caps at 8', () => {
    expect(sanitizeToolbarPins(['fit', 'fit', 'bell', 'print', 1, 'history'])).toEqual(['fit', 'print', 'history'])
    const overflow = ['fit', 'print', 'import', 'export-csv', 'export-xlsx', 'history', 'trash', 'api', 'dashboard']
    expect(sanitizeToolbarPins(overflow)).toHaveLength(TOOLBAR_PIN_CAP)
    expect(sanitizeToolbarPins(overflow)).not.toContain('dashboard')
  })

  it('pins, unpins, reorders, and persists per user+sheet', () => {
    const scope = toolbarPinScope('user-1', 'sheet-9')
    expect(pinToolbarCommand([], 'fit')).toEqual(['fit'])
    expect(pinToolbarCommand(['fit'], 'print')).toEqual(['fit', 'print'])
    expect(unpinToolbarCommand(['fit', 'print'], 'fit')).toEqual(['print'])
    expect(moveToolbarPin(['fit', 'print', 'history'], 'history', -1)).toEqual(['fit', 'history', 'print'])
    expect(reorderToolbarPins(['fit', 'print', 'history'], 'history', 'fit')).toEqual(['history', 'fit', 'print'])

    writeToolbarPins(scope, ['print', 'history'])
    const raw = JSON.parse(localStorage.getItem(TOOLBAR_PINS_STORAGE_KEY) ?? '{}') as Record<string, string[]>
    expect(raw[scope]).toEqual(['print', 'history'])
    expect(readToolbarPins(scope)).toEqual(['print', 'history'])
    expect(readToolbarPins(toolbarPinScope('user-1', 'other'))).toEqual([])
    expect(resetToolbarPins(scope)).toEqual([])
    expect(readToolbarPins(scope)).toEqual([])
  })

  it('refuses to pin past the cap', () => {
    const full = ['fit', 'print', 'import', 'export-csv', 'export-xlsx', 'history', 'trash', 'api']
    expect(pinToolbarCommand(full, 'dashboard')).toEqual(full)
  })
})
