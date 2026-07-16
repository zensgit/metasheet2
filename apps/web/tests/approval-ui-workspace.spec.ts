import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

function read(relativePath: string): string {
  return readFileSync(join(__dirname, '..', relativePath), 'utf8')
}

describe('approval workspace visual structure', () => {
  it('keeps the application shell on the complete light token theme', () => {
    const source = read('src/App.vue')

    expect(source).toContain('background-color: var(--ms-bg-page)')
    expect(source).not.toContain('@media (prefers-color-scheme: dark)')
  })

  it('separates the approval header, primary filters, and advanced filters', () => {
    const source = read('src/views/approval/ApprovalCenterView.vue')

    expect(source).toContain('<PageShell width="wide">')
    expect(source).toContain('class="approval-center__filters-primary"')
    expect(source).toContain('class="approval-center__filters-advanced"')
    expect(source).toContain('data-testid="approval-more-filters"')
    expect(source).toContain('data-testid="approval-clear-filters"')
  })

  it('keeps the detail form and timeline as full card surfaces', () => {
    const source = read('src/views/approval/ApprovalDetailView.vue')

    expect(source).toMatch(/\.approval-detail__form,\s*\n\.approval-detail__timeline\s*\{/)
    expect(source).toContain('box-shadow: var(--ms-shadow-card)')
  })

  it('presents template authoring as a four-step workspace', () => {
    const source = read('src/views/approval/TemplateAuthoringView.vue')

    expect(source).toContain("type AuthoringSectionId = 'basic' | 'fields' | 'flow' | 'review'")
    expect(source).toContain('class="template-authoring__workspace"')
    expect(source).toContain('data-testid="approval-template-section-next"')
    expect(source).toContain("v-show=\"activeAuthoringSection === 'fields'\"")
    expect(source).toContain("v-show=\"activeAuthoringSection === 'flow'\"")
    expect(source).toContain("v-show=\"activeAuthoringSection === 'review'\"")
  })
})
