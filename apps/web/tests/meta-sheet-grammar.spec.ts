import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Token / class contracts for the spreadsheet grammar pass (密度+字号+图标).
// Source-locked so we do not silently drift back to Element Plus 14/16 admin chrome.

const root = (...parts: string[]) => join(__dirname, '..', ...parts)

function read(rel: string): string {
  return readFileSync(root(rel), 'utf-8')
}

describe('sheet workbench grammar tokens', () => {
  it('declares scoped sheet tokens (body 13 / header 12 / icon 16 / toolbar 38 / row 36 / hairline)', () => {
    const tokens = read('src/styles/tokens.css')
    expect(tokens).toMatch(/\.mt-workbench,\s*\n\.meta-toolbar,\s*\n\.meta-grid,\s*\n\.app-sheet-chrome,\s*\n\.meta-record-drawer,\s*\n\.mt-popover/)
    expect(tokens).toMatch(/--ms-sheet-font-body:\s*13px/)
    expect(tokens).toMatch(/--ms-sheet-font-header:\s*12px/)
    expect(tokens).toMatch(/--ms-sheet-icon-size:\s*16px/)
    expect(tokens).toMatch(/--ms-sheet-toolbar-height:\s*38px/)
    expect(tokens).toMatch(/--ms-sheet-row-height:\s*36px/)
    expect(tokens).toMatch(/--ms-sheet-hairline:\s*#ebebeb/)
    expect(tokens).not.toMatch(/#6940c2|#7c3aed|#6366f1.*airtable/i)
  })

  it('keeps grid body at 13px with tabular nums, white header, hairline, no card shadow, quiet selection', () => {
    const grid = read('src/multitable/components/MetaGridTable.vue')
    expect(grid).toMatch(/font-size:\s*var\(--ms-sheet-font-body,\s*13px\)/)
    expect(grid).toMatch(/font-variant-numeric:\s*tabular-nums/)
    expect(grid).toMatch(/box-shadow:\s*none/)
    expect(grid).toMatch(/contain-intrinsic-size:\s*auto 36px/)
    expect(grid).toMatch(/outline:\s*1px solid var\(--ms-color-primary\)/)
    expect(grid).not.toMatch(/outline:\s*2px solid #409eff/)
    const header = read('src/multitable/components/MetaFieldHeader.vue')
    expect(header).toMatch(/font-size:\s*var\(--ms-sheet-font-header,\s*12px\)/)
    expect(header).toMatch(/--ms-sheet-hairline,\s*#ebebeb/)
    expect(header).toMatch(/background:\s*var\(--ms-bg-card,\s*#fff\)/)
  })

  it('keeps the 40px MetaSheet title strip quieter without cloning a second product nav', () => {
    const app = read('src/App.vue')
    expect(app).toMatch(/\.app-sheet-chrome[\s\S]*height:\s*40px/)
    expect(app).toMatch(/\.app-sheet-chrome \.brand-text[\s\S]*font-size:\s*14px/)
    expect(app).toMatch(/data-testid="sheet-chrome-back"/)
    expect(app).toMatch(/brand-text/)
    expect(app).not.toMatch(/Airtable|airtable/)
  })

  it('quiets the inspector drawer to sheet tokens (360px, 40px header, hairline, ghost close)', () => {
    const drawer = read('src/multitable/components/MetaRecordInspector.vue')
    expect(drawer).toMatch(/\.meta-record-drawer \{[\s\S]*width:\s*360px/)
    expect(drawer).toMatch(/height:\s*40px/)
    expect(drawer).toMatch(/--ms-sheet-hairline,\s*#ebebeb/)
    expect(drawer).toMatch(/--ms-sheet-font-body,\s*13px/)
    expect(drawer).toMatch(/\.meta-record-drawer__close[\s\S]*background:\s*transparent/)
    expect(drawer).not.toMatch(/\.meta-record-drawer__tab--active \{[^}]*background:\s*#111827/)
    expect(drawer).not.toMatch(/Airtable|airtable|#6940c2/)
    const fields = read('src/multitable/components/MetaRecordFieldsPanel.vue')
    expect(fields).toMatch(/--ms-sheet-font-header,\s*12px/)
  })

  it('quiets toolbar popovers: no 420px filter floor, hairline MtPopover, no pop shadow', () => {
    const toolbar = read('src/multitable/components/MetaToolbar.vue')
    expect(toolbar).toMatch(/\.meta-toolbar__panel--filter \{ min-width: 280px; \}/)
    expect(toolbar).not.toMatch(/min-width:\s*420px/)
    const popover = read('src/multitable/ui/MtPopover.vue')
    expect(popover).toMatch(/--ms-sheet-hairline,\s*#ebebeb/)
    expect(popover).toMatch(/box-shadow:\s*none/)
    expect(popover).toMatch(/--ms-sheet-font-body,\s*13px/)
    const group = read('src/multitable/components/MetaFilterGroup.vue')
    expect(group).toMatch(/--ms-sheet-hairline,\s*#ebebeb/)
    expect(group).not.toMatch(/background:\s*#fafafa/)
  })
})
