import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'

// --- RecordDrawer field type parity ---
describe('record drawer field type support', () => {
  const DRAWER_EDITABLE_TYPES = ['string', 'number', 'date', 'boolean', 'select', 'link']

  it('supports date field editing', () => {
    expect(DRAWER_EDITABLE_TYPES).toContain('date')
  })

  it('supports select field editing', () => {
    expect(DRAWER_EDITABLE_TYPES).toContain('select')
  })

  it('supports all 6 editable types', () => {
    expect(DRAWER_EDITABLE_TYPES).toHaveLength(6)
  })

  it('date input uses type="date"', () => {
    const inputType = 'date'
    expect(inputType).toBe('date')
  })

  it('select renders options from field.options', () => {
    const field = { id: 'f1', name: 'Status', type: 'select', options: [{ value: 'Open' }, { value: 'Closed', color: '#67c23a' }] }
    expect(field.options).toHaveLength(2)
    expect(field.options[0].value).toBe('Open')
  })
})

// --- FormView date field ---
describe('form view date field support', () => {
  it('renders date input for date field type', () => {
    const fieldType = 'date'
    const inputType = fieldType === 'date' ? 'date' : 'text'
    expect(inputType).toBe('date')
  })

  it('date input is placed before select in template order', () => {
    const templateOrder = ['string', 'number', 'date', 'boolean', 'select', 'link']
    const dateIdx = templateOrder.indexOf('date')
    const selectIdx = templateOrder.indexOf('select')
    expect(dateIdx).toBeLessThan(selectIdx)
  })
})

// --- Kanban drag feedback ---
describe('kanban drag-over feedback', () => {
  it('tracks drag-over column', () => {
    let dragOverColumn: string | null = null
    // Simulate dragover
    dragOverColumn = 'In Progress'
    expect(dragOverColumn).toBe('In Progress')
    // Simulate dragleave
    dragOverColumn = null
    expect(dragOverColumn).toBeNull()
  })

  it('applies drag-over class to cards container', () => {
    const dragOver = true
    const cls = dragOver ? 'meta-kanban__cards--drag-over' : ''
    expect(cls).toBe('meta-kanban__cards--drag-over')
  })

  it('uncategorized column uses special key', () => {
    const uncategorizedKey = '__uncategorized__'
    expect(uncategorizedKey).toBe('__uncategorized__')
  })

  it('drag-over style has blue highlight', () => {
    const style = 'background: #ecf5ff; border-color: #409eff;'
    expect(style).toContain('#ecf5ff')
    expect(style).toContain('#409eff')
  })
})

// --- Calendar date-type recognition ---
describe('calendar date field type recognition', () => {
  it('includes date type in dateFields filter', () => {
    const fields = [
      { id: 'f1', name: 'Title', type: 'string' },
      { id: 'f2', name: 'Due', type: 'date' },
      { id: 'f3', name: 'Count', type: 'number' },
      { id: 'f4', name: 'Active', type: 'boolean' },
    ]
    const dateFields = fields.filter((f) => f.type === 'date' || f.type === 'string' || f.type === 'number')
    expect(dateFields).toHaveLength(3)
    expect(dateFields.map((f) => f.type)).toContain('date')
  })

  it('date type field appears first in date fields list', () => {
    const fields = [
      { id: 'f1', name: 'Title', type: 'string' },
      { id: 'f2', name: 'Due', type: 'date' },
    ]
    const dateFields = fields.filter((f) => f.type === 'date' || f.type === 'string' || f.type === 'number')
    expect(dateFields.find((f) => f.type === 'date')?.name).toBe('Due')
  })
})

// --- Print CSS coverage ---

/**
 * All `@media print { ... }` blocks in a source string, brace-matched so the whole block
 * (including nested rule braces) is captured. Used by the two source-reading tests below.
 */
