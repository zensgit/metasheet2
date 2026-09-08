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
    expect(tokens).toMatch(/\.mt-workbench,\s*\n\.meta-toolbar,\s*\n\.meta-grid,\s*\n\.app-sheet-chrome,\s*\n\.meta-record-drawer,\s*\n\.mt-popover,\s*\n\.mt-workbench__rail,\s*\n\.meta-view-rail,\s*\n\.meta-base-picker/)
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
    expect(grid).not.toMatch(/&#x1F4CB;|&#x1F50D;/)
    expect(grid).toMatch(/\.meta-grid__empty-title \{ font-size:\s*var\(--ms-sheet-font-body,\s*13px\)/)
    expect(grid).toMatch(/\.meta-grid__cell \{[^}]*white-space:\s*nowrap/)
    expect(grid).toMatch(/\.meta-grid__row-num \{[\s\S]*padding:\s*8px 4px/)
    expect(grid).toMatch(/const ROW_NUM_W = 56/)
    expect(grid).toMatch(/\.meta-grid__expand-btn \{[\s\S]*flex:\s*0 0 12px/)
    expect(grid).toMatch(/\.meta-grid__row-num-lock-slot \{[\s\S]*flex:\s*0 0 12px/)
    expect(grid).toMatch(/class="meta-grid__row-num-lock-slot"/)
    expect(grid).not.toMatch(/\.meta-grid__expand-btn--open \{[^}]*#409eff/)
    expect(grid).not.toMatch(/\.meta-grid__row-num \{[^}]*(#d97706|#f59e0b|#eab308|#facc15|#ffd700)/)
    const renderer = read('src/multitable/components/cells/MetaCellRenderer.vue')
    expect(renderer).toMatch(/\.meta-cell-renderer \{[\s\S]*white-space:\s*nowrap/)
    expect(renderer).toMatch(/\.meta-cell-renderer__long-text \{[\s\S]*white-space:\s*nowrap/)
    expect(renderer).not.toMatch(/white-space:\s*pre-wrap/)
    const header = read('src/multitable/components/MetaFieldHeader.vue')
    expect(header).toMatch(/font-size:\s*var\(--ms-sheet-font-header,\s*12px\)/)
    expect(header).toMatch(/--ms-sheet-hairline,\s*#ebebeb/)
    expect(header).toMatch(/background:\s*var\(--ms-bg-card,\s*#fff\)/)
  })

  it('keeps the 40px MetaSheet title strip quieter without cloning a second product nav', () => {
    const app = read('src/App.vue')
    expect(app).toMatch(/\.app-sheet-chrome[\s\S]*height:\s*40px/)
    expect(app).toMatch(/\.app-sheet-chrome \.brand-text[\s\S]*font-size:\s*13px/)
    expect(app).toMatch(/\.app-sheet-chrome \.brand-text[\s\S]*font-weight:\s*400/)
    expect(app).toMatch(/\.sheet-chrome__back \{[\s\S]*background:\s*transparent/)
    expect(app).toMatch(/\.sheet-chrome__back \{[\s\S]*border:\s*none/)
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

  it('uses local outline sheet-chrome icons instead of Element Plus filled SVGs', () => {
    const icons = read('src/multitable/ui/sheet-chrome-icons.ts')
    expect(icons).toMatch(/stroke:\s*'currentColor'/)
    expect(icons).toMatch(/stroke-width/)
    expect(icons).not.toMatch(/@element-plus\/icons-vue|lucide/)
    for (const rel of [
      'src/multitable/components/MetaToolbar.vue',
      'src/multitable/components/MetaSheetViewRail.vue',
      'src/multitable/components/MetaNotificationBell.vue',
      'src/multitable/components/MetaCommentAffordance.vue',
      'src/multitable/views/MultitableWorkbench.vue',
    ]) {
      expect(read(rel), rel).not.toMatch(/@element-plus\/icons-vue/)
      expect(read(rel), rel).toMatch(/sheet-chrome-icons/)
    }
  })

  it('quiets the left rail to sheet tokens (13px labels, hairline, ghost collapse, wash not blue block)', () => {
    const workbench = read('src/multitable/views/MultitableWorkbench.vue')
    expect(workbench).toMatch(/\.mt-workbench__rail \{[\s\S]*--ms-sheet-hairline,\s*#ebebeb/)
    expect(workbench).toMatch(/\.mt-workbench__rail-toggle \{[\s\S]*background:\s*transparent/)
    expect(workbench).toMatch(/\.mt-workbench__rail-toggle \{[\s\S]*border:\s*none/)
    expect(workbench).toMatch(/\.mt-workbench__rail-toggle \{[\s\S]*--ms-sheet-font-body,\s*13px/)
    expect(workbench).toMatch(/\.mt-workbench__base-bar \{[^}]*--ms-sheet-hairline,\s*#ebebeb/)
    const rail = read('src/multitable/components/MetaSheetViewRail.vue')
    expect(rail).toMatch(/\.meta-view-rail__sheet \{[\s\S]*--ms-sheet-font-body,\s*13px/)
    expect(rail).toMatch(/\.meta-view-rail__view \{[\s\S]*--ms-sheet-font-header,\s*12px/)
    expect(rail).toMatch(/\.meta-view-rail__sheet\.--active \{[^}]*--el-color-primary-light-9/)
    expect(rail).not.toMatch(/\.meta-view-rail__sheet\.--active \{[^}]*--ms-color-primary; font-weight:\s*500/)
    expect(rail).not.toMatch(/--el-color-primary-light-8/)
    expect(rail).toMatch(/border-top:\s*1px solid var\(--ms-sheet-hairline\)/)
    const picker = read('src/multitable/components/MetaBasePicker.vue')
    expect(picker).toMatch(/\.meta-base-picker__name \{[^}]*--ms-sheet-font-body,\s*13px/)
    expect(picker).toMatch(/\.meta-base-picker__name \{[^}]*font-weight:\s*400/)
    expect(picker).toMatch(/\.meta-base-picker__item--active \{[^}]*--el-color-primary-light-9/)
    expect(picker).not.toMatch(/#ecf5ff|#2563eb|#1d4ed8/)
  })
})
