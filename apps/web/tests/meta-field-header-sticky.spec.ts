import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const WEB_ROOT = join(__dirname, '../src')

describe('MetaFieldHeader sticky contract', () => {
  it('keeps position:sticky top:0 without a later relative override', () => {
    const source = readFileSync(join(WEB_ROOT, 'multitable/components/MetaFieldHeader.vue'), 'utf-8')
    expect(source).toMatch(/position:\s*sticky;\s*top:\s*0/)
    expect(source).not.toMatch(/position:\s*sticky;\s*top:\s*0;[^;]*z-index:[^;]+;\s*position:\s*relative/)
    const styleBlock = source.slice(source.lastIndexOf('<style'))
    expect(styleBlock).not.toMatch(/position:\s*relative/)
    expect(styleBlock).toMatch(/z-index:\s*3/)
  })

  it('places header z-index above frozen body cells (2)', () => {
    const header = readFileSync(join(WEB_ROOT, 'multitable/components/MetaFieldHeader.vue'), 'utf-8')
    const grid = readFileSync(join(WEB_ROOT, 'multitable/components/MetaGridTable.vue'), 'utf-8')
    expect(header).toMatch(/style\.zIndex = '4'/)
    expect(grid).toMatch(/zIndex: '2'/)
    expect(grid).toMatch(/thead \.meta-grid__row-num[\s\S]*z-index:\s*5/)
  })
})