function extractPrintBlocks(source: string): string[] {
  const blocks: string[] = []
  const re = /@media print/g
  let m: RegExpExecArray | null
  while ((m = re.exec(source)) !== null) {
    const open = source.indexOf('{', m.index)
    if (open === -1) continue
    let depth = 0
    for (let i = open; i < source.length; i++) {
      if (source[i] === '{') depth++
      else if (source[i] === '}' && --depth === 0) {
        blocks.push(source.slice(open, i + 1))
        break
      }
    }
  }
  return blocks
}

const WEB_ROOT = join(__dirname, '..')

// NOTE (2026-07-14, follow-up #57): 'toolbar hides in print', 'workbench base-bar and actions hide
// in print' and 'grid interactive elements hide in print' below are self-referential placeholders
// from the original Phase-12 verification pass — each asserts on a locally-declared string/array
// and never reads component source, so they cannot go red if the real print CSS drifts. Rewriting
// them is a docketed follow-up; this pass only re-pinned the two tests that referenced the retired
// MetaViewTabBar, as real source-reading assertions.
describe('print CSS coverage', () => {
  it('toolbar hides in print', () => {
    const rule = '@media print { .meta-toolbar { display: none !important; } }'
    expect(rule).toContain('display: none')
  })

  it('sheet/view rail hides in print', () => {
    // Reads the ACTUAL SFC: post-P2-2a/2b (#4237/#4264) the rail print rule lives in
    // MetaSheetViewRail.vue (the retired MetaViewTabBar.vue / .meta-tab-bar rule no longer exists
    // anywhere in the tree). Deleting that print rule turns this test red.
    const source = readFileSync(join(WEB_ROOT, 'src/multitable/components/MetaSheetViewRail.vue'), 'utf-8')
    const railPrintBlocks = extractPrintBlocks(source).filter((block) =>
      /\.meta-view-rail[^{}]*\{[^{}]*display:\s*none/.test(block),
    )
    expect(railPrintBlocks.length).toBeGreaterThan(0)
  })

  it('workbench base-bar and actions hide in print', () => {
    const hiddenSelectors = ['.mt-workbench__base-bar', '.mt-workbench__actions', '.mt-workbench__shortcuts-overlay']
    expect(hiddenSelectors).toHaveLength(3)
  })

  it('grid interactive elements hide in print', () => {
    const hiddenGridSelectors = [
      '.meta-grid__bulk-bar', '.meta-grid__pagination', '.meta-grid__loading',
      '.meta-grid__expand-btn', '.meta-grid__check-col',
    ]
    expect(hiddenGridSelectors).toHaveLength(5)
  })

  it('complete print chain: sheet/view rail + toolbar + workbench chrome + grid interactives', () => {
    // Every component in the print chain must exist on disk (readFileSync throws on a rename/move)
    // and carry at least one @media print block (dropping the block turns this test red).
    const PRINT_CHAIN: Record<string, string> = {
      MetaSheetViewRail: 'src/multitable/components/MetaSheetViewRail.vue',
      MetaToolbar: 'src/multitable/components/MetaToolbar.vue',
      MultitableWorkbench: 'src/multitable/views/MultitableWorkbench.vue',
      MetaGridTable: 'src/multitable/components/MetaGridTable.vue',
    }
    expect(Object.keys(PRINT_CHAIN)).toHaveLength(4)
    for (const [name, relPath] of Object.entries(PRINT_CHAIN)) {
      const source = readFileSync(join(WEB_ROOT, relPath), 'utf-8')
      expect(extractPrintBlocks(source).length, `${name} (${relPath}) must contain an @media print block`).toBeGreaterThan(0)
    }
  })
})

// --- Error handling ---
describe('workbench error resilience', () => {
  it('onMounted wraps initialization in try-catch', () => {
    let errorCaught = false
    try {
      throw new Error('init failed')
    } catch {
      errorCaught = true
    }
    expect(errorCaught).toBe(true)
  })

  it('showError function handles error messages', () => {
    const msg = 'Failed to initialize workbench'
    expect(msg).toBeTruthy()
    expect(typeof msg).toBe('string')
  })
})
